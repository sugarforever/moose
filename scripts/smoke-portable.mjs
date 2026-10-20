import { build } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const { outputFiles } = await build({
  entryPoints: ["src/generated/runtime.js"],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "MooseRuntime",
  write: false,
});
// Deliberately no process, Buffer, require, filesystem or Node module loader in this realm.
const realm = createContext({
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  crypto: {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  },
  TextEncoder,
  TextDecoder,
  AbortController,
  AbortSignal,
  URL,
  URLSearchParams,
  Headers,
  Request,
  Response,
  Blob,
  File,
  FormData,
  ReadableStream,
  TransformStream,
  performance,
  structuredClone,
  atob,
  btoa,
});
runInContext(outputFiles[0].text, realm);
assert.equal(runInContext("typeof process", realm), "undefined");
assert.equal(runInContext("typeof Buffer", realm), "undefined");
const api = realm.MooseRuntime;
const secrets = new Map();
let authTime = 1000;
const subscriptionToken = `h.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "portable-account" } }))}.s`;
const auth = new api.CodexAuth(
  {
    get: async (key) => secrets.get(key) ?? null,
    set: async (key, value) => {
      secrets.set(key, value);
    },
    remove: async (key) => {
      secrets.delete(key);
    },
  },
  async (input) => {
    const url = String(input);
    if (url.endsWith("/deviceauth/usercode"))
      return Response.json({
        device_auth_id: "portable-device",
        user_code: "TEST-ONLY",
        interval: 1,
      });
    if (url.endsWith("/deviceauth/token"))
      return Response.json({
        authorization_code: "portable-code",
        code_verifier: "portable-verifier",
      });
    if (url.endsWith("/oauth/token"))
      return Response.json({
        access_token: subscriptionToken,
        refresh_token: "portable-refresh",
        expires_in: 3600,
      });
    throw new Error("Unexpected auth URL");
  },
  {
    now: () => authTime,
    sleep: async (ms) => {
      authTime += ms;
    },
  },
);
const authSignal = new AbortController().signal;
await auth.complete(await auth.begin(authSignal), authSignal);
assert.equal((await auth.status()).connected, true);
const sqlite = new DatabaseSync(":memory:");
const database = new api.SerialSqliteDatabase({
  execAsync: async (sql) => {
    sqlite.exec(sql);
  },
  runAsync: async (sql, ...params) => {
    sqlite.prepare(sql).run(...params);
  },
  getFirstAsync: async (sql, ...params) =>
    sqlite.prepare(sql).get(...params) ?? null,
  getAllAsync: async (sql, ...params) => sqlite.prepare(sql).all(...params),
  closeAsync: async () => sqlite.close(),
});
const response = {
  id: "resp_smoke",
  object: "response",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_smoke",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Portable runtime works",
          annotations: [],
        },
      ],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 4, total_tokens: 5 },
};
const events = [
  {
    type: "response.created",
    response: { ...response, status: "in_progress", output: [] },
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...response.output[0], content: [] },
  },
  {
    type: "response.content_part.added",
    item_id: "msg_smoke",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  },
  {
    type: "response.output_text.delta",
    item_id: "msg_smoke",
    output_index: 0,
    content_index: 0,
    delta: "Portable runtime works",
  },
  {
    type: "response.output_text.done",
    item_id: "msg_smoke",
    output_index: 0,
    content_index: 0,
    text: "Portable runtime works",
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: response.output[0],
  },
  { type: "response.completed", response },
];
let calls = 0;
const models = api.createMobileModels(
  async () => "local-test-key",
  async (input, init) => {
    calls++;
    const request = new Request(input, init);
    if (request.url.includes("chatgpt.com")) {
      assert.equal(
        request.url,
        "https://chatgpt.com/backend-api/codex/responses",
      );
      assert.equal(
        request.headers.get("chatgpt-account-id"),
        "portable-account",
      );
      assert.equal(request.headers.get("content-encoding"), null);
      assert.equal((await request.json()).stream, true);
    }
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
  (signal) => auth.getAccessToken(signal),
);
const capabilityNative = new DatabaseSync(":memory:");
const capabilityDatabase = new api.SerialSqliteDatabase({
  execAsync: async (sql) => {
    capabilityNative.exec(sql);
  },
  runAsync: async (sql, ...p) => {
    capabilityNative.prepare(sql).run(...p);
  },
  getFirstAsync: async (sql, ...p) =>
    capabilityNative.prepare(sql).get(...p) ?? null,
  getAllAsync: async (sql, ...p) => capabilityNative.prepare(sql).all(...p),
  closeAsync: async () => capabilityNative.close(),
});
const capabilities = new api.CapabilityService({
  openDatabase: async () => capabilityDatabase,
  skills: async () => [
    {
      id: "portable",
      name: "Portable",
      instructions: "Test",
      description: "",
      source: "https://example.com/SKILL.md",
      installedAt: 0,
    },
  ],
  authorize: async () => true,
  fetcher: async () => new Response('{"items":[{"id":1,"cost":"5.5"}]}'),
});
try {
  const invoke = (name, args) =>
    capabilities.execute(
      name,
      { skillId: "portable", ...args },
      { conversationId: 1, signal: new AbortController().signal },
    );
  await invoke("database_schema", {
    operationId: "schema",
    tables: [
      {
        name: "players",
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true },
          { name: "cost", type: "REAL" },
        ],
      },
    ],
  });
  const body = await invoke("http_request", {
    url: "https://example.com/bootstrap",
  });
  const args = {
    operationId: "import",
    bodyRef: body.bodyRef,
    table: "players",
    select: ["items"],
    columns: {
      id: { path: ["id"], type: "number" },
      cost: { path: ["cost"], type: "number" },
    },
  };
  const receipt = await invoke("json_import", args);
  assert.equal(receipt.rows, 1);
  assert.equal(
    JSON.stringify(await invoke("json_import", args)),
    JSON.stringify(receipt),
  );
  assert.equal(
    (await invoke("database_query", { table: "players" })).rows[0].cost,
    5.5,
  );
  console.log(
    "PASS: native tools HTTP reference → JSON import → SQLite query/replay without Node globals or crypto.randomUUID.",
  );
} finally {
  await capabilities.close();
}

const engine = await api.MobileEngine.open(database, models, {
  provider: "openai",
  modelId: "gpt-4.1-mini",
});
try {
  const chat = await engine.newConversation("Portable smoke");
  const request = await engine.submit(
    chat.id,
    "Hello without Node",
    "portable-smoke",
  );
  const result = await request.wait(engine.context);
  assert.equal(result.status, "done");
  assert.equal(calls, 1);
  assert.equal(
    (await engine.messages(chat.id)).at(-1).text,
    "Portable runtime works",
  );
  const checkpoint = await engine.checkpoint(chat.id, "portable");
  const branch = await engine.restoreCheckpoint(checkpoint.id);
  assert.equal(
    (await engine.messages(branch.id)).at(-1).text,
    "Portable runtime works",
  );
  await engine.configure(
    chat.id,
    { provider: "openai-codex", modelId: "gpt-5.6-luna" },
    [],
    [],
  );
  const codexSubmission = await engine.submit(
    chat.id,
    "Hello via subscription",
    "portable-codex",
  );
  assert.equal((await codexSubmission.wait(engine.context)).status, "done");
  assert.equal(calls, 2);
  await auth.logout();
  assert.equal(secrets.size, 0);
  console.log(
    "PASS: Pi Durable + SQLite + checkpoints + device auth + Codex SSE without Node globals. No real accounts or paid requests.",
  );
} finally {
  await engine.close();
}
