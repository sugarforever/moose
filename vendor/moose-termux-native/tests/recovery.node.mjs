import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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
const waitFor = async (fn) => {
  for (let n = 0; n < 200; n++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("condition timed out");
};
// macOS has BSD flock(2), but no util-linux CLI. This adapter exercises actual
// kernel open-file-description locks on inherited shell descriptors.
const flockShim =
  "#!/usr/bin/env python3\nimport sys,fcntl\ntry: fcntl.flock(int(sys.argv[-1]),fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)\n";
test("SIGKILL installer and service release kernel locks for retry", async () => {
  const home = await mkdtemp(join(tmpdir(), "moose-recovery-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "flock"), flockShim, { mode: 0o700 });
  await writeFile(
    join(bin, "node"),
    `#!/bin/bash\nif [ "$1" = -e ]; then exit 0; fi\nexec '${process.execPath}' "$@"\n`,
    { mode: 0o700 },
  );
  const bytes = Buffer.from(
    `import{writeFileSync}from'node:fs';writeFileSync(process.env.HOME+'/pid',String(process.pid));setInterval(()=>{},1000);`,
  );
  let transfer = 0;
  let hang = true;
  let hanging;
  const server = createServer((_q, r) => {
    transfer++;
    if (!hang) r.end(bytes);
    else hanging = r;
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const start = () => {
    const p = spawn(
      "bash",
      [
        script,
        `http://127.0.0.1:${server.address().port}/token`,
        createHash("sha256").update(bytes).digest("hex"),
        "a".repeat(64),
      ],
      {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
        stdio: "ignore",
      },
    );
    p.done = new Promise((r) => p.on("exit", r));
    return p;
  };
  let pid;
  try {
    const installer = start();
    await waitFor(() => transfer === 1);
    const busy = start();
    assert.equal(await busy.done, 21);
    installer.kill("SIGKILL");
    await installer.done;
    hang = false;
    hanging.destroy();
    // Finish the controlled curl after its installer is killed. In production
    // curl has a 30-second bound; its inherited descriptor prevents overlap.
    await new Promise((r) => setTimeout(r, 100));
    const next = start();
    assert.equal(await next.done, 0);
    await waitFor(async () => {
      try {
        pid = Number(await readFile(join(home, "pid"), "utf8"));
        return true;
      } catch {
        return false;
      }
    });
    const concurrent = start();
    assert.equal(await concurrent.done, 23);
    process.kill(pid, "SIGKILL");
    pid = undefined;
    await new Promise((r) => setTimeout(r, 100));
    const retry = start();
    assert.equal(await retry.done, 0);
    await waitFor(async () => {
      const value = Number(await readFile(join(home, "pid"), "utf8"));
      try {
        process.kill(value, 0);
        pid = value;
        return true;
      } catch {
        return false;
      }
    });
  } finally {
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    server.closeAllConnections();
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});
