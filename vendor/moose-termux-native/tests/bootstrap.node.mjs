import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(
  new URL(
    "../android/src/main/assets/moose-termux-bootstrap.sh",
    import.meta.url,
  ),
);
for (const valid of [true, false])
  test(`actual bootstrap ${valid ? "deploys verified bytes" : "rejects checksum mismatch"}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "moose-bootstrap-"));
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "flock"),
      "#!/usr/bin/env python3\nimport sys,fcntl\ntry: fcntl.flock(int(sys.argv[-1]),fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)\n",
      { mode: 0o700 },
    );
    // Controlled Node boundary: version check succeeds, service invocation records its args.
    await writeFile(
      join(bin, "node"),
      '#!/bin/bash\nif [ "$1" = -e ]; then exit 0; fi\nprintf "%s\\n" "$@" > "$HOME/launched"\n',
      { mode: 0o700 },
    );
    const bytes = Buffer.from("bundled service bytes");
    const server = createServer((_req, res) => res.end(bytes));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const hash = valid
      ? createHash("sha256").update(bytes).digest("hex")
      : "0".repeat(64);
    try {
      const child = spawn(
        "bash",
        [
          script,
          `http://127.0.0.1:${server.address().port}/token`,
          hash,
          "a".repeat(64),
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            PATH: `${bin}:${process.env.PATH}`,
          },
        },
      );
      const exit = await new Promise((resolve) => child.on("close", resolve));
      assert.equal(exit, valid ? 0 : 27);
      if (valid) {
        assert.deepEqual(
          await readFile(join(home, ".moose-termux/service.mjs")),
          bytes,
        );
        for (let n = 0; n < 100; n++) {
          try {
            const args = await readFile(join(home, "launched"), "utf8");
            assert.match(args, /service\.mjs\na{64}\n/);
            break;
          } catch (error) {
            if (n === 99) throw error;
            await new Promise((r) => setTimeout(r, 10));
          }
        }
      } else
        await assert.rejects(readFile(join(home, ".moose-termux/service.mjs")));
      await assert.rejects(access(join(home, ".moose-termux/.install-lock")));
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
