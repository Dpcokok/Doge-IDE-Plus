#include <jni.h>
#include <pthread.h>
#include <stdint.h>
#include <errno.h>
#include <signal.h>
#include <stdatomic.h>
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
    bool truncated;
} Reader;

typedef struct {
    int fd;
    const uint8_t *data;
    size_t size;
} InputWriter;

typedef struct {
    wasm_module_inst_t instance;
    int timeout_ms;
    unsigned run_id;
} Watchdog;

static pthread_once_t runtime_once = PTHREAD_ONCE_INIT;
static pthread_mutex_t active_lock = PTHREAD_MUTEX_INITIALIZER;
static wasm_module_inst_t active_instance;
static unsigned active_run_id;
static bool active_done = true;
static atomic_uint run_sequence;
static atomic_uint cancel_upto;
static atomic_uint timeout_run;
static void init_runtime(void) { signal(SIGPIPE, SIG_IGN); wasm_runtime_init(); }

static bool run_was_canceled(unsigned id) {
    unsigned canceled = atomic_load_explicit(&cancel_upto, memory_order_acquire);
    return id != 0 && (int)(canceled - id) >= 0;
}

static void *read_pipe(void *arg) {
    Reader *r = (Reader *)arg;
    char buf[4096];
    ssize_t n;
    while ((n = read(r->fd, buf, sizeof(buf))) > 0) {
        const size_t max_stream = 1024 * 1024;
        size_t keep = (size_t)n;
        if (r->size >= max_stream) { r->truncated = true; continue; }
        if (r->size + keep > max_stream) { keep = max_stream - r->size; r->truncated = true; }
        if (r->size + keep + 1 > r->capacity) {
            size_t next = r->capacity ? r->capacity * 2 : 8192;
            while (next < r->size + keep + 1) next *= 2;
            char *grown = (char *)realloc(r->data, next);
            if (!grown) break;
            r->data = grown;
            r->capacity = next;
        }
        memcpy(r->data + r->size, buf, keep);
        r->size += keep;
    }
    if (r->data) r->data[r->size] = 0;
    close(r->fd);
    return NULL;
}

static void *write_pipe(void *arg) {
    InputWriter *writer = (InputWriter *)arg;
    size_t offset = 0;
    while (offset < writer->size) {
        ssize_t n = write(writer->fd, writer->data + offset, writer->size - offset);
        if (n > 0) { offset += (size_t)n; continue; }
        if (n < 0 && errno == EINTR) continue;
        break;
    }
    close(writer->fd);
    return NULL;
}

static void *watchdog_thread(void *arg) {
    Watchdog *watchdog = (Watchdog *)arg;
    int remaining = watchdog->timeout_ms;
    while (remaining > 0) {
        pthread_mutex_lock(&active_lock);
        bool done = active_done || active_instance == NULL || active_run_id != watchdog->run_id;
        pthread_mutex_unlock(&active_lock);
        if (done || run_was_canceled(watchdog->run_id)) return NULL;
        usleep(10000);
        remaining -= 10;
    }
    pthread_mutex_lock(&active_lock);
    if (!active_done && active_instance != NULL && active_run_id == watchdog->run_id && !run_was_canceled(watchdog->run_id)) {
        atomic_store_explicit(&timeout_run, watchdog->run_id, memory_order_release);
        wasm_runtime_terminate(active_instance);
    }
    pthread_mutex_unlock(&active_lock);
    return NULL;
}

