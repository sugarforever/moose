# Moose

Moose v0.1.0 是面向 iOS 和 Android 的本地优先 AI 对话应用。Expo / React Native 提供界面，Pi Durable 在手机的 Hermes 运行时中执行，SQLite 保存对话与任务。模型请求直接发给服务商，无需 Moose 后端。

## 功能

- 流式对话、历史会话、停止回答；长按已发送消息可重新发送。
- 检查点与历史分支，通过对话右上角的更多菜单保存检查点，在任务页恢复。
- 有限次数的重复任务、进度保存、停止和重启恢复。
- 通过 HTTPS URL 安装 Skill，为每个对话独立启用。
- 使用本地 `pi-durable-expo-env` 提供 read、write、edit 文件工具，每个对话拥有独立的设备私有工作区。
- OpenAI / Anthropic API Key，以及实验性的 ChatGPT / Codex 订阅登录。
- 紧凑对话布局、系统消息操作菜单和键盘避让。

## 本地开发

需要 Node.js 22.19 或更高版本。Node 只用于开发、构建与测试，手机不运行 Node.js。

```sh
npm ci
npm run ios
```

iOS 需要 macOS、Xcode 和已安装的模拟器。Android 需要 Android Studio、Java、Android SDK，以及已启动的模拟器或开启 USB 调试的真机：

```sh
npm run android -- --device
```

首次运行会构建并安装原生开发客户端。**不能使用 Expo Go**，因为浏览器订阅登录依赖自定义原生 TCP 模块。

开发客户端安装好后，日常启动：

```sh
npm start
```

在终端按 `i` 打开 iOS 模拟器应用，按 `a` 打开 Android 应用，按 `j` 打开 React Native DevTools。普通界面修改支持 Fast Refresh。修改 `src/runtime/` 或认证协议后运行 `npm run bundle:runtime`；更新原生依赖后重新执行 `npm run ios` 或 `npm run android`。

Android USB 连接不到开发服务器时，可执行 `adb reverse tcp:8081 tcp:8081`，然后连接 `http://localhost:8081`。不要转发登录回调的 1455 端口，它由手机本机监听。

## 连接模型

打开「设置」，通过品牌图标选择服务、模型并保存。OpenAI 显示文字标志，Anthropic 显示 AI 标志，ChatGPT 显示结形标志。

### API Key

OpenAI 和 Anthropic 使用各自的 API Key，API 按服务商规则单独计费。凭据保存到 iOS Keychain / Android 加密存储，不写入对话数据库或仓库。

### ChatGPT 订阅（实验性）

选择 ChatGPT 后，可以使用两种登录方式：

