# Android 前台服务与 Agent 后台执行

调研日期：2026-10-21。代码基线：`f788a9d`。本 PR 仅提供可行性研究和实施设计，没有启用后台服务。

**可行：用 Android foreground service 承载用户从前台发起的有限 Agent 任务，让切到桌面或其他应用后仍有机会持续消费 SSE、执行工具和保存结果。需要同时处理服务、Hermes 执行生命周期与单个运行时的所有权。不能承诺永久连接、系统回收后无缝续流，或用户强行停止后继续执行。**

当前工作区已有 `2026-10-19-agent-background-execution.md`，其中区分了持久化恢复与持续运行，也提出 Android FGS 方向。它在此次基线中尚未提交，本 PR 不收录其他会话的文件，以下结论可独立阅读。

## 当前缺少什么

| 代码证据                               | 当前行为                                                      | 实施影响                                           |
| -------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| `src/ui/useMoose.ts` 的初始化 effect   | UI 调用 `openMobile()`，卸载时关闭 engine                     | 执行器寿命依附 React，需移到应用级所有者           |
| 同文件的 `AppState` effect             | 回前台检查凭据并 `resume()`；后台不主动取消；列表仅在前台轮询 | 切后台本来就不会主动停止，但没有系统执行资格       |
| `src/platform/open.ts`                 | 打开 Expo SQLite，创建模型和 Harness，使用 `expo/fetch`       | 应复用同一个实例，不能让后台入口再开第二个 Harness |
| `src/runtime/engine.ts`                | Pi 任务与稳定提交 ID 保存在 SQLite                            | 可用于中断恢复，无法保住消失的 JS 栈或 TCP 连接    |
| `app.json`、`index.ts`、`package.json` | 基线未声明 FGS，也无 Headless JS 任务入口                     | 需要 Kotlin 服务、Expo 原生集成和新开发客户端      |

这里的“保持连接”是继续读取现有模型 HTTP SSE，并允许工具结果提交后发起下一轮请求。只让原生 socket 留着，JS 被暂停后仍无法推进 Agent。现有幂等提交也不代表模型服务端只生成或计费一次。

最新主干已有组件内的 `runtimeOwner` 引用和 Termux 环境切换，但它仍随 React 生命周期关闭，不是应用级后台所有者。Termux 仅提供工具执行端，Moose 的 Harness 与模型连接仍在 Moose 进程；Moose FGS 不会自动保护另一个应用的进程。后台遇到需要用户授权的工具应持久化等待状态并通知返回应用，不能自动批准。切换执行环境需拒绝或先停止所有后台活跃运行，不能只检查当前页面。

## Android 能提供的边界

| 场景                                 | 推荐方案的目标                                 | 仍需接受的限制                                  |
| ------------------------------------ | ---------------------------------------------- | ----------------------------------------------- |
| 按 Home、切其他应用                  | 已启动的 FGS 和后台 JS 任务继续同一个运行      | 不在 `AppState=background` 后才首次启动服务     |
| 锁屏、短时间息屏                     | 用有界 partial wake lock 支持工作期间 CPU 执行 | 需脱离调试器实测，FGS 不自动保证 CPU 常醒       |
| 深度 Doze、弱网、Wi-Fi 与蜂窝切换    | 检测中断，保存阶段并显示等待或失败             | FGS 和普通 wake lock 不能保证绕过 Doze 网络限制 |
| 从最近任务划掉                       | 将 Activity 移除与显式停止区分，服务尽力继续   | 取决于服务配置、ReactHost 生命周期与厂商行为    |
| 系统杀进程、崩溃                     | 下次打开从已提交状态恢复                       | 不承诺自动复活，不可能接回原 TCP 连接           |
| 设置中强行停止、系统活动应用面板停止 | 停止执行，等待用户再次打开                     | 无法依赖 JS 清理或服务退出回调                  |
| 重启设备、等待下一轮重复任务         | 沿用重新打开后恢复的语义                       | 首版不做开机自启或精确后台周期调度              |

