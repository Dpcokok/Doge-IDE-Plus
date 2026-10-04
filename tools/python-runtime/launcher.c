// Doge IDE+ Python launcher for Android
// aarch64-linux-android24-clang launcher.c -o doge-python -I<prefix>/include/python3.14 -L<prefix>/lib -lpython3.14 -llog -Wl,-rpath,'$ORIGIN/../prefix/lib'
#include <Python.h>
#include <android/log.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define TAG "doge.python"

int main(int argc, char *argv[]) {
    // Keep the real stdio around: on Android Python replaces sys.stdout/stderr
    // with logcat writers, so we re-open the original descriptors after init.
    int fd_in = dup(STDIN_FILENO);
    int fd_out = dup(STDOUT_FILENO);
    int fd_err = dup(STDERR_FILENO);

    PyStatus status;
    PyConfig config;
    PyConfig_InitIsolatedConfig(&config);
    // Isolated config defaults to parse_argv = 0: -c / script path would be ignored.
    config.parse_argv = 1;

    // PYTHONHOME: environment first, else <exe dir>/../prefix
    const char *home = getenv("PYTHONHOME");
    static char home_buf[512];
    if (!home) {
        ssize_t len = readlink("/proc/self/exe", home_buf, sizeof(home_buf) - 1);
        if (len > 0) {
            home_buf[len] = '\0';
            char *slash = strrchr(home_buf, '/');
            if (slash) {
                *slash = '\0';                       // .../bin
                char *parent = strrchr(home_buf, '/');
                if (parent) { strcpy(parent + 1, "prefix"); home = home_buf; }  // .../prefix
            }
        }
    }
    if (home) {
        status = PyConfig_SetBytesString(&config, &config.home, home);
        if (PyStatus_Exception(status)) { PyConfig_Clear(&config); return 70; }
    }

    status = PyConfig_SetBytesArgv(&config, argc, argv);
    if (PyStatus_Exception(status)) { PyConfig_Clear(&config); return 70; }

    status = Py_InitializeFromConfig(&config);
    PyConfig_Clear(&config);
    if (PyStatus_Exception(status)) return 70;

    // Attach Python's streams to the real descriptors (no logcat, line buffered).
    if (fd_in >= 0 && fd_out >= 0 && fd_err >= 0) {
        char code[1024];
        snprintf(code, sizeof(code),
            "import sys, io\n"
            "sys.stdin = io.TextIOWrapper(io.FileIO(%d, 'rb', closefd=False), encoding='utf-8', errors='surrogateescape', line_buffering=True)\n"
            "sys.stdout = io.TextIOWrapper(io.FileIO(%d, 'wb', closefd=False), encoding='utf-8', errors='backslashreplace', line_buffering=True)\n"
            "sys.stderr = io.TextIOWrapper(io.FileIO(%d, 'wb', closefd=False), encoding='utf-8', errors='backslashreplace', line_buffering=True)\n",
            fd_in, fd_out, fd_err);
        if (PyRun_SimpleString(code) != 0) return 70;
    }

    return Py_RunMain();
}
