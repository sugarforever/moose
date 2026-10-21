const {
  withAndroidManifest,
  withDangerousMod,
} = require("expo/config-plugins");
const { mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
module.exports = function withTermuxNetwork(config) {
  config = withAndroidManifest(config, (result) => {
    const application = result.modResults.manifest.application[0];
    application.$["android:networkSecurityConfig"] =
      "@xml/moose_network_security_config";
    return result;
  });
  return withDangerousMod(config, [
    "android",
    async (result) => {
      const directory = join(
        result.modRequest.platformProjectRoot,
        "app/src/main/res/xml",
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "moose_network_security_config.xml"),
        '<?xml version="1.0" encoding="utf-8"?>\n<network-security-config>\n  <base-config cleartextTrafficPermitted="false" />\n  <domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain></domain-config>\n</network-security-config>\n',
      );
      const debugDirectory = join(
        result.modRequest.platformProjectRoot,
        "app/src/debug/res/xml",
      );
      await mkdir(debugDirectory, { recursive: true });
      await writeFile(
        join(debugDirectory, "moose_network_security_config.xml"),
        '<?xml version="1.0" encoding="utf-8"?>\n<network-security-config><base-config cleartextTrafficPermitted="true" /></network-security-config>\n',
      );
      return result;
    },
  ]);
};
