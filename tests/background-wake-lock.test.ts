import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

let classes: string;
beforeAll(() => {
  classes = mkdtempSync(join(tmpdir(), "moose-wake-lock-"));
  execFileSync(
    "javac",
    [
      "--release",
      "17",
      "-d",
      classes,
      resolve(
        "modules/moose-background/android/src/main/java/dev/verysmallwoods/background/ExecutionWakeLock.java",
      ),
      resolve("tests/support/ExecutionWakeLockHarness.java"),
    ],
    { stdio: "pipe" },
  );
});
afterAll(() => {
  if (classes) rmSync(classes, { recursive: true, force: true });
});

it.each([
  "long-run",
  "stop",
  "late-callback",
  "restart",
  "renewal-failure",
  "startup-failure",
])("runs the native wake-lock lifecycle: %s", (scenario) => {
  const result = execFileSync(
    "java",
    [
      "-cp",
      classes,
      "dev.verysmallwoods.background.ExecutionWakeLockHarness",
      scenario,
    ],
    { encoding: "utf8" },
  );
  expect(result.trim()).toBe("PASS");
});
