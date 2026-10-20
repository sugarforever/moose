# Moose

Moose v0.2.0 是面向 iOS 和 Android 的本地优先 AI 对话应用。Expo / React Native 提供界面，Pi Durable 在手机的 Hermes 运行时中执行，SQLite 保存对话与任务。模型请求直接发给服务商，无需 Moose 后端。

## 功能

- 流式对话、历史会话、停止回答；长按已发送消息可重新发送。
- 检查点与历史分支，通过对话右上角的更多菜单保存检查点，在任务页恢复。
- 有限次数的重复任务、进度保存、停止和重启恢复。
- 通过 HTTPS 链接安装技能（Skill），为每个对话独立启用。
- 默认使用 `pi-durable-expo-env` 提供读取、写入、编辑和目录枚举工具（`read`、`write`、`edit`、`workspace_list`），每个对话拥有独立的设备私有工作区。
- Android 可选实验性 Termux 文件与命令执行环境，提供应用内自动配置与连接；原生 Termux 验收尚未完成，见 [设置和限制](docs/termux.md)。
- OpenAI / Anthropic API 密钥，以及实验性的 ChatGPT / Codex 订阅登录。
- 紧凑对话布局、系统消息操作菜单和键盘避让。

## 本地开发

需要 Node.js 22.19 或更高版本。Moose 应用本身不运行 Node.js；开发、构建与测试需要 Node，可选 Termux 服务也需要在 Termux 中安装 Node。

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

在终端按 `i` 打开 iOS 模拟器应用，按 `a` 打开 Android 应用，按 `j` 打开 React Native 开发者工具。普通界面修改支持快速刷新。修改 `src/runtime/` 或认证协议后运行 `npm run bundle:runtime`；更新原生依赖后重新执行 `npm run ios` 或 `npm run android`。

Android USB 连接不到开发服务器时，可执行 `adb reverse tcp:8081 tcp:8081`，然后连接 `http://localhost:8081`。不要转发登录回调的 1455 端口，它由手机本机监听。

## 通过 GitHub Actions 构建和发布 Android 安装包

`.github/workflows/build.yml` 仅在推送 `v*` 标签或手动选择“运行工作流”（Run workflow）时运行。Android 在 GitHub 的 Ubuntu 执行环境上安装锁定依赖、生成 Pi 运行包、运行测试与类型检查，再用 Expo Prebuild 和 Gradle `assembleRelease` 构建 APK，不使用 EAS 云构建，也不需要配置仓库机密变量。

构建成功后，打开该次工作流运行页面，在“构建产物”（Artifacts）下载 `moose-android-test-<运行编号>`，解压后安装其中的 APK。包内包含 JavaScript / Hermes 资源，启动无需 Metro 或开发电脑；模型请求仍需网络和用户自己的凭据。附件保留 14 天。版本标签构建成功后会自动创建 GitHub 预发布并附上 APK；手动构建只保留构建产物。

当前 APK 使用 Expo 生成项目的默认测试签名，只供内测。正式公开分发前需配置独立的长期签名密钥；切换签名可能需要卸载旧测试包，卸载会删除本地对话和文件。iOS 构建任务 通过 `if: false` 明确跳过，不构建 IPA 或上传 TestFlight。

## 连接模型

打开“设置”，通过品牌图标选择服务、模型并保存。OpenAI 显示文字标志，Anthropic 显示 AI 标志，ChatGPT 显示结形标志。

### API 密钥

OpenAI 和 Anthropic 使用各自的 API 密钥，API 按服务商规则单独计费。凭据保存到 iOS 钥匙串 / Android 加密存储，不写入对话数据库或仓库。

### ChatGPT 订阅（实验性）

选择 ChatGPT 后，可以使用两种登录方式：