static char *json_escape(const char *s, size_t n) {
    size_t cap = n * 6 + 3, out = 0;
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

static jstring make_result(JNIEnv *env, const char *status, const char *out, const char *err,
                           uint32_t exit_code, const char *message, bool out_truncated, bool err_truncated) {
    char *escaped_out = json_escape(out ? out : "", out ? strlen(out) : 0);
    char *escaped_err = json_escape(err ? err : "", err ? strlen(err) : 0);
    char *escaped_message = message ? json_escape(message, strlen(message)) : NULL;
    size_t size = 256 + (escaped_out ? strlen(escaped_out) : 2) + (escaped_err ? strlen(escaped_err) : 2) + (escaped_message ? strlen(escaped_message) : 0);
    char *result = (char *)malloc(size);
    if (!result) {
        free(escaped_out); free(escaped_err); free(escaped_message);
        return (*env)->NewStringUTF(env, "{\"status\":\"runtime_error\",\"message\":\"out of memory\"}");
    }
    snprintf(result, size,
             "{\"status\":\"%s\",\"stdout\":%s,\"stderr\":%s,\"exit_code\":%u,\"stdout_truncated\":%s,\"stderr_truncated\":%s%s%s}",
             status, escaped_out ? escaped_out : "\"\"", escaped_err ? escaped_err : "\"\"", exit_code,
             out_truncated ? "true" : "false", err_truncated ? "true" : "false",
             escaped_message ? ",\"message\":" : "", escaped_message ? escaped_message : "");
    jstring value = (*env)->NewStringUTF(env, result);
    free(result); free(escaped_out); free(escaped_err); free(escaped_message);
    return value;
}

JNIEXPORT jstring JNICALL
Java_com_doge_ide_NativeWasmRunner_run(JNIEnv *env, jclass unused,
                                        jbyteArray wasm_bytes, jbyteArray stdin_bytes,
                                        jint timeout_ms) {
    (void)unused;
    pthread_once(&runtime_once, init_runtime);
    unsigned run_id = atomic_fetch_add_explicit(&run_sequence, 1, memory_order_relaxed) + 1;
    jsize wasm_size = (*env)->GetArrayLength(env, wasm_bytes);
    uint8_t *wasm_buf = (uint8_t *)malloc((size_t)wasm_size);
    if (!wasm_buf) return (*env)->NewStringUTF(env, "{\"status\":\"runtime_error\",\"message\":\"out of memory\"}");
    (*env)->GetByteArrayRegion(env, wasm_bytes, 0, wasm_size, (jbyte *)wasm_buf);

    char error[1024] = {0};
    wasm_module_t module = wasm_runtime_load(wasm_buf, (uint32_t)wasm_size, error, sizeof(error));
    if (!module) {
        jstring result = make_result(env, "runtime_error", "", "", 0, error[0] ? error : "load failed", false, false);
        free(wasm_buf); return result;
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
        jstring result = make_result(env, "runtime_error", "", "", 0, error[0] ? error : "instantiate failed", false, false);
        return result;
    }

    pthread_mutex_lock(&active_lock);
    if (active_instance != NULL) {
        pthread_mutex_unlock(&active_lock);
        wasm_runtime_deinstantiate(instance); wasm_runtime_unload(module); free(wasm_buf);
        return make_result(env, "runtime_error", "", "", 0, "runner busy", false, false);
    }
    active_instance = instance; active_run_id = run_id; active_done = false;
    pthread_mutex_unlock(&active_lock);

    Reader stdout_reader = {out_pipe[0], NULL, 0, 0, false}, stderr_reader = {err_pipe[0], NULL, 0, 0, false};
    pthread_t stdout_thread, stderr_thread;
    pthread_create(&stdout_thread, NULL, read_pipe, &stdout_reader);
    pthread_create(&stderr_thread, NULL, read_pipe, &stderr_reader);
    Watchdog watchdog = {instance, timeout_ms > 0 ? timeout_ms : 30000, run_id};
    pthread_t watchdog_thread_id;
    pthread_create(&watchdog_thread_id, NULL, watchdog_thread, &watchdog);
    jsize stdin_size = stdin_bytes ? (*env)->GetArrayLength(env, stdin_bytes) : 0;
    uint8_t *input = NULL;
    pthread_t input_thread;
    bool input_thread_started = false;
    if (stdin_size > 0) {
        input = (uint8_t *)malloc((size_t)stdin_size);
        if (input) (*env)->GetByteArrayRegion(env, stdin_bytes, 0, stdin_size, (jbyte *)input);
    }
    InputWriter writer = {in_pipe[1], input, input ? (size_t)stdin_size : 0};
    if (pthread_create(&input_thread, NULL, write_pipe, &writer) == 0) input_thread_started = true;
    else close(in_pipe[1]);
    bool ok = wasm_application_execute_main(instance, 1, (char **)argv);
    close(in_pipe[0]);
    if (input_thread_started) pthread_join(input_thread, NULL);
    free(input);
    pthread_mutex_lock(&active_lock);
    active_done = true;
    active_instance = NULL;
    pthread_mutex_unlock(&active_lock);
    pthread_join(watchdog_thread_id, NULL);
    close(out_pipe[1]); close(err_pipe[1]);
    pthread_join(stdout_thread, NULL); pthread_join(stderr_thread, NULL);
    uint32_t exit_code = wasm_runtime_get_wasi_exit_code(instance);
    const char *exception = wasm_runtime_get_exception(instance);
    bool canceled = run_was_canceled(run_id);
    bool timed_out = atomic_load_explicit(&timeout_run, memory_order_acquire) == run_id;
    const char *status = ok ? "success" : (canceled ? "canceled" : (timed_out ? "timeout" : "runtime_error"));
    jstring result = make_result(env, status, stdout_reader.data, stderr_reader.data, exit_code, exception, stdout_reader.truncated, stderr_reader.truncated);
    free(stdout_reader.data); free(stderr_reader.data);
    wasm_runtime_deinstantiate(instance); wasm_runtime_unload(module); free(wasm_buf);
    return result;
}

JNIEXPORT void JNICALL
Java_com_doge_ide_NativeWasmRunner_cancel(JNIEnv *env, jclass unused) {
    (void)env; (void)unused;
    unsigned latest = atomic_load_explicit(&run_sequence, memory_order_acquire);
    atomic_store_explicit(&cancel_upto, latest, memory_order_release);
    pthread_mutex_lock(&active_lock);
    if (active_instance != NULL && !active_done) wasm_runtime_terminate(active_instance);
    pthread_mutex_unlock(&active_lock);
}
