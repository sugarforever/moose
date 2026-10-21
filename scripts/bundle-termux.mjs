import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("dist/termux", { recursive: true });
await build({
  entryPoints: ["components/termux-service/cli.ts"],
  outfile: "dist/termux/service.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
});
console.log(
  "Standalone Termux service: dist/termux/service.mjs (requires Node >=22.19, no npm install on device)",
);
