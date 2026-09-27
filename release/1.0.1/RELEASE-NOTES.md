# Doge IDE+ 1.0.1 测试发布版

发布日期：2026-09-27

## 文件

| 文件 | 用途 | SHA-256 |
|---|---|---|
| `DogeIDEPlus-1.0.1-debug.apk` | Android ARM64 测试 APK | `8587F6DF2F15A95970020BD0E821ED9E33ADD6DC53129C3961101EB91B8A36CD` |
| `doge-cpp-arm64-0.1.0.zip` | C/C++ 本地编译运行库 | `58F7B70D991D83CBA0AE33B38506118551F47D49E6C69E6CA1D3F607786CD670` |

APK 大小：920,792 字节

资源包大小：235,282,746 字节

## 1.0.0 之后的改动

- 增加 Android Storage Access Framework 真实目录工作区；
- 增加 `.doge-project.json` 项目清单；
- 清单记录项目格式、名称和 IDE 管理的文件；
- 打开项目时优先按清单恢复文件；
- 无清单目录继续使用递归扫描兼容旧项目；
- 保存项目时创建或更新清单；
- 保存项目时删除清单中已从 IDE 项目移除的旧文件；
- 保留项目目录中未被 Doge IDE 管理的文件；
- Android 版本号提升为 `1.0.1`，versionCode 为 `2`。

## 安装和首次运行

1. 安装 `DogeIDEPlus-1.0.1-debug.apk`。
2. 打开 Doge IDE+，点击“导入运行库”。
3. 选择 `doge-cpp-arm64-0.1.0.zip`。
4. 点击项目面板的 Open，选择一个项目目录。
5. 编辑文件后点击 Save 写回项目目录。

此 APK 使用 debug 签名，包名为 `com.doge.ide.plus.debug`，用于测试分发，不是商店正式签名包。