- **登录 ChatGPT**：在官方浏览器页面完成登录，应用临时监听 `127.0.0.1:1455` 接收 OAuth 回调，使用 PKCE 和 state 校验后兑换令牌。
- **设备码登录**：获取设备码，在手机或电脑浏览器打开 [官方授权页](https://auth.openai.com/codex/device)，登录并输入设备码。账户或工作区需要允许设备码授权。

授权后保存 ChatGPT 连接。令牌通过 SecureStore 保存并自动刷新，可取消登录或退出。推理使用独立的 Codex SSE 通道；失败时不会自动切换到 API 密钥计费。账户资格、额度和模型权限由服务商决定。

模拟器中若 Google 登录停在通行密钥的扫码 / 蓝牙连接步骤，可选择其他验证方式，或使用设备码在真实手机 / 电脑浏览器完成授权。完整硬件登录流程应使用真机验证。

自动化测试使用受控响应，不登录真实账户，也不发送计费请求。真实账户授权、订阅资格及额度不属于自动化验证结果。技术来源与验证记录见 [订阅接入说明](docs/chatgpt-subscription.md)。Claude.ai / Claude Code 订阅登录不属于本版功能，Anthropic 使用 API 密钥。

## 任务、检查点与技能

重复任务立即执行第一次，间隔至少一分钟，总次数为 2 到 100 次。请求在提交前保存稳定 ID；未确认提交可重试同一 ID，避免重复入队。停止重复任务会停止后续调度，已经提交的回答需在对话中另行停止。

**任务主要在前台执行，无法保证锁屏或系统挂起后准点运行。** 重新打开后从已提交状态恢复，逾期重复任务只补做一次，再计算下个间隔，不集中补跑全部积压次数。本版没有远程执行主机、跨设备同步或后台常驻服务。

检查点恢复会从对应历史消息创建新分支，保留原对话。

技能支持 SKILL.md 直链、GitHub 文件、目录和仓库根目录 URL。安装时下载一个最大 128 KiB 的 Markdown 文件，安装后默认关闭。启用后将指令加入当前对话上下文；模型可通过资源工具读取相对路径的文本参考文件，首次联网需要授权，下载后缓存。脚本不会执行。GitHub 目录链接需使用单段分支名或提交 SHA。

## 对话文件工作区

可以在对话中要求模型把内容写入 `notes/todo.md`、修改或读取该文件。文件位于当前对话的 `/workspace`，关闭并重新打开应用后仍然保留；其他对话无法通过这些工具访问它。当前没有系统文档导入入口。

检查点保存对话历史，不保存文件快照。恢复检查点会创建新对话和空工作区，不复制原对话文件，也不回滚磁盘内容。原对话的文件保持不变。

单个文件限制为 8 MiB。默认环境提供读取、写入、编辑和目录枚举工具，不支持命令执行、脚本执行或搜索。Android 可在设置中明确选择 Termux 环境，切换无需重启应用，文件不会迁移。读取的文件内容会作为工具结果进入模型上下文，可能发送给当前模型服务商。

文件环境使用 npm 发布的 `pi-durable-expo-env@0.1.0`，版本与完整性由锁文件固定，不依赖同级目录的源码或本地包归档。更新步骤、受控原生测试入口和验证记录见 [文件环境集成说明](docs/mobile-files.md)。

## Android Termux 安装与配置（实验性）

Moose 内的“设置并连接 Termux”会检查并安装 Node 和锁工具、部署 APK 内置的服务文件、自动配对并连接。不需要下载或搬运 `service.mjs`、复制公钥、手动输入服务启动命令，也不需要为了切换环境重启 Moose。

首次使用仍需你完成以下操作：

1. 安装包含本次原生模块的新版 Moose APK。旧版 APK 或 Expo Go 不包含自动配置模块；开发者需重新编译原生客户端。
2. 安装并打开一次 Termux，等待初始化完成，看到命令提示符。
3. 打开 Moose →“设置”→“执行环境”，点击“授权运行命令”，允许在 Termux 中运行命令。如果系统没有弹窗或你之前拒绝过，点击“打开系统设置”，在 Moose 的应用权限／其他权限中允许此项。
4. 在同一页长按复制一次性配置命令，点击“打开 Termux”，粘贴并执行，再返回 Moose。完整命令如下：

```sh
mkdir -p ~/.termux && printf '\nallow-external-apps = true\n' >> ~/.termux/termux.properties && termux-reload-settings
```

5. 点击“设置并连接 Termux”。保持 Moose 在前台并联网，等待检查、安装、连接完成。首次需要下载 Termux 软件包，可能耗时数分钟。成功后显示“已连接 Termux。”，当前环境变为 Termux，无需重启应用。
6. 新建对话，发送：“在当前工作区创建 hello.txt，写入 hello，然后用 bash 读取它。”这会使用你已配置的模型连接，可能产生模型费用。模型凭据只在 Moose 中配置，不要填入 Termux。

每次手机重启或 Termux 被系统结束后，可在 Moose 设置中点击“检查或修复连接”。切回本地环境使用“使用本地文件”。有运行中的回答、待提交请求或未停止的重复任务时，需先处理这些任务，再切换。切换不迁移文件、不删除原生数据库或历史报告。

服务仅监听手机本机 `127.0.0.1:18765`。临时安装端口也仅监听本机回环地址，传输的是 APK 内置代码并校验 SHA-256，不需要共享存储权限。Moose 的私密签名种子和模型凭据不会传给 Termux。Android 可能暂停或终止后台进程，不能保证锁屏后持续执行。

Termux 命令拥有该应用的文件和网络权限，能访问其他 Termux 文件；对话目录和 PRoot 都不是安全沙箱。原生工具的授权不限制 bash 的网络或文件访问。取消设置会停止等待和临时传输，但不会回滚已安装的软件包，已下载完成的安装进程也可能继续启动服务。

完整的手机逐步操作、常见错误、已有手动服务的迁移和验收清单见 [Termux 手机配置手册](docs/termux-setup-guide.md)。技术边界与验证记录见 [Termux 说明](docs/termux.md)。Android 实机授权、部署、连接及取消仍需实际验收，测试和资源导出不等于实机验证。

## 原生工具与权限

以下通用原生工具用于默认的本地环境，iOS 和未启用 Termux 的 Android 用户仍可使用。Termux 模式隐藏重复的 HTTP、数据库、JSON 导入、文档和目录枚举工具，复杂执行统一交给 bash；保留 `capabilities`、`skill_resource_read` 和 `artifact_create`，用于工具发现、技能资源和应用内报告发布。

已有原生数据库、文档、报告及授权不会删除或迁移，切回本地环境后仍可继续使用。Termux 工作区内的文件不会自动进入报告列表；需明确调用 `artifact_create` 发布可预览的 HTML／文本内容。

模型可通过 `capabilities` 查看工具契约及当前启用的技能 ID。原生工具提供 HTTPS GET、独立的 技能 SQLite 数据库、声明式 JSON 导入、跨对话文档和 HTML／文本报告。工具无需安装或启用 Skill 即可使用，默认保存到当前对话的私有范围。需要访问 技能共享数据时才传入 `skillId`，并检查该 Skill 是否已安装且在当前对话启用。技能资源读取始终需要 技能 ID；技能内容不能自行授予权限。

首次访问 HTTPS 来源、读取或修改数据库、访问 技能跨对话文档时，应用展示授权窗口。授权仅对当前对话的所选范围有效，普通工具与各个技能 的授权相互独立，可在设置中撤销；撤销会停止当前回答。修改数据库的授权不自动包含读取授权。工具不使用模型服务的 API Key、OAuth 令牌或浏览器 Cookie。

HTTP 响应以引用保存，最大 8 MiB，超时 30 秒；重定向逐个检查并授权。`json_import` 在设备上转换数据并写入 SQLite，无需把整个 JSON 发给模型。数据库使用单独文件，不允许访问 Pi 内部数据；查询通过表名、字段、条件、排序和条数生成参数化 SQL，最多返回 200 行，不接收任意 SQL。迁移支持建表和添加字段，写入支持按主键更新或插入。

写入、导入、文档修改和报告生成需要稳定的 `operationId`。重试相同操作时沿用 ID，复用 ID 但改变参数会报错。数据和操作回执在同一事务提交；失败批次会回滚，成功刷新时间只随完整导入提交。应用被系统挂起时仍无法保证继续执行。

未传入 技能 ID 的数据库、文档和 HTTP 响应属于当前对话，重启后保留，其他对话和新检查点分支无法访问；技能数据库和共享文档在重启、切换对话及检查点分支后保留，新对话需要重新授权。卸载技能 会撤销工具访问，但保留数据以供重新安装；对话私有工作区仍保持隔离，检查点不保存文件快照。文档和报告单项最大 512 KiB，文档与资源读取采用分页，内容可能发送给当前模型服务商。

生成报告后，在对话右上角菜单打开“文件与报告”，可预览或点击“分享或导出”调用系统分享面板。应用内 HTML 预览禁用 JavaScript、外部资源和导航。分享必须由用户点击触发。新增原生依赖后需要重新构建开发客户端。

工具边界、持久化语义和验证说明见 [原生工具设计](docs/portable-agent-tools.md)。开发者可通过 `EXPO_PUBLIC_MOOSE_CAPABILITIES_SMOKE=1 npx expo start --dev-client` 打开独立原生测试入口，使用专用 SQLite 数据库与受控响应，不访问用户数据或真实模型。

## 验证

```sh
npm run verify
npx expo-doctor
```

`verify` 包含运行包生成、119 项单元与集成测试、3 项真实安装脚本测试、TypeScript 检查、无 Node 全局变量的 Pi Durable / SQLite / Codex 模拟链路，以及 Android 和 iOS 的 Hermes 发布资源导出。

当前验证范围：

- iOS：原生调试编译、安装与 iPhone 17 Pro 模拟器运行，已检查聊天布局、消息操作菜单、键盘避让、技能下载和持久化，以及本地登录回调监听与取消清理。
- Android：发布资源导出通过；[GitHub Actions 已成功编译测试 APK](https://github.com/sugarforever/moose/actions/runs/39503789329)，包含 Termux 自动配置原生模块。尚未完成手机安装、授权和真实 Termux 操作验证。
- Expo Doctor：20 项检查通过 19 项，剩余检查涉及 TCP 库的新架构元数据提示，以及本地 Termux 模块缺少公共目录元数据；不将其报告为全部通过。
- 文件环境：本地包通过受控 OpenAI SSE 在 iOS 模拟器中完成真实文件读取、写入和编辑、SQLite 重开和工作区隔离检查，没有使用真实凭据或发送计费请求。

`dist/` 是 JavaScript / Hermes 发布资源，**不是 APK 或 IPA**。可本地构建原生应用，或使用仓库的 EAS 开发、预览和生产配置。EAS 构建需要自己的 Expo 项目、签名与设备配置；本版尚未验证 EAS 云端构建或商店发布。GitHub Actions 的测试 APK 编译结果见上文。

### 已知依赖限制

- `react-native-tcp-socket` 在 React Native Directory 中标为新架构未测试。已验证当前 iOS 开发构建能运行，Android 实机兼容性仍待验证。
- 安装树有已记录的上游 npm audit 告警，涉及 Expo / Metro 工具链。没有通过强制降级 Expo 来消除提示。详情见 [移动端评估](docs/mobile-feasibility.md)。

## 代码结构

```text
App.tsx                    对话界面、导航和消息菜单
src/ui/                    任务、技能、设置与应用状态
src/runtime/               Pi Durable 会话、重复任务、检查点与模型适配器
src/auth/                  可移植设备码、PKCE 与注入式 TCP 回调协议
src/platform/              Expo SQLite、SecureStore、浏览器、fetch 与 Hermes 兼容层
src/storage/database.ts    串行 SQLite 适配器与事务隔离
src/skills/skills.ts        Skill URL、下载限制和指令选择
scripts/                   运行包生成、依赖审计和便携运行测试
tests/                     协议、存储、任务与恢复测试
```

Pi Durable / AI / Chord 锁定为 1.3.0。便携入口由 esbuild 预打包，排除 Node 自动凭据发现和 OAuth 回调服务器；平台能力显式注入。生成的 `src/generated/`、`ios/`、`android/` 和 `dist/` 不提交，构建与验证时重新生成。

开发约束见 [AGENTS.md](AGENTS.md)，对话布局见 [设计说明](docs/chat-layout.md)。品牌图标来源与许可见 [assets/brands](assets/brands/README.md)。