[Android 后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)要求在允许的时机启动服务。因此用户点击发送或启动任务时，应在 Activity 仍可见时完成服务启动，而非等失去前台资格。[服务启动流程](https://developer.android.com/develop/background-work/services/fgs/launch)是先 `startForegroundService()`，服务再及时调用 `startForeground()` 并提供通知；耗时 JS 初始化放在通知建立之后。

[Doze 文档](https://developer.android.com/training/monitoring-device-state/doze-standby)明确限制网络并忽略普通 wake lock；FGS 影响 App Standby 判定，不能把它当成 Doze 豁免。首版不强制用户关闭电池优化。若实机证明深度休眠确实阻断核心任务，再单独评估用户手动设置及分发政策，不能把白名单作为默认成功条件。

## 服务类型与分发

按[官方类型表](https://developer.android.com/develop/background-work/services/fgs/service-types)，`dataSync` 适用于数据传输、获取和本地文件处理；一般多轮 Agent 还包含决策、工具和等待，不能仅因为用了网络就断言整个任务符合该类型。

推荐原型使用 `specialUse`，声明 `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_SPECIAL_USE`，在 service 内提供 `android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE`，说明用途为“用户主动发起、通知可见且可随时停止的多轮 AI 任务”。这只是类型选择建议，**不代表 Google Play 已批准该用途**。Play 发布前需提交真实演示和用途说明；GitHub APK 分发虽不经过该审核，仍受系统权限、启动和电源限制。若日后只实现独立数据传输任务，再单独评估 `dataSync`。

`shortService` 约三分钟，不适合作为通用 Agent 基础；不能伪装音频、定位或远程消息用途。[Android 15 超时规则](https://developer.android.com/develop/background-work/services/fgs/timeout)针对相应 target 的 `dataSync` 和 `mediaProcessing`，每类在后台有共享的六小时预算，前台交互可重置；这既不是单任务六小时许可，也不表示 `specialUse` 永不被终止。

Android 13+ 应申请通知权限并提供“打开会话”和“停止后台任务”。[拒绝通知权限](https://developer.android.com/develop/ui/views/notifications/notification-permission)不从系统层面禁止启动 FGS，但通知抽屉可能看不到入口，活动应用面板仍可见。产品可选择拒绝后只在前台执行，必须明确这是 Moose 的交互选择。

## 推荐实现

先做 Android 专用、默认关闭的“任务在后台继续”能力，仅覆盖用户当前发起的有限运行。建议初始每次后台执行预算 30 分钟，这是产品上限而非系统保证；通知显示真实阶段和已用时间，不伪造完成百分比。完成、失败、用户停止或预算到期后释放服务和 wake lock。

```text
用户在可见 Activity 中发送
  → 保存 outbox / 稳定 requestId
  → Kotlin 服务建立通知并确认启动
  → Headless JS 取得应用级 runtime 的执行引用
  → 同一个 Harness 提交并驱动 SSE / 工具 / SQLite
  → React UI 仅订阅；切前后台不重开运行时
  → 完成 / 停止 / 超时 → 提交状态 → 释放执行引用和服务
```

采用小型本地 Expo module 管理 service 与通知，用 config plugin 注册 manifest；不直接修改生成的 `android/`。不把 API Key、OAuth 令牌、提示词或 SSE 内容传进 Intent、通知或原生日志。Android 首版使用同进程 service，不配置独立 `android:process`。

[React Native Headless JS](https://reactnative.dev/docs/headless-js-android)提供后台 JS 任务入口，任务 Promise 完成后后台执行可暂停。推荐注册一个可在前台启动的执行任务，持有 Promise 到所有被保护运行终结，显式配置超时和取消；不能直接复制文档的五秒任务示例。它提供执行生命周期，不能把已经中断的 Promise 搬进另一个运行时。

需要先在项目实际 Expo / React Native / Hermes 和新架构构建中验证 Headless JS 与当前 ReactHost 的集成，公开文档示例不构成此依赖组合已经可用的证据。若宿主会重建 ReactContext，不能用双运行时抢同一个 SQLite 的方式补救；应调整宿主所有权或收窄首版能力。

| 模块                               | 拟议改动                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| 新应用级 runtime owner             | 串行 `acquire/release`，并发打开共享一个初始化 Promise；UI 和后台都不能自行重复打开数据库 |
| `src/ui/useMoose.ts`               | 订阅应用级 owner；卸载只释放 UI 引用，不能关闭仍有后台运行的 engine                       |
| `src/platform/` 与本地 Expo module | 启动确认、通知、停止意图、运行预算、wake lock 和服务状态查询；iOS 返回不支持              |
| `index.ts`                         | 在 React 挂载之外注册 Headless JS 入口，且不重复调用 `resume()` 或再次提交同一任务        |
| `src/runtime/engine.ts`            | 暴露所有活跃运行的生命周期和取消接口，服务持有集合而非只跟踪当前选中会话                  |
| Expo 配置                          | 可重复生成的权限、非导出 service、通知渠道；原生依赖变化后重编译客户端                    |

前台发送与后台执行不得各维护一份调度器。多个会话共享服务，以运行集合或引用计数决定何时停止；旧任务的迟到结束事件不能停掉新任务的服务。服务失败要释放已取得的资源，让用户选择前台继续，不显示虚假的“后台运行中”。

首版建议 `START_NOT_STICKY`，不从 boot receiver 自动重启。通知停止由原生入口记录不含凭据的停止意图，并交给唯一 owner 取消关联运行和重复任务的后续调度；JS 无响应时，原生预算到期仍须释放服务。系统强停可能没有回调，下次启动结合退出原因与持久化标记处理，不得盲目恢复用户明确停止的运行。[Android 用户停止行为](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping)需独立测试。

重复任务的等待间隔不持续占用服务；首版退出服务后仍沿用回前台恢复。要让后台等待到期自动启动下一轮，需要另行设计合法唤醒与调度。网络断线时有界退避，禁止无限忙重试；保留原 requestId，并说明恢复可能重新请求模型。OAuth 刷新与退出保持现有串行约束，锁屏读凭据失败时暂停并提示解锁，不降低安全存储级别。

## 为什么不先用其他方案

`expo-background-task` / WorkManager 适合系统择机调度，不适合维持当前 SSE 和 JS 执行栈。[长运行 Worker](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running)虽可使用 FGS，但 Android 16 起仍受 JobScheduler 配额影响；当前需求更适合直接 service。KeepAwake 只影响屏幕休眠，后台定时器库也不提供系统执行资格。第三方 FGS 库可以作为原型候选，但需先验证此项目的依赖组合、类型声明、通知取消和 runtime 复用，不能仅凭库的功能描述选型。

如果目标升级为“手机关机、强停、长时间离线后 Agent 仍推进”，需要远程 Host 承载 Harness，手机只同步状态。FGS 无法实现这一承诺；远端也需要另外设计凭据、费用与文件工作区归属。

## 实施顺序与验收

先验证 Kotlin FGS、Headless JS、受控 SSE 和单个 runtime 的最小原型，再接入真实 Pi 工具循环与应用级 owner，最后完善交互和分发。下表全部是待执行验收，不是本轮测试结果。

| 检查                                                 | 可观察的通过条件                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 受控 SSE，每秒一个事件，持续十分钟                   | 按 Home 和切应用后服务端持续收到同一连接的消费证据；客户端结果完整落库，回前台不重复提交 |
| SSE 完成后调用文件工具，再请求下一轮                 | 后台确实执行完整 Agent 循环，文件内容和最终回答正确                                      |
| 锁屏三十分钟、默认电池策略、强制 Doze                | 分开记录普通息屏与深度 Doze；后者允许中断，但必须及时识别并正确恢复                      |
| 多会话、快速切前后台、旋转或 Activity 重建           | 每个数据库仅一个 Harness，无重复计费请求或旧结束事件误停新服务                           |
| 通知停止、超时、启动失败、通知拒绝                   | 停止与降级可解释，任务状态持久化，无遗留锁或服务                                         |
| 网络切换、断网、OAuth 刷新失败                       | 有界重试，错误可见，无重复入队或凭据泄漏                                                 |
| 最近任务划掉、系统杀进程、活动应用面板停止、设置强停 | 分开记录行为；明确停止不自动复活，异常中断从提交点恢复                                   |
| 重复任务到期、设备重启                               | 不集中补跑，不暗中启动无授权服务                                                         |

在 Android 12、13、14、15、16 及可获得的 Android 17 设备上覆盖对应启动、通知、类型和配额行为；最低支持版本以实施时生成的 manifest 为准。至少一台 Pixel 和一台有厂商省电策略的实机使用发布构建、脱离 Metro 和调试器测试，记录电量、温度、连接次数、提交 ID、阶段时间和取消结果，不记录敏感内容。Doze 可使用 `adb shell dumpsys deviceidle force-idle`，完成后 `unforce`；强停和活动应用面板停止应分别测试。

本轮只核对基线源码与官方资料，并检查文档格式和本地引用。未实现服务，未运行行为测试、发布资源导出或原生编译，未做模拟器／实机后台测试、真实账户授权或计费模型请求。进入实现 PR 后，运行时改动需执行 `npm run verify`，配置与依赖改动还需 `npx expo-doctor`，随后执行上述原生验收；仅通过 Node 测试不能证明后台运行成立。
