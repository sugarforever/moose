# Android 后台执行真机验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证最新 Moose APK 在用户 Android 手机上的锁屏执行，按观测修复剩余问题。

**Architecture:** 保留主线 RuntimeOwner、ExecutionOwner、MooseExecutionService 和 Headless JS。先验证发布版本，补足受控真机／Release 验证入口，再依据失败证据做最小修复。

**Tech Stack:** 以当前主线锁文件为准，继续使用 Expo、React Native、Hermes、Pi Durable、SQLite 和已有可选工具环境。

**Spec:** [主线架构与真机验收](../../android-background-execution.md)。

## Global Constraints

- 源码基线为 a48d170309f8587c733a232f6d4fd12c7cc3d6c5；本地旧副本落后远端 55 个提交。
- 已有后台服务与执行所有权，复用现有模块，不创建第二套 RuntimeHost、服务或调度器。
- 现有连续预算 30 分钟、握手 15 秒、停止确认 10 秒；通知权限是准入条件，本轮不改这些策略。
- 重复任务等待不持服务，START_NOT_STICKY，无开机恢复或自动复活。
- 普通锁屏、Doze、网络断开、任务预算与 Termux 进程失效分开诊断。
- 自动验证使用隔离 SQLite／工作区与受控传输；真实账户请求由用户自行发起。
- 本 PR 只有方案和计划，不包含新 APK 或产品行为修改。

## Review Focus

- 运行的 APK 过旧：Task 1 记录实际版本，不用新主线解释旧 APK。
- 解锁后才执行：Task 3 用解锁前通知与持久化时间判断，不能凭答案最终出现判成功。
- 受控流与真实网络混淆：Task 2 分别验证内存流、Expo fetch 和真机路由。
- 有界执行被误判为锁屏故障：Task 3 单独验证 30 分钟预算与通知停止原因。
- Termux 失效误归 Moose：Task 3 将设备文件环境与 Termux 分开测试。

### Task 1: 核对当前基线与用户测试包

**Files:** Read `package.json`、`src/runtime/execution-owner.ts`、`src/platform/background.ts`、`modules/moose-background/android/src/main/java/dev/verysmallwoods/background/MooseExecutionService.kt`、`docs/background-recovery.md`；后续 Create `docs/android-device-validation.md`。

**Interfaces:** 测试记录包含版本、源码 SHA、设备型号、系统版本、通知授权、电池策略、工具环境、是否开发客户端。

