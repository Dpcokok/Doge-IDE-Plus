# 搜狗输入法与 WebView 输入故障：日志和源码核对

日期：2026-10-12（Asia/Shanghai）。

用户补充了同一平板上的对比结果：Android 版搜狗输入法会触发故障，切换平板自带输入法后不出现。当前可将其记录为“搜狗输入法配合外接键盘的兼容性问题”，具体 Chromium 内部失败点仍未确认。本次按另一份 AI 分析检查日志和 Chromium 源码，补充诊断，不增加新的恢复策略。

## 日志直接支持的事实

- 设备：Android 16 / API 36，WebView 140.0.7339.207，搜狗 `com.sohu.inputmethod.sogou/.SogouIME`，外接键盘，鼠标选择多个字符后 Backspace。
- 1.1.6 捕获了起点：选中 18 字符后，输入法先 `commitText("")`，网页收到 `insertText` 类型的 beforeinput/input；CodeMirror 以 `+input` 删除选区，然后才收到 Backspace。之后 8 次单字符提交返回 true，网页没有 beforeinput/input，textarea 保持空。
- 1.1.7 只保留故障后的最后 100 条：24 次长度 1 的 commit-text，全部返回 true，连接均为 c=5。网页 33 次 keydown、66 次 keyup、1 次 blur，没有 beforeinput/input/composition。最后的 blur 与诊断弹窗有关，之前焦点和可编辑标志正常。
- 1.1.7 的删除起点已被滚动缓冲覆盖，不能用它断言之前没有重启或同步。用户确认该版本的“恢复编辑器输入”无效。
- 旧记录将普通按键写为 `text-or-navigation`，没有 keyCode、which 或最终 defaultPrevented，因此它没有直接证明按键是 Unidentified/229，也不能完全排除取消。
- 原生硬件日志只有 key-up，而没有 key-down，符合输入法消费按下后提交文字的可能路径；日志不能单独证明每一个物理按键都走了该路径。

## Chromium 140.0.7339.207 源码检查

读取与设备版本对应的公开源码。以下是可能的执行机制，不是故障时的 Blink 栈跟踪。

