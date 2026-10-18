# ChatGPT 订阅接入研究与设计

研究日期：2026-10-18。这里区分开源项目的实际实现、官方说明和 Moose 的验证范围。

## 研究结果

| 来源                                                                                                          | 认证与推理实现                                                                       | 对移动端的意义                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [Pi Codex OAuth](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-codex.ts)   | 浏览器回调与设备码两种登录；设备码通过 HTTPS 轮询换取令牌，支持刷新                  | 设备码协议可以独立移植，避免导入同文件中的 Node HTTP 回调服务器                    |
| [官方 Codex](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs)                | 请求设备码、轮询授权、使用服务端返回的 verifier 换取令牌；15 分钟超时                | 验证这条流程不依赖本地端口；不是网页 Cookie 或会话抓取                             |
| [OpenCode](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/provider/openai.ts)        | 提供 Codex device code（legacy）；同一组设备授权接口及公共客户端 ID；独立 Codex 后端 | 证明当前其他开源客户端也使用该兼容路径；目录变化时应检查真实源码，不能仅凭搜索摘要 |
| [Microsoft Amplifier ChatGPT Provider](https://github.com/microsoft/amplifier-module-provider-openai-chatgpt) | 设备码登录、自动刷新、独立的 Codex SSE 推理                                          | 订阅协议与普通 OpenAI API 存在差异，应该保留独立 provider                          |
| [官方 Codex 认证文档](https://learn.chatgpt.com/docs/auth)                                                    | 推荐在回调不可达的环境使用 device code（beta），账户或工作区需启用设备码授权         | 用户在系统浏览器中登录并输入自己发起的设备码，应用无需监听 localhost               |

用户提到的“PyAgent”没有通过该准确拼写定位到唯一的订阅接入仓库；本项目沿用已确认的 Pi / Pi Agent 技术栈，核实的是上述 Pi 实现。

此前仅考虑 [新的公开客户端注册流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)，从它的 HTTP loopback 要求推断所有订阅登录都需要原生监听，范围过窄。Codex 设备码是另一条现有路径。两条流程的客户端 ID、令牌用途和后端不能混用。

## Moose 实现方案

- 独立的便携设备码客户端，仅使用 fetch、定时器和 AbortController；公共客户端 ID 与 Pi / Codex 兼容实现一致，不包含客户端密钥。
- 请求设备码，显示验证码和固定的官方验证网址，按服务器间隔轮询；处理授权拒绝、取消、过期和 slow_down。
- 所有敏感令牌通过 SecureStore 保存，设备码仅保留在本次登录的内存状态中。错误提示只包含必要状态，不回显服务端敏感响应。
- 串行执行令牌刷新和本地凭据修改，保存轮换后的 refresh token，避免并发刷新和退出后重新写入凭据。
- 以 `openai-codex` 注册 Pi 的 Codex 模型目录与流式实现，通过 Expo fetch 强制使用 SSE。API Key 通道保持独立，无自动计费回退。
- 成功授权仅表示凭据已保存；用户显式选择订阅连接后才用于会话。模型目录不代表账户拥有所有模型的权限。

Codex 后端不是普通公开 API 的稳定兼容保证；本功能作为实验性接入。账户资格、工作区策略、额度、模型可用性和服务端协议均可能变化。用户需要先在自己的 ChatGPT 安全设置或工作区策略中启用设备码授权。

## 验证边界

自动测试使用受控 HTTPS 响应，覆盖完整设备码协议、刷新与退出竞态，以及真实 Pi Codex 流式适配器的目标地址和认证头。真实账户登录与订阅推理只有在实际完成后才报告为已验证。

2026-10-18 验证记录：

- `npm run verify` 通过：23 项测试、TypeScript、无 Node 全局变量的 Pi Durable / SQLite / 设备授权 / Codex SSE 模拟链路、Android 和 iOS Hermes 导出。
- 独立代码审查发现并修复两个存储时序问题；补充延迟写入时取消登录、保留旧账户、刷新期间退出的回归测试。
- iPhone 17 Pro 模拟器运行新版设置页，成功从官方服务申请设备码并显示倒计时，取消后恢复初始登录状态。未完成账户授权，未使用真实令牌或发送推理请求。
- Android 本轮仅验证打包，没有设备运行证据。

## 本地 HTTP 回调方式

用户提供本地 rn-ai-kit 后，核实 [issue #4](https://github.com/sugarforever/rn-ai-kit/issues/4) 和后续 [PR #5](https://github.com/sugarforever/rn-ai-kit/pull/5)：原始建议是通过 [SwiftWebServer](https://github.com/atom2ueki/SwiftWebServer) 在 iOS 临时监听，当前 [CodingPlanKit](https://github.com/atom2ueki/CodingPlanKit) 将它用于原生认证；rn-ai-kit 已增加 react-native-tcp-socket 的跨平台注入实现。

Moose 增加独立浏览器按钮：Expo Crypto 生成随机 state 和 S256 PKCE；原生 TCP 绑定 127.0.0.1:1455，收到 ready 才打开浏览器；只接受 /auth/callback，校验 state、重复参数和授权错误；使用原始 verifier 经 HTTPS 换取令牌，复用安全保存和刷新。错误 state 不结束监听。请求大小、连接数、空闲时间和总等待都有上限；成功、失败和取消均清理端口。

实现位于 src/auth/loopback.ts 和 src/platform/codex-browser.ts，未依赖本机另一个仓库。相对参考实现，明确等待监听就绪、验证回调 state，并处理 Android opened 立即返回以及取消发生在原生监听就绪之前的清理。iOS 采用 Expo 的应用内浏览器，完成后关闭；Android 若 tab 仍显示回调页，可点 Return to Moose 返回。

该方式需要原生构建，Expo Go 不支持。手机被系统挂起或终止仍可能中断登录，重新发起即可；没有为了监听而增加后台常驻权限或放宽全局网络安全策略。

Swift 源码细节：`OAuth2PKCEFlow.beginLogin()` 先启动 `LocalCallbackServer` 并等待 `waitUntilStarted()`，随后构造 localhost redirect URI；`OpenAIAuthProvider` 可设置 callbackScheme，本地服务器再桥接到自定义 scheme，由 `BrowserAuthSession` 的 ASWebAuthenticationSession 截获并收起页面。Moose 此次采用 rn-ai-kit 的 Expo 浏览器方式，直接通过 TCP 回调完成授权；iOS 主动 dismiss，未复制 Swift 的 scheme 二次转发流程。

本轮验证：34 项测试、类型检查、便携运行验证、Android / iOS Hermes 导出通过；iOS 原生 Debug 编译、安装和启动通过。模拟器中官方登录页成功打开；Moose 进程只绑定 IPv4 127.0.0.1:1455，实测无关路径 404、错误 state 400，关闭浏览器后 UI 显示取消，端口释放。正确 state 的回调兑换由受控协议测试覆盖，未完成真实账户登录或订阅推理。Expo Doctor 为 19/20：react-native-tcp-socket 的 React Native Directory 元数据标记为新架构未测试；保留该提示，Android 原生运行仍待验证。
