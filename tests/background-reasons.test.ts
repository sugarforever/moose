import { expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({
  pendingStop: vi.fn(() => true),
  stopDetail: vi.fn(() => ({ reason: "budget_expired", at: 123 })),
  acknowledgeStop: vi.fn(),
}));
vi.mock("react-native", () => ({
  AppRegistry: {},
  AppState: {},
  PermissionsAndroid: {},
  Platform: { OS: "android" },
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => bridge }));
import { cancelInterruptedBackground } from "../src/platform/background";
it("preserves native reason/time and acknowledges only after durable cancellation succeeds", async () => {
  const cancel = vi.fn(async (_cause?: unknown) => {});
  await cancelInterruptedBackground(cancel);
  expect(cancel).toHaveBeenCalledWith({ reason: "budget_expired", at: 123 });
  expect(bridge.acknowledgeStop).toHaveBeenCalledTimes(1);
  bridge.acknowledgeStop.mockClear();
  await expect(
    cancelInterruptedBackground(async () => {
      throw new Error("storage offline");
    }),
  ).rejects.toThrow("storage offline");
  expect(bridge.acknowledgeStop).not.toHaveBeenCalled();
});
