# Codex 浏览器回调接入

参考本地 rn-ai-kit 仓库、[issue #4](https://github.com/sugarforever/rn-ai-kit/issues/4) 和 [PR #5](https://github.com/sugarforever/rn-ai-kit/pull/5)。增加浏览器 OAuth + PKCE 作为现有设备码的另一条登录路径，复用同一 SecureStore、刷新和 Codex 推理通道。

## 实现与验收

1. 可移植认证层生成授权 URL、严格校验回调的 origin/path/state/重复参数，再用原始 verifier 换令牌；复用串行保存和取消回滚。
2. 平台层使用 react-native-tcp-socket 临时绑定 127.0.0.1:1455；监听就绪后才打开浏览器。仅接收有限大小的 GET 请求，错误 state 不消费登录。连接数、请求大小、空闲时间和总等待均有界。
3. iOS 使用应用内浏览器，Android 使用浏览器 tab；Android 浏览器打开调用会立即返回 opened，不能当作用户取消。完成、取消、超时、端口冲突均清理 listener。返回应用后保持等待，提供明确取消。
4. 先写协议和监听行为测试，再实现；执行完整检查、iOS 原生编译与模拟器本地合成回调测试。真实账户授权由用户完成，不能据合成回调声称账户可用。
5. 不依赖本机 rn-ai-kit，不改它的工作区；引用其思路与公开协议，自行实现最小适配。原生依赖意味着需 development build，不能使用 Expo Go。
