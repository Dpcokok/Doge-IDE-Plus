# Doge IDE+ 1.0.0 首个测试发布版

发布日期：2026-09-27

## 文件

| 文件 | 用途 | SHA-256 |
|---|---|---|
| `DogeIDEPlus-1.0.0-debug.apk` | Android ARM64 测试 APK | `901455DC22E6C93F91CD862F34D368B206F05636BB97152BEE38A4379FE0E7B7` |
| `doge-cpp-arm64-0.1.0.zip` | C/C++ 本地编译运行库 | `58F7B70D991D83CBA0AE33B38506118551F47D49E6C69E6CA1D3F607786CD670` |

APK 大小：1,401,028 字节

资源包大小：235,282,746 字节

## 安装和首次运行

1. 安装 `DogeIDEPlus-1.0.0-debug.apk`。
2. 打开 Doge IDE+，点击“导入运行库”。
3. 选择 `doge-cpp-arm64-0.1.0.zip`。
4. 导入完成后选择 C 或 C++，点击 Run。

资源包只需要首次导入。导入后，编译和运行不依赖网络。

## 当前范围

- Android ARM64 平板；
- 单文件 C17；
- 单文件 C++20；
- 标准库和 C++ STL；
- stdin、stdout、stderr；
- 编译错误、退出码和运行超时；
- 本地 WASM 编译与 WAMR 执行。

此 APK 使用 debug 签名，包名为 `com.doge.ide.plus.debug`，用于测试分发，不是商店正式签名包。
