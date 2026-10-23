# Third-Party Notices

Doge IDE+ 以 MIT 许可发布（见 [LICENSE](LICENSE)）。本项目在源码树中直接或间接包含以下
第三方组件，它们各自保留原有许可与版权。以下列表按目录组织，供分发时随附。

---

## 1. CodeMirror 5

- **位置**：`web/codemirror/`（`codemirror.min.js`、`codemirror.min.css`、`addon/`、`mode/`）
- **项目**：https://codemirror.net/5/
- **许可**：MIT
- **版权**：Copyright (c) by Marijn Haverbeke and others

---

## 2. xterm.js

- **位置**：`web/terminal/vendor/`（`xterm.js`、`xterm.css`、addon-fit）
- **项目**：https://xtermjs.org/
- **许可**：MIT
- **版权**：Copyright (c) 2014-2024 The xterm.js authors
- **随附文本**：`web/terminal/vendor/LICENSE-xterm`、`web/terminal/vendor/LICENSE-addon-fit`

---

## 3. Maple Mono

- **位置**：`web/fonts/maple-mono-var.woff2`
- **项目**：https://github.com/subframe7536/maple-font
- **许可**：SIL Open Font License 1.1（OFL-1.1）

---

## 4. Geist

- **位置**：`web/fonts/geist/`（4 个 `woff2` 分片）、`web/fonts/geist.css`
- **项目**：https://vercel.com/font
- **许可**：SIL Open Font License 1.1（OFL-1.1）
- **版权**：Copyright (c) Vercel, Inc.

---

## 5. WebAssembly Micro Runtime (WAMR)

- **位置**：`android/app/src/main/jniLibs/arm64-v8a/libiwasm.so`（预编译二进制）、
  `android/app/src/main/cpp/wasm_runner.c`（JNI 桥接）
- **项目**：https://github.com/bytecodealliance/wasm-micro-runtime
- **许可**：Apache License 2.0
- **版权**：Copyright (c) 2019 Intel Corporation

以二进制形式分发时需随附 Apache-2.0 许可全文与 NOTICE 文件（如有），可从上述上游仓库获取。

---

## 6. go-webview2 / go-winloader

- **位置**：`go.mod` / `go.sum`（仅 Windows 桌面构建）
- **项目**：https://github.com/jchv/go-webview2
- **许可**：MIT

---

## 7. Clang / wasm-ld / Python 运行时资源包

C/C++ 与 Python 的**本地运行库资源包不包含在本仓库中**，由使用者单独导入设备。
它们分别源自 LLVM（Apache-2.0 with LLVM Exceptions）与 CPython（PSF License）的
WASI / ARM64 构建，分发与使用时请遵循各自上游许可。

---

> 若你是某个组件的权利人，认为本仓库的使用方式不符合其许可条款，请提交 issue，
> 我们会在确认后调整或移除相关内容。