| 入口 / 文件 | 核对结果 | 对原分析的影响 |
| --- | --- | --- |
| [ImeAdapterImpl.sendCompositionToNative](https://github.com/chromium/chromium/blob/140.0.7339.207/content/public/android/java/src/org/chromium/content/browser/input/ImeAdapterImpl.java#L1067) | 一般提交路径发送合成 RAW_KEY_DOWN 229、JNI commitText 和 KEY_UP，然后返回 true；另有实体键盘单字符提交转成匹配物理 key-down 的分支 | true 不包含 Blink 编辑是否成功的结果，229 也不是所有提交的唯一可能路径 |
| [ImeAdapterAndroid::CommitText](https://github.com/chromium/chromium/blob/140.0.7339.207/content/browser/android/ime_adapter_android.cc#L331) | 没有 focused widget 时直接返回；方法为 void，否则转发 ImeCommitText | 连接存在及提交返回 true 不证明关联的编辑目标正常 |
| [WebFrameWidgetImpl::CommitText](https://github.com/chromium/chromium/blob/140.0.7339.207/third_party/blink/renderer/core/frame/web_frame_widget_impl.cc#L3946) | 没有 active input controller 时直接返回；不将 controller 的 bool 返回到输入法 | DOM 焦点正常仍不足以证明所有原生/渲染器焦点状态一致 |
| [WebInputMethodControllerImpl::CommitText](https://github.com/chromium/chromium/blob/140.0.7339.207/third_party/blink/renderer/core/exported/web_input_method_controller_impl.cc#L138) | 普通 textarea 路径更新布局并调用 InputMethodController::CommitText | 这里才进入实际编辑逻辑 |
| [InputMethodController::HasComposition](https://github.com/chromium/chromium/blob/140.0.7339.207/third_party/blink/renderer/core/editing/ime/input_method_controller.cc#L365) | 必须 has_composition_、范围未折叠且仍连接于 DOM | “组字区指向已不存在的文本”不是充分解释，脱离/折叠的范围会令 CommitText 走普通插入 |
| [ReplaceCompositionAndMoveCaret](https://github.com/chromium/chromium/blob/140.0.7339.207/third_party/blink/renderer/core/editing/ime/input_method_controller.cc#L846) | 无 root editable 或 composition range 无法映射时，在事件前返回 false | 仍连接但无法映射的组字范围是可检验假设，旧日志不足以证实 |
| [InsertTextAndMoveCaret](https://github.com/chromium/chromium/blob/140.0.7339.207/third_party/blink/renderer/core/editing/ime/input_method_controller.cc#L890) | GetSelectionOffsets 为 null 时直接返回 false，尚未调用 InsertText 发送 beforeinput | “内部可编辑选区失效”同样符合无输入事件的症状，不能因桌面重放正常而排除 |

因此可定位到“原生提交到网页文本编辑之间存在失败”，但不能仅凭日志断言一定在 Blink 的组字替换分支，也不能宣布 CodeMirror/JS 完全无关：更早的 textarea 重置或选区操作仍可能是触发条件。没有 beforeinput 说明被提交的文字未到网页通常的文本编辑事件，并不自动排除之前的按键取消。

## 下一次记录要区分的假设

1. 内部编辑选区失效：预测提交时网页 textarea 仍聚焦、DOM/textarea 选区可能出现不一致，beforeinput 缺失；真实失焦再聚焦或换输入法可能解除。
2. 仍连接但无法映射的组字范围：预测删除前有 compose-region / compose-text 调用及后续清空，失效后只有合成键；需要记录删除瞬间的原生调用，不能由 CodeMirror composing=false 推断 Blink 无组字区。
3. 按键被取消：预测失败提交对应 keydown 最终 defaultPrevented=true。当前桌面原生 229 重放未发生取消，Android 上仍需新日志。
4. 输入目标或渲染器焦点异常：预测提交虽然返回 true，焦点/连接/恢复记录不能解释有效编辑目标；公开 JS 和 InputConnection 日志无法直接读出 Blink 内部范围，需要 WebView 调试或上游最小复现才能最终确认。

## 本次诊断变更（schemaVersion 2）

- 网页记录安全的非文字键名（包括 Unidentified/Process）、IME 229 与导航按键码，文字按键码脱敏为 -1。
- 记录捕获时 defaultPrevented，以及事件分发结束后的最终 defaultPrevented；本地测试验证能观察到 document 冒泡处理器的晚取消。
- 记录 document.getSelection 的数量、折叠、节点类型/编辑器角色、偏移和范围；继续记录 textarea.selectionStart/End。DOM Selection 不能读取 textarea 的内部 Blink shadow 编辑选区，两个视图都保留但不将其等同。
- 保留最近一次实际多字符用户删除前 24 条和后 40 条网页事件，普通缓冲仍限制为 100 条。无需 Android bridge 也可记录删除起点。
- 原生为 compose-region、finish-compose、set-selection、delete-surrounding、delete-codepoints 与空 commit 增加关键记录；参数有明确名称，保留墙钟及 uptime，便于与网页对齐。
- 原生空提交/删除时保存之前最多 100 条和之后 40 条事件，不会被随后重复打字覆盖。
- 不记录源码、提交文字、候选词、节点 id/class 或项目路径。InputConnection 调用原样转发，其返回值原样保留。
- 工作区原有 1.1.8 删除后 blur/focus + restartInput 实现仍在 APK 内，尚未在用户平板验证。本次只增强诊断，不把这个既有尝试记为已验证修复。

## 验证与限制

- JVM 执行真实 EditorWebView 包装器：26 项通过，包含返回值透传、输入参数、隐私、边界容量与删除起点保留。
- 前端基线：596 项通过；JS 语法与 git diff --check 通过。
- 新浏览器输入诊断：17 项通过。真实鼠标选择 18 字符 → CDP Input.insertText(空字符串) → Backspace → native 229 → xy 可继续输入。测试验证晚取消观测及日志脱敏。
- 既有原生同步模型：61 项通过。模型人为定义“同步解除输入阻断”，只证明应用控制路径，不证明真实搜狗/WebView 被修复。
- Android UA 连续组字测试仍有间歇失败：一次 120/121，通过运行也为 121/121；失败是合成组字中的单字丢失而后续字符能继续输入，与真机持续没有 beforeinput/input 的故障不同。尚未稳定复现或锁定原因，不能写成全部回归通过。
- assembleDebug / lintDebug 成功，lint 为 0 errors / 11 warnings；APK assets/index.html 与当前网页源码一致。
- 没有 adb 设备连接，未做 Android 真机回放；桌面 Android UA 不替代 Android WebView/搜狗。

## 产物和兼容性说明

诊断 APK：`android/app/build/outputs/apk/debug/app-debug.apk`，1.1.8-debug，versionCode 12。

大小：1,287,509 字节。

SHA-256：`E7550CAA6F4E96C2F1F9FE3E9164F253A314EB2DEAA6E7B81942E96FB01755AF`。

用户已提供换输入法正常的对比结果，暂时可使用平板自带输入法。建议对外提示限定为实际已知范围：

> Android 平板配合外接键盘使用搜狗输入法时，删除选中文字可能导致无法继续输入。建议切换平板自带输入法。

不要求用户继续反复测试。若后续还要取证：卡住后只尝试 1–2 个字符，立即通过“帮助 → 输入诊断”复制；保存记录后再做实际切出/切回编辑器的恢复对比。尚无真机验收，不宣称此 APK 已解决搜狗兼容问题。
