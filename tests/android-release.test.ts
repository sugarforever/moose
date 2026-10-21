import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("publishes a manifest matching the APK bytes and native build identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moose-release-"));
  try {
    const apk = join(directory, "app-release.apk");
    await writeFile(apk, "apk-fixture");
    execFileSync(process.execPath, ["scripts/android-release.mjs", apk], {
      env: { ...process.env, MOOSE_VERSION: "0.2.0", MOOSE_BUILD_NUMBER: "15" },
    });
    expect(
      JSON.parse(await readFile(join(directory, "moose-update.json"), "utf8")),
    ).toEqual({
      schema: 1,
      package: "dev.verysmallwoods.moose",
      version: "0.2.0",
      versionCode: 15,
      apk: "app-release.apk",
      size: 11,
      sha256: createHash("sha256").update("apk-fixture").digest("hex"),
    });
    const config = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify(require('./app.config.js')({config:require('./app.json').expo})))",
        ],
        {
          env: {
            ...process.env,
            MOOSE_VERSION: "0.2.0",
            MOOSE_BUILD_NUMBER: "15",
          },
          encoding: "utf8",
        },
      ),
    );
    expect(config.version).toBe("0.2.0");
    expect(config.android.versionCode).toBe(15);
    expect(config.android.package).toBe("dev.verysmallwoods.moose");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["0", "1.5", "not-a-build", "2100000001"])(
  "rejects invalid native build numbers %s",
  (build) => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "-e",
          "require('./app.config.js')({config:require('./app.json').expo})",
        ],
        {
          env: { ...process.env, MOOSE_BUILD_NUMBER: build },
          stdio: "pipe",
        },
      ),
    ).toThrow();
  },
);