- **登录 ChatGPT**：在官方浏览器页面完成登录，应用临时监听 `127.0.0.1:1455` 接收 OAuth 回调，使用 PKCE 和 state 校验后兑换令牌。
- **设备码登录**：获取设备码，在手机或电脑浏览器打开 [官方授权页](https://auth.openai.com/codex/device)，登录并输入设备码。账户或工作区需要允许设备码授权。

授权后保存 ChatGPT 连接。令牌通过 SecureStore 保存并自动刷新，可取消登录或退出。推理使用独立的 Codex SSE 通道；失败时不会自动切换到 API Key 计费。账户资格、额度和模型权限由服务商决定。

模拟器中若 Google 登录停在 Passkey 的扫码 / 蓝牙连接步骤，可选择其他验证方式，或使用设备码在真实手机 / 电脑浏览器完成授权。完整硬件登录流程应使用真机验证。

自动化测试使用受控响应，不登录真实账户，也不发送计费请求。真实账户授权、订阅资格及额度不属于自动化验证结果。技术来源与验证记录见 [订阅接入说明](docs/chatgpt-subscription.md)。Claude.ai / Claude Code 订阅登录不属于本版功能，Anthropic 使用 API Key。

## 任务、检查点与 Skill

重复任务立即执行第一次，间隔至少一分钟，总次数为 2 到 100 次。请求在提交前保存稳定 ID；未确认提交可重试同一 ID，避免重复入队。停止重复任务会停止后续调度，已经提交的回答需在对话中另行停止。

**任务主要在前台执行，无法保证锁屏或系统挂起后准点运行。** 重新打开后从已提交状态恢复，逾期重复任务只补做一次，再计算下个间隔，不集中补跑全部积压次数。本版没有远程 Host、跨设备同步或后台常驻服务。

检查点恢复会从对应历史消息创建新分支，保留原对话。

Skill 支持 SKILL.md 直链、GitHub 文件、目录和仓库根目录 URL。只下载一个最大 128 KiB 的 Markdown 文件，安装后默认关闭。启用后将指令加入当前对话上下文；脚本、外部引用和其他资源不会下载或执行。GitHub 目录链接需使用单段分支名或提交 SHA。

## 对话文件工作区

可以在对话中要求模型把内容写入 `notes/todo.md`、修改或读取该文件。文件位于当前对话的 `/workspace`，关闭并重新打开应用后仍然保留；其他对话无法通过这些工具访问它。当前没有文件浏览器或系统文档导入入口。

检查点保存对话历史，不保存文件快照。恢复检查点会创建新对话和空工作区，不复制原对话文件，也不回滚磁盘内容。原对话的文件保持不变。

单个文件限制为 8 MiB。只提供 read、write、edit，不支持 Shell、脚本执行或搜索。读取的文件内容会作为工具结果进入模型上下文，可能发送给当前模型服务商。

本地开发包以 `vendor/pi-durable-expo-env-0.1.0.tgz` 安装，无须先发布 npm，也不会直接引用同级目录的源码。修改独立包后，需要重新打包并安装，才能在 Moose 中生效。更新步骤、受控原生测试入口和验证记录见 [文件环境集成说明](docs/mobile-files.md)。

## 验证

```sh
npm run verify
npx expo-doctor
```

`verify` 包含运行包生成、41 项单元与集成测试、TypeScript 检查、无 Node 全局变量的 Pi Durable / SQLite / Codex 模拟链路，以及 Android 和 iOS 的 Hermes 发布资源导出。

当前验证范围：

- iOS：原生 Debug 编译、安装与 iPhone 17 Pro 模拟器运行，已检查聊天布局、消息操作菜单、键盘避让、Skill 下载和持久化，以及本地登录回调监听与取消清理。
- Android：发布资源导出通过；尚未完成原生安装与真机运行验证。
- Expo Doctor：已知 TCP 库的新架构元数据提示，详见下方；不将其报告为全部通过。
- 文件环境：本地包通过受控 OpenAI SSE 在 iOS 模拟器中完成真实 read、write、edit、SQLite 重开和工作区隔离检查，没有使用真实凭据或发送计费请求。

`dist/` 是 JavaScript / Hermes 发布资源，**不是 APK 或 IPA**。可本地构建原生应用，或使用仓库的 EAS development / preview / production 配置。EAS 构建需要自己的 Expo 项目、签名与设备配置；本版尚未验证云端构建或商店发布。

### 已知依赖限制

- `react-native-tcp-socket` 在 React Native Directory 中标为新架构未测试。已验证当前 iOS 开发构建能运行，Android 兼容性仍需原生验证。
- 安装树有已记录的上游 npm audit 告警，涉及 Expo / Metro 工具链。没有通过强制降级 Expo 来消除提示。详情见 [移动端评估](docs/mobile-feasibility.md)。

## 代码结构

```text
App.tsx                    对话界面、导航和消息菜单
src/ui/                    任务、Skill、设置与应用状态
src/runtime/               Pi Durable 会话、重复任务、检查点与模型适配器
src/auth/                  可移植设备码、PKCE 与注入式 TCP 回调协议
src/platform/              Expo SQLite、SecureStore、浏览器、fetch 与 Hermes 兼容层
src/storage/database.ts    串行 SQLite 适配器与事务隔离
src/skills/skills.ts        Skill URL、下载限制和指令选择
scripts/                   运行包生成、依赖审计和便携运行测试
tests/                     协议、存储、任务与恢复测试
```

Pi Durable / AI / Chord 锁定为 1.3.0。便携入口由 esbuild 预打包，排除 Node 凭据发现和 OAuth 回调服务器；平台能力显式注入。生成的 `src/generated/`、`ios/`、`android/` 和 `dist/` 不提交，构建与验证时重新生成。

开发约束见 [AGENTS.md](AGENTS.md)，对话布局见 [设计说明](docs/chat-layout.md)。品牌图标来源与许可见 [assets/brands](assets/brands/README.md)。
