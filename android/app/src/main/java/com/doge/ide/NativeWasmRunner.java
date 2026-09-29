package com.doge.ide;

/** Native WASI runner. The compiler and resource package are wired in later. */
final class NativeWasmRunner {
    private NativeWasmRunner() {}

    private static volatile String loadError;
    static synchronized boolean ensureLoaded() {
        if (loadError != null) return false;
        try {
            System.loadLibrary("iwasm");
            System.loadLibrary("doge_wasm_jni");
            return true;
        } catch (UnsatisfiedLinkError error) {
            loadError = error.getMessage() == null ? error.toString() : error.getMessage();
            return false;
        }
    }

    static String loadError() { return loadError; }

    static synchronized String run(byte[] wasm, byte[] stdin, int timeoutMs) {
        if (!ensureLoaded()) return "{\"status\":\"runtime_error\",\"message\":\"Native runtime unavailable\"}";
        return nativeRun(wasm, stdin, timeoutMs);
    }
    private static synchronized native String nativeRun(byte[] wasm, byte[] stdin, int timeoutMs);
    static native void cancel();
}
