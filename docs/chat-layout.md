# 紧凑对话界面

采用单行导航、紧凑用户气泡、无卡片边框的回答，去除重复角色名称、品牌行、常驻重新运行和独立会话信息栏。导航保留历史、新对话；检查点进入更多菜单，模型名称为紧凑副标题。

长按已发送的用户消息，弹出系统操作菜单，选择重新发送。菜单针对所选消息，不只针对最后一条；执行中、未连接模型时不允许重新发送。保留无障碍操作入口。不会在界面验证时实际发送用户消息。

输入区使用系统键盘避让，键盘展开时隐藏底部标签栏并去掉额外底部安全区，收起后恢复。点击区域不小于 44 点，文字支持系统字号。列表仅在用户位于底部时跟随新内容，避免打断阅读。

参考：[Apple Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus)、[Apple Layout](https://developer.apple.com/design/human-interface-guidelines/layout)。验收：模拟器检查已有消息布局、长按菜单、键盘显示与收起，不触发真实模型请求；运行类型检查和现有测试。

本轮验证：类型检查与现有 34 项测试通过。iPhone 17 Pro 模拟器检查了现有多轮对话、原生消息操作菜单以及键盘展开布局；菜单验证通过无障碍“消息选项”调用与长按相同的处理函数，选择取消，未实际重新发送。iOS KeyboardAvoidingView 需要传入顶部安全区偏移，避免输入框被键盘遮挡。Android 本轮未做设备验证。

开发构建默认隐藏 Expo 的悬浮工具按钮，避免覆盖历史对话弹层右上角的关闭动作。开发菜单仍可通过模拟器快捷键或摇动手势打开。本次在原来的 iPhone 17 Pro 模拟器中复现重叠，隐藏浮钮后验证历史弹层的打开、关闭及返回对话；类型检查通过，未发送模型请求。

## Execution activity

The chat projects committed tool results and pi.live into compact status rows. Queued/running tools (including nested tools), model retry/deferred responses, thinking, and context compaction have short labels. Thinking content, tool arguments and raw diagnostics are not displayed. Text tool output is collapsed by default and limited to its last 4,000 characters with a truncation marker; it is selectable when expanded. Existing assistant text remains plain text.

Tool results stay at their transcript entry positions after completion or reopening, including failed calls. Live slots that already have a committed result are omitted to prevent duplicate rows. Transient state is cleared when changing conversations; the existing disposed watcher guard rejects late updates. No new event log, persistence format, provider behavior or scheduler is introduced. Nested progress is transient; durable top-level tool results supply the history.

Validation on 2026-10-21: projection regressions plus real Harness/file-tool/SQLite reopen coverage; browser preview of the actual ActivityRow component confirmed collapsed output, expansion and error output. Native compilation and simulator/device interactions were not performed for this change. No real model requests or account authorization were used. Full command results are recorded in the PR.
