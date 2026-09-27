#include <jni.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "wasm_export.h"

typedef struct {
    int fd;
    char *data;
    size_t size;
    size_t capacity;
} Reader;

typedef struct {
    wasm_module_inst_t instance;
    int timeout_ms;
    volatile bool fired;
    volatile bool canceled;
} Watchdog;

static pthread_once_t runtime_once = PTHREAD_ONCE_INIT;
static void init_runtime(void) { wasm_runtime_init(); }

static void *read_pipe(void *arg) {
    Reader *r = (Reader *)arg;
    char buf[4096];
    ssize_t n;
    while ((n = read(r->fd, buf, sizeof(buf))) > 0) {
        if (r->size + (size_t)n + 1 > r->capacity) {
            size_t next = r->capacity ? r->capacity * 2 : 8192;
            while (next < r->size + (size_t)n + 1) next *= 2;
            char *grown = (char *)realloc(r->data, next);
            if (!grown) break;
            r->data = grown;
            r->capacity = next;
        }
        memcpy(r->data + r->size, buf, (size_t)n);
        r->size += (size_t)n;
    }
    if (r->data) r->data[r->size] = 0;
    close(r->fd);
    return NULL;
}

static void *watchdog_thread(void *arg) {
    Watchdog *watchdog = (Watchdog *)arg;
    int remaining = watchdog->timeout_ms;
    while (remaining > 0 && !watchdog->canceled) {
        usleep(10000);
        remaining -= 10;
    }
    if (watchdog->canceled) return NULL;
    watchdog->fired = true;
    wasm_runtime_terminate(watchdog->instance);
    return NULL;
}

static char *json_escape(const char *s, size_t n) {
    size_t cap = n * 2 + 3, out = 0;
    char *p = (char *)malloc(cap);
    if (!p) return NULL;
    p[out++] = '"';
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        const char *escape = NULL;
        if (c == '"') escape = "\\\"";
        else if (c == '\\') escape = "\\\\";
        else if (c == '\n') escape = "\\n";
        else if (c == '\r') escape = "\\r";
        else if (c == '\t') escape = "\\t";
        if (escape) {
            size_t m = strlen(escape);
            memcpy(p + out, escape, m); out += m;
        } else if (c < 0x20) {
            if (out + 6 >= cap) break;
            out += (size_t)snprintf(p + out, cap - out, "\\u%04x", c);
        } else {
            if (out + 1 >= cap) break;
            p[out++] = (char)c;
        }
    }
    p[out++] = '"'; p[out] = 0;
    return p;
}

JNIEXPORT jstring JNICALL
Java_com_doge_ide_NativeWasmRunner_run(JNIEnv *env, jclass unused,
                                        jbyteArray wasm_bytes, jbyteArray stdin_bytes,
                                        jint timeout_ms) {
    (void)unused;
    pthread_once(&runtime_once, init_runtime);
    jsize wasm_size = (*env)->GetArrayLength(env, wasm_bytes);
    uint8_t *wasm_buf = (uint8_t *)malloc((size_t)wasm_size);
    if (!wasm_buf) return (*env)->NewStringUTF(env, "{\"status\":\"runtime_error\",\"message\":\"out of memory\"}");
    (*env)->GetByteArrayRegion(env, wasm_bytes, 0, wasm_size, (jbyte *)wasm_buf);

    char error[1024] = {0};
    wasm_module_t module = wasm_runtime_load(wasm_buf, (uint32_t)wasm_size, error, sizeof(error));
    if (!module) {
        char *msg = json_escape(error, strlen(error));
        char result[1400]; snprintf(result, sizeof(result), "{\"status\":\"runtime_error\",\"message\":%s}", msg ? msg : "\"load failed\"");
        free(msg); free(wasm_buf); return (*env)->NewStringUTF(env, result);
    }

    int in_pipe[2], out_pipe[2], err_pipe[2];
    if (pipe(in_pipe) || pipe(out_pipe) || pipe(err_pipe)) {
        wasm_runtime_unload(module); free(wasm_buf);
        return (*env)->NewStringUTF(env, "{\"status\":\"runtime_error\",\"message\":\"pipe failed\"}");
    }
    const char *argv[] = {"main", NULL};
    wasm_runtime_set_wasi_args_ex(module, NULL, 0, NULL, 0, NULL, 0,
                                  (char **)argv, 1, in_pipe[0], out_pipe[1], err_pipe[1]);
    wasm_module_inst_t instance = wasm_runtime_instantiate(module, 64 * 1024, 8 * 1024 * 1024,
                                                            error, sizeof(error));
    if (!instance) {
        close(in_pipe[0]); close(in_pipe[1]); close(out_pipe[0]); close(out_pipe[1]); close(err_pipe[0]); close(err_pipe[1]);
        wasm_runtime_unload(module); free(wasm_buf);
        char *msg = json_escape(error, strlen(error)); char result[1400];
        snprintf(result, sizeof(result), "{\"status\":\"runtime_error\",\"message\":%s}", msg ? msg : "\"instantiate failed\"");
        free(msg); return (*env)->NewStringUTF(env, result);
    }

    Reader stdout_reader = {out_pipe[0], NULL, 0, 0}, stderr_reader = {err_pipe[0], NULL, 0, 0};
    pthread_t stdout_thread, stderr_thread;
    pthread_create(&stdout_thread, NULL, read_pipe, &stdout_reader);
    pthread_create(&stderr_thread, NULL, read_pipe, &stderr_reader);
    Watchdog watchdog = {instance, timeout_ms > 0 ? timeout_ms : 30000, false, false};
    pthread_t watchdog_thread_id;
    pthread_create(&watchdog_thread_id, NULL, watchdog_thread, &watchdog);
    jsize stdin_size = stdin_bytes ? (*env)->GetArrayLength(env, stdin_bytes) : 0;
    if (stdin_size) {
        jbyte *input = (*env)->GetByteArrayElements(env, stdin_bytes, NULL);
        (void)write(in_pipe[1], input, (size_t)stdin_size);
        (*env)->ReleaseByteArrayElements(env, stdin_bytes, input, JNI_ABORT);
    }
    close(in_pipe[1]);
    bool ok = wasm_application_execute_main(instance, 1, (char **)argv);
    if (!watchdog.fired) {
        watchdog.canceled = true;
    }
    pthread_join(watchdog_thread_id, NULL);
    close(out_pipe[1]); close(err_pipe[1]);
    pthread_join(stdout_thread, NULL); pthread_join(stderr_thread, NULL);
    uint32_t exit_code = wasm_runtime_get_wasi_exit_code(instance);
    const char *exception = wasm_runtime_get_exception(instance);
    char *out = json_escape(stdout_reader.data ? stdout_reader.data : "", stdout_reader.size);
    char *err = json_escape(stderr_reader.data ? stderr_reader.data : "", stderr_reader.size);
    char *msg = exception ? json_escape(exception, strlen(exception)) : NULL;
    char result[4096];
    snprintf(result, sizeof(result), "{\"status\":\"%s\",\"stdout\":%s,\"stderr\":%s,\"exit_code\":%u%s%s}",
             watchdog.fired && !ok ? "timeout" : (ok ? "success" : "runtime_error"), out ? out : "\"\"", err ? err : "\"\"", exit_code,
             msg ? ",\"message\":" : "", msg ? msg : "");
    free(out); free(err); free(msg); free(stdout_reader.data); free(stderr_reader.data);
    wasm_runtime_deinstantiate(instance); wasm_runtime_unload(module); free(wasm_buf);
    return (*env)->NewStringUTF(env, result);
}
