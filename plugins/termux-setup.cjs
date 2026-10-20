const {
  withAndroidManifest,
  withDangerousMod,
} = require("expo/config-plugins");
const { mkdir, copyFile } = require("node:fs/promises");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
module.exports = function withTermuxSetup(config) {
  config = withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    const permission = "com.termux.permission.RUN_COMMAND";
    manifest["uses-permission"] ??= [];
    if (
      !manifest["uses-permission"].some(
        (item) => item.$["android:name"] === permission,
      )
    )
      manifest["uses-permission"].push({ $: { "android:name": permission } });
    manifest.queries ??= [];
    if (
      !manifest.queries.some((item) =>
        item.package?.some((pkg) => pkg.$["android:name"] === "com.termux"),
      )
    ) {
      const queries = manifest.queries[0] ?? (manifest.queries[0] = {});
      queries.package ??= [];
      queries.package.push({ $: { "android:name": "com.termux" } });
    }
    const app = manifest.application[0];
    app.receiver ??= [];
    const receiver = "expo.modules.moosetermux.SetupResultReceiver";
    if (!app.receiver.some((item) => item.$["android:name"] === receiver))
      app.receiver.push({
        $: { "android:name": receiver, "android:exported": "false" },
      });
    return result;
  });
  return withDangerousMod(config, [
    "android",
    async (result) => {
      const root = result.modRequest.projectRoot;
      execFileSync(
        process.execPath,
        [join(root, "scripts/bundle-termux.mjs")],
        { cwd: root, stdio: "inherit" },
      );
      const assets = join(
        result.modRequest.platformProjectRoot,
        "app/src/main/assets",
      );
      await mkdir(assets, { recursive: true });
      await copyFile(
        join(root, "dist/termux/service.mjs"),
        join(assets, "moose-termux-service.mjs"),
      );
      return result;
    },
  ]);
};
