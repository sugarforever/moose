import { homedir } from "node:os";
import { resolve } from "node:path";
import { readdir, readFile, rename, mkdir } from "node:fs/promises";
import { startService } from "./server.ts";
import { unhex } from "../../src/termux/wire.ts";
const [key, action] = process.argv.slice(2);
if (!key || !/^[0-9a-f]{64}$/.test(key))
  throw new Error(
    "Usage: node service.mjs <Moose public pairing key> [acknowledge-interrupted]",
  );
const root = resolve(
  process.env.MOOSE_TERMUX_ROOT ?? resolve(homedir(), ".moose-termux"),
);
if (action === "acknowledge-interrupted") {
  const journal = resolve(root, ".requests");
  const archive = resolve(root, `.acknowledged-${Date.now()}`);
  await mkdir(archive, { recursive: true, mode: 0o700 });
  for (const name of await readdir(journal)) {
    let acknowledge = name.startsWith(".tmp-");
    try {
      const record = JSON.parse(await readFile(resolve(journal, name), "utf8"));
      acknowledge ||=
        typeof record.op !== "string" ||
        typeof record.workspace !== "string" ||
        (record.op === "exec" && !record.acknowledged);
    } catch {
      acknowledge = true;
    }
    if (acknowledge)
      await rename(resolve(journal, name), resolve(archive, name));
  }
  console.log(
    "Interrupted outcomes acknowledged. Inspect workspace side effects before issuing commands again.",
  );
}
const service = await startService({ root, publicKey: unhex(key) });
console.log(
  `Moose Termux service listening at ${service.url}. Shell has Termux UID permissions.`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void service.close().then(() => process.exit(0));
  });
