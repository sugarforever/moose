// Development-only native verification; never bundled into Hermes.
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const cache = resolve(
  process.env.MOOSE_ISH_CACHE ?? join(tmpdir(), "moose-ish-embedded"),
);
const core = join(cache, "verification-host");
const run = (command, args, env = process.env) =>
  execFileSync(command, args, { stdio: "inherit", env });
run("python3", [
  "scripts/ish/build_embedded.py",
  "--cache",
  cache,
  "--sdk",
  "macosx",
  "--output",
  core,
]);
run("python3", ["scripts/ish/test_embedded.py", "--core", core]);
run("python3", ["modules/moose-ish/tests/run_bridge.py", "--core", core]);
run(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "tests/ish.test.ts",
    "tests/ish-native.test.ts",
  ],
  { ...process.env, MOOSE_ISH_CORE: core },
);
