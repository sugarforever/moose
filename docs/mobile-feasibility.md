# Pi Durable 移动端依赖评估

评估对象是 npm 发行的 Pi Durable / Pi AI / Chord 1.3.0。历史项目中发现了 1.1.0 和 1.2.0；不能直接假定这些版本的接口一致。

| 部分                              | 依赖或限制                                            | 本版处理                                                    |
| --------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| Harness、Conversation、任务状态机 | JavaScript、Promise、AbortSignal、Web Crypto 随机数等 | 在 Hermes 内直接运行                                        |
| 便携 SQLite 核心                  | 需要异步 SqliteDatabase 接口                          | 使用 Expo SQLite 实现串行读写和事务隔离                     |
| Node SQLite 适配器                | node:sqlite、node:fs、node:path                       | 不进入移动端依赖图                                          |
| Node 执行环境、CodingTools        | 文件系统、child_process、文件监听                     | 不注册工具，也不打包 Node 环境适配器                        |
| Code mode、图片 worker            | worker_threads、WASM 等环境能力                       | 本版不启用                                                  |
| 模型调用                          | fetch、SSE、ReadableStream、TextDecoder               | 使用 Expo fetch 注入 Pi 的模型流式实现                      |
| 默认凭据发现                      | 环境变量、用户目录和动态 Node 导入                    | 构建时替换为移动端显式凭据回调                              |
| Pi OAuth 登录                     | Node HTTP 回调监听与部分 Node 加密函数                | 不打包该模块；以独立 HTTPS 设备码或原生 TCP + PKCE 实现替代 |
| 后台运行                          | iOS / Android 调度限制                                | 保存恢复点，重新打开时恢复，不承诺后台准点执行              |

安装树中包含 AWS、Google 等 Pi AI 的传递依赖，不代表它们进入手机包。运行包审计只允许选用的 OpenAI 和 Anthropic 实现进入依赖图，并拒绝 Node 存储适配器、执行环境、OAuth、Code mode 和非选用的模型 SDK。

构建得到约 2.2 MiB 的便携 JavaScript 运行包。平台最终 Hermes 包还包含 React Native 和 Expo 代码，大小不是上面的运行包大小。

## 已验证

- 使用真实 Pi Durable 进行会话持久化、幂等重试和历史检查点分支。
- 在关闭并重开 SQLite 后恢复重复任务，超时不批量追赶，停止后保留已完成次数。
- SQLite 回滚、并发隔离和事务句柄失效。
- GitHub URL 转换、Skill 只下载一个文件、大小限制和 HTML 拒绝。
- 快速连续切换 Skill 不丢失更新，卸载会更新其他对话的指令。
- Pi OpenAI 流式适配器的显式密钥和注入 fetch 接口。
- 没有 process、Buffer、require 的隔离环境中，真实 Harness 能完成对话、保存和分支。
- Android 和 iOS 的 Metro / Hermes 发布包导出。
- iPhone 17 Pro / iOS 26.2 模拟器原生编译、启动、页面操作、公开 GitHub Skill 下载与启用，以及关闭重开后的 Skill 持久化。

实际 iOS 模拟器检查还发现，导入通用 Promise 补丁会替换 React Native 的 Promise，并引起递归错误。本版只补齐缺失的 withResolvers 方法，保留原来的 Promise 实现；structuredClone 使用 React Native 自带实现。这个问题不会在普通 Node 测试中暴露。

## 依赖审计记录

安装树的 npm audit 仍报告 22 项上游告警，集中在 Expo / Metro 工具链的 braces、node-forge 和 xcode 的 uuid 依赖链。已运行兼容范围内的修复；npm 提议的强制修复会退回 Expo 44，与本项目不兼容，因此没有执行。生成的移动运行包依赖图不包含这三个 npm 包。正式发布前仍需跟进工具链上游修复；这里不宣称依赖审计全部通过。

## 明确未完成的部分

- ChatGPT / Codex 设备码、浏览器 loopback、SecureStore、刷新与 SSE 已实现；仍需真实账户授权和推理实测。
- Claude.ai 订阅登录，受服务商当前接入规则限制。
- 真实 API Key 的计费模型请求实测。
- Android 原生安装与实机验证，以及商店签名和提交。
- 后台常驻、跨设备同步、Skill 脚本执行及参考资源下载。

## 参考

- [Pi Durable 源码和说明](https://github.com/earendil-works/pi/tree/main/packages/durable)
- [Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/)
- [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/)
- [ChatGPT 公开客户端授权](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Claude Code 身份验证规则](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
