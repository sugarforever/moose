import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { installPromiseWithResolvers } from "../src/platform/compat";

it("fills only withResolvers and preserves the existing Hermes-compatible Promise constructor", async () => {
  const ExistingPromise = runInNewContext(
    "delete Promise.withResolvers; Promise",
  ) as PromiseConstructor;
  const originalThen = ExistingPromise.prototype.then;
  installPromiseWithResolvers(ExistingPromise);
  expect(ExistingPromise.prototype.then).toBe(originalThen);
  const gate = ExistingPromise.withResolvers<number>();
  gate.resolve(42);
  expect(await gate.promise).toBe(42);
  const failed = ExistingPromise.withResolvers<void>();
  failed.reject(new Error("cancelled"));
  await expect(failed.promise).rejects.toThrow("cancelled");
});
