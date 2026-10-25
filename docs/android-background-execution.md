# Android 后台执行：主线架构与真机验收

核对日期：2026 年 10 月 25 日。源码基线：`a48d170309f8587c733a232f6d4fd12c7cc3d6c5`。实施与验收步骤见[工作计划](superpowers/plans/2026-10-25-android-background-execution.md)。

本轮最初方案基于落后远端 55 个提交的本地副本。同步读取远端后确认，单一进程级运行时、Android 前台服务、Headless JS、通知和中断恢复已经存在。本文取代此前尚未提交的重新建设方案，以当前主线为依据；本 PR 只更新方案和验证计划，不修改应用行为。

## 技术决定

继续使用 Expo 原生开发客户端与 Prebuild。沿用现有 React Native／Hermes、Pi Durable 和 SQLite，以及 `modules/moose-background`；不重新创建执行服务或第二个 RuntimeHost。Termux 和 iOS iSH 是当前已有的可选工具执行环境，保留原有边界。本设计不要求迁移框架或替换执行环境。

```text
Android 应用进程 / 现有 ReactContext / Hermes
  ├─ React Native 界面：观察已提交状态
  ├─ RuntimeOwner：唯一运行时所有者
  │    └─ MobileEngine / Pi Durable / SQLite
  └─ MooseExecutionService / Headless JS
       └─ ExecutionOwner：共享有限执行租约、通知、唤醒锁

可选工具环境：设备文件工具 / Termux
```

核心问题已经从“有没有后台执行资格”转为“当前 APK 在具体手机的省电和联网条件下是否可靠，以及失败停在哪一层”。模拟器记录是历史证据，真机不能直接沿用其结论。

## 当前源码的准确行为

| 位置                                                            | 主线实现与边界                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/runtime/execution-owner.ts`                                | RuntimeOwner 在进程内复用一次打开；ExecutionOwner 用 token 和引用计数共享服务租约，界面不拥有运行时关闭权。             |
| `src/platform/open.ts`、`src/platform/background.ts`            | 接入执行保护、待处理停止与通知观察；界面回到前台只刷新视图，不重新提交输入。                                            |
| `modules/moose-background/android/src/main/AndroidManifest.xml` | 服务类型为 specialUse，同进程、exported=false、stopWithTask=false。                                                     |
| `MooseExecutionService.kt`                                      | 复用既有 ReactContext，通过 HeadlessJsTaskContext 启动 MooseExecution；不创建第二个 ReactHost。                         |
| 服务时限                                                        | 每次连续服务会话预算 30 分钟；唤醒锁上限为预算加 15 秒；启动握手超时 15 秒。这是现有行为，本 PR 不改成 heartbeat 续租。 |
| 通知权限                                                        | Android 启动任务需要通知权限；拒绝时阻止执行并显示错误，运行中权限丢失触发取消。本 PR 不改变该产品决策。                |
| 通知停止                                                        | 停止所有回答和重复任务，先持久化停止原因，JS 确认取消后释放服务；10 秒未确认时终止进程，下次手动启动先处理停止标记。    |
| 重复任务等待                                                    | 等待期间不持有服务。后台到期时，只有已有其他活跃租约才继续，否则等待 Moose 可见。不作精确后台唤醒承诺。                 |
| 进程回收                                                        | START_NOT_STICKY；没有开机接收器或自动服务复活。用户重新打开后按持久状态恢复。                                          |
| 工具恢复                                                        | 未知副作用阻止后续修改，需用户明确检查并允许；保留安全重放边界，不能把断网恢复等同于重跑所有工具。                      |
| Termux                                                          | 独立应用进程，Moose 的服务不会替它保活。需要分别检查连接、自检和执行结果。                                              |
| iOS                                                             | 不从 Android 服务推导 iOS 后台能力；已有 iSH 工具环境不等于持续后台执行资格。                                           |

当前恢复、重试与通知语义以[后台恢复文档](background-recovery.md)为准。不要用本地旧副本的 AppState／engine.close 逻辑解释当前发布版本。

## 从作者公开资料得到的依据

作者的 Android 原型明确使用[前台服务](https://x.com/badlogicgames/status/2106485523317489902)，说明[锁屏后继续执行](https://x.com/badlogicgames/status/2111214825154179397)，并[复用 Termux 的部分实现](https://x.com/badlogicgames/status/2111366160205987847)，尤其是[后台进程能力](https://x.com/badlogicgames/status/2111369852111786259)。他的界面使用[内置 WebView](https://x.com/badlogicgames/status/2111385729368740337)。这些资料支持把执行生命周期移出界面，不能证明 Moose 必须换成相同框架。

系统规则仍需遵守：[Android 服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types)、[用户停止服务应用](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping)、[Doze](https://developer.android.com/training/monitoring-device-state/doze-standby)、[React Native Headless JS](https://reactnative.dev/docs/headless-js-android)。specialUse 的商店审核是未来发布条件，不代表后台联网或无限运行保证。

## 下一步：先验证发布版本，再针对证据改代码

用户已表示可以在 Android 真机验证。第一轮使用当前发布 APK，记录版本、手机型号、Android 版本、通知权限、电池策略和工具环境。先维持系统默认省电设置，出现问题后再单独改变一个设置比较；不自动要求电池优化豁免。

现有开发探针 `src/dev/BackgroundSmoke.tsx` 受 **DEV** 和环境变量共同限制，正式 Release APK 中不能靠设置环境变量打开它。内存受控 SSE 探针与真实 Expo fetch 网络探针也必须区分。后者当前固定连接模拟器地址 `10.0.2.2:8106`，真机需要专门的受控测试构建和明确的端口路由。

本 PR 不声称提供新的受控 Release 测试包。准备该测试包是后续可独立审查的代码变更，不能伪造已支持的构建命令。

## 真机验收表

| 场景             | 预期与需记录的证据                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| 普通切后台／锁屏 | 分别验证 5 分钟和 10 分钟；解锁前的完成通知或持久化完成时间证明后台已完成，不能只看解锁后出现答案。 |
| 多会话           | 两个任务共用服务；结束一个不会停止另一个，最后一个结束释放运行通知和唤醒锁。                        |
| Activity 重建    | 重新附加当前结果，无重复用户输入、模型准入或第二个 engine。                                         |
| 通知停止         | 全局取消，未产生完成结果提醒；再次打开不恢复已取消工作。                                            |
| 预算到期         | 单独验证 30 分钟预算，保留 budget_expired 原因；不能把它归为随机锁屏失败。                          |
| 断网与恢复       | 记录 attempt、重试次数和最终状态；认证、额度与用户取消不自动重试。                                  |
| 系统回收／强停   | 分开记录进程回收后重开、系统任务管理器 Stop 和设置 force-stop；没有自动复活承诺。                   |
| 重复任务         | 后台等待不会占服务；逾期不集中补跑；下一轮需要前台时应按现有规则等待。                              |
| Termux           | 先运行无模型自检，之后再验证工具环境；独立记录 Termux 不可用与 Moose 本身中断。                     |
| 空闲与耗电       | 无工作后服务／唤醒锁释放，30 分钟空闲不常驻；记录实际观察，不引用作者的低耗电体验作为结论。         |

自动化与受控验证不使用真实凭据、不转发模型请求。使用正常聊天验证可能消耗账户额度，应由用户自行发起并注明，这不构成代理执行真实计费请求的授权。

## 当前验证状态

本轮只读取远端源码、已有验证记录及发布资产，并核对文档。没有重新运行应用测试、Hermes 导出、原生编译、模拟器或真机测试，也没有真实模型请求。现有历史验证详见 background-recovery.md，不在此重复宣称通过。
