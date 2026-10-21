import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import configure from "../app.config.js";

const apk = process.argv[2];
if (!apk || !/^[\w.-]+\.apk$/.test(basename(apk)))
  throw new Error("Provide one APK path");
const { expo } = JSON.parse(
  await readFile(new URL("../app.json", import.meta.url), "utf8"),
);
const config = configure({ config: expo });
const size = (await stat(apk)).size;
if (!size || size >= 2 ** 31) throw new Error("Invalid APK size");
const hash = createHash("sha256");
for await (const chunk of createReadStream(apk)) hash.update(chunk);
await writeFile(
  join(dirname(apk), "moose-update.json"),
  JSON.stringify(
    {
      schema: 1,
      package: config.android.package,
      version: config.version,
      versionCode: config.android.versionCode,
      apk: basename(apk),
      size,
      sha256: hash.digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
