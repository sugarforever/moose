import { expect, it, vi } from "vitest";
vi.mock("react-native", () => ({
  AppRegistry: {},
  AppState: { currentState: "active" },
  PermissionsAndroid: {},
  Platform: { OS: "ios" },
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
import {
  acquireBackground,
  fenceRuntimeChange,
} from "../src/platform/background";
it("a rejected overlapping environment change cannot clear the first admission fence", async () => {
  fenceRuntimeChange(true);
  try {
    expect(() => fenceRuntimeChange(true)).toThrow("already changing");
    await expect(acquireBackground()).rejects.toThrow(
      "environment is changing",
    );
  } finally {
    fenceRuntimeChange(false);
  }
  const lease = await acquireBackground();
  expect(lease.signal.aborted).toBe(false);
  await lease.release();
});
