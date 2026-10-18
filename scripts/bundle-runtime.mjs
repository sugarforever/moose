import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

await mkdir("src/generated", { recursive: true });
const result = await build({
  entryPoints: ["src/runtime/portable-entry.ts"],
  outfile: "src/generated/runtime.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  metafile: true,
  legalComments: "eof",
  plugins: [
    {
      name: "disable-node-ambient-auth",
      setup(builder) {
        // SDK default ambient auth has a variable dynamic Node import. Mobile always supplies its own context.
        builder.onLoad({ filter: /pi-ai\/dist\/auth\/context\.js$/ }, () => ({
          contents:
            "export function defaultProviderAuthContext() { return { env: async () => undefined, fileExists: async () => false }; }",
        }));
        builder.onLoad(
          { filter: /pi-ai\/dist\/env-api-keys\.js$/ },
          async (args) => {
            const { readFile } = await import("node:fs/promises");
            const source = await readFile(args.path, "utf8");
            const constants = [
              ...source.matchAll(/export const (\w+) = "([^"]*)";/g),
            ]
              .map(
                (match) =>
                  `export const ${match[1]} = ${JSON.stringify(match[2])};`,
              )
              .join("\n");
            return {
              contents: `${constants}\nexport function findEnvKeys() { return []; }\nexport function getEnvApiKey() { return undefined; }`,
            };
          },
        );
        builder.onLoad(
          { filter: /pi-ai\/dist\/utils\/provider-env\.js$/ },
          () => ({
            contents:
              "export function getProviderEnvValue(name, env) { return env?.[name]; }",
          }),
        );
      },
    },
  ],
});
const inputs = Object.keys(result.metafile.inputs);
const forbidden = inputs.filter((path) =>
  /\/(oauth|codemode)\/|\/env\/node|storage\/(sqlite|jsonl)\/node|worker_threads|node_modules\/(http-proxy-agent|https-proxy-agent|@aws-sdk|@google)/.test(
    path,
  ),
);
if (forbidden.length)
  throw new Error(
    `Nonportable dependency in mobile bundle: ${forbidden.join(", ")}`,
  );
await writeFile(
  "src/generated/runtime.d.ts",
  "export * from '../runtime/portable-entry';\n",
);
await writeFile(
  "src/generated/dependency-audit.json",
  JSON.stringify({ piDurable: "1.3.0", inputs, forbidden }, null, 2),
);
console.log(
  `Portable runtime: ${inputs.length} modules, no Node adapters. ${Math.round(result.metafile.outputs["src/generated/runtime.js"].bytes / 1024)} KiB.`,
);
