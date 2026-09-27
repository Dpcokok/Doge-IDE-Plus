package com.doge.ide;

/** Native WASI runner. The compiler and resource package are wired in later. */
final class NativeWasmRunner {
    private NativeWasmRunner() {}

    static {
        System.loadLibrary("iwasm");
        System.loadLibrary("doge_wasm_jni");
    }

    static synchronized native String run(byte[] wasm, byte[] stdin, int timeoutMs);
    static native void cancel();
}