- [x] 核对最新 origin/main，确认已有后台所有权和原生执行服务；校正此前尚未提交的旧架构计划。
- [x] 核对 v0.8.0 发布页，确认存在 app-release.apk；此步骤不等于安装或验证该 APK。
- [ ] 用户确认手机安装版本。需要更新时使用[发布页](https://github.com/sugarforever/moose/releases/tag/v0.8.0)中的 APK，优先覆盖安装，避免卸载删除数据。
- [ ] 新建真机记录，待测项目全部标为未执行；不复制历史模拟器通过结果。

### Task 2: 准备无需模型账户的受控真机验证构建

**Files:** Modify `index.ts`、`src/dev/BackgroundSmoke.tsx`、`scripts/background-probe-server.mjs`、`.github/workflows/build.yml`；Create `tests/background-probe-config.test.ts`、`src/dev/background-probe-config.ts`。

**Interfaces:** `backgroundProbeConfig(env: Readonly<Record<string, string | undefined>>): { enabled: boolean; endpoint: string | null }`。仅专用诊断构建可 enabled；生产构建为 false。真机端点固定为 http://127.0.0.1:8106/，模拟器保留 http://10.0.2.2:8106/，由显式构建选项选择，运行时不能接受任意地址。

- [ ] 先写配置回归：生产构建不启用诊断入口、专用 Release 诊断构建启用、仅允许两个固定受控端点、缺配置拒绝运行网络探针。确认失败后实现解析。
- [ ] 将探针准入从单纯 **DEV** 改成显式专用构建选择；正常发布仍打开 App。测试包使用独立应用 ID 和名称，避免覆盖正常 Moose；沿用独立 background-smoke.sqlite 和受限工作区。
- [ ] 真机通过 USB 运行 `adb reverse tcp:8106 tcp:8106`，主机端运行现有 probe server；验证 Expo fetch 实际经过受控网络。服务器只返回固定 fixture，不连接模型、不接受／记录真实凭据。
- [ ] 增加请求计数和请求关联的最小控制协议回归，再实现所需观测；读最终提交时间、工作区结果和请求数，证明解锁前完成。内存流单独标识。
- [ ] 手动诊断构建工作流输出独立 APK，普通 tag 发布不带诊断入口；明确 EXPO_PUBLIC 值会编入 JS，不能包含秘密。
- [ ] 运行目标测试、typecheck、bundle、原生编译和 Release 启动验证后，单独提交这项代码变更并提供测试 APK。当前文档 PR 不宣称这些步骤已完成。

### Task 3: 用户执行手机验收

**Files:** Update `docs/android-device-validation.md`；参考 `docs/background-recovery.md`。

**Interfaces:** 每项记录开始时间、锁屏／后台时间、解锁时间、完成时间、结果状态、服务通知和错误原因。截图遮去会话正文与账户信息。

- [ ] 正常发布 APK 先做短任务，确认通知可见、后台完成提示和打开结果正确。此轮正常聊天由用户主动发起，注明是否消耗模型额度。
- [ ] 专用受控构建运行 5／10 分钟锁屏探针；等待超过延时后先观察锁屏通知，再解锁读取已保存结果和最终提交时间。
- [ ] 运行两个并发探针、通知停止、拒绝通知权限、Activity 重建；分别核对服务共享、取消范围和无重复输入。
- [ ] 单独验证 30 分钟预算到期、断网／恢复、进程回收后重开、系统 Stop 和 force-stop；保留 first cancellation reason。
- [ ] 先选设备文件环境，再选 Termux 并运行现有无模型自检，分别验证；重复任务按现有后台等待语义记录，不期待精确唤醒。
- [ ] 可连接 adb 时核对 dumpsys activity services 和 dumpsys power；强制 Doze 由开发者执行并在结束后 unforce。用户手动锁屏结果不写成强制 Doze 测试。
- [ ] 测试结束移除 adb reverse，恢复测试中改动的网络／省电设置，记录空闲资源释放和实际耗电观察。

### Task 4: 按失败层定位并补回归

**Files:** 只修改证据所指模块及其现有测试：`tests/background.test.ts`、`tests/background-platform.test.ts`、`tests/background-reasons.test.ts`、`tests/background-sse.test.ts`、`tests/execution-recovery.test.ts`，或原生服务相关文件。

**Interfaces:** 每个修复需要失败用例、明确根因、最小变化和同设备复测结果。

- [ ] 把失败定位到准入、JS 生命周期、模型传输、服务预算、持久化或 Termux，区分实际错误和当前产品边界。
- [ ] 先用真实 Harness／SQLite 或原生受控探针复现；回归失败后实现最小修复，不按旧计划重复引入 Host。
- [ ] 新代码运行目标回归；涉及 runtime 时重新 bundle。恢复不得改变 requestId、自动重放未知副作用或无限重试。
- [ ] 单独提交可审查的修复，再提供对应 APK，重复最初失败的手机用例。

### Task 5: 完整检查与交付

**Files:** Update `docs/android-device-validation.md`、`docs/background-recovery.md`；能力变化时同步 `README.md`。

- [ ] 有代码变更时运行 npm run verify、Expo Doctor、改动文件 Prettier 和 Android 原生编译。仅文档变更核对格式、引用和事实即可。
- [ ] 分别报告行为测试、Hermes 发布资源导出、原生构建、模拟器、真机和真实模型请求。未执行保留未执行，不复用历史结果。
- [ ] 交付记录明确适用手机、系统、电池设置、30 分钟预算、重复任务边界和剩余问题。没有真机结果时不宣称锁屏问题解决。

## 本轮状态

本轮完成主线核查、架构校正和验证计划。用户可以承担真机操作；受控 Release 测试包仍待 Task 2 实现。保留原工作区业务改动，PR 仅包含这两份文档。
