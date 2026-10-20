import { CapabilityService } from "../generated/runtime";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { Artifact } from "../capabilities/service";

/** Explicit developer fixture. No user DB, real credentials or paid model transport. */
export async function runCapabilitySmoke(
  openDatabase: (key: string) => Promise<SqliteDatabase>,
) {
  const checks: string[] = [];
  const assert = (condition: unknown, label: string) => {
    if (!condition) throw new Error(label);
    checks.push(label);
  };
  const skill = {
    id: "native-capability-smoke",
    name: "Native smoke",
    description: "",
    source: "https://example.com/SKILL.md",
    instructions: "Use tools",
    installedAt: 0,
  };
  const options = {
    openDatabase,
    skills: async (id: number) => (id === 3 ? [] : [skill]),
    authorize: async () => true,
    fetcher: async () => {
      const text = JSON.stringify({
        elements: [
          { id: 1, name: "Player A", cost: "5.5" },
          { id: 2, name: "Player B", cost: "6" },
        ],
      });
      const response = new Response(text, {
        headers: { "content-type": "application/json" },
      });
      if (!response.body)
        Object.defineProperty(response, "body", {
          value: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(text));
              c.close();
            },
          }),
        });
      return response;
    },
  };
  let service = new CapabilityService(options);
  const context = { conversationId: 1, signal: new AbortController().signal };
  const invoke = (name: string, args: Record<string, unknown>) =>
    service.execute(name, { skillId: skill.id, ...args }, context);
  let artifact: Artifact | undefined;
  try {
    await invoke("database_schema", {
      operationId: "schema",
      tables: [
        {
          name: "players",
          columns: [
            { name: "id", type: "INTEGER", primaryKey: true },
            { name: "name", type: "TEXT" },
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
      table: "players",
      bodyRef: body.bodyRef,
      select: ["elements"],
      columns: {
        id: { path: ["id"], type: "number" },
        name: { path: ["name"], type: "string" },
        cost: { path: ["cost"], type: "number" },
      },
    };
    const receipt = await invoke("json_import", args);
    assert(receipt.rows === 2, "Native SQLite: transactional JSON import");
    const result = await invoke("database_query", {
      table: "players",
      columns: ["name", "cost"],
      orderBy: "cost",
      descending: true,
      limit: 1,
    });
    assert(
      JSON.stringify(result.rows) === '[{"name":"Player B","cost":6}]',
      "Native SQLite: bounded parameterized query",
    );
    try {
      await invoke("database_write", {
        operationId: "bad-batch",
        table: "players",
        rows: [{ id: 3, name: "Rollback" }, { id: "invalid" }],
      });
      throw new Error("Expected rollback");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "database"
      )
        throw error;
    }
    const after = await invoke("database_query", { table: "players" });
    assert(
      (after.rows as unknown[]).length === 2,
      "Native SQLite: failed batch rolls back",
    );
    await invoke("document_write", {
      name: "squad.json",
      text: '{"players":[1,2]}',
      operationId: "squad",
    });
    assert(
      (await invoke("document_read", { name: "squad.json" })).text ===
        '{"players":[1,2]}',
      "Shared document save/read",
    );
    const saved = await invoke("artifact_create", {
      operationId: "report",
      title: "Native report",
      mime: "text/html",
      text: '<h1>Moose tools verified</h1><p>2 players imported.</p><script>document.body.innerHTML="UNSAFE SCRIPT"</script><img src="https://example.com/blocked.png"><a href="https://example.com/blocked">External navigation blocked</a>',
    });
    artifact = await service.artifact(1, String(saved.ref));
    assert(
      artifact.text.includes("2 players imported"),
      "Artifact persists with a usable reference",
    );
    await service.close();
    service = new CapabilityService(options);
    assert(
      JSON.stringify(await invoke("json_import", args)) ===
        JSON.stringify(receipt),
      "Committed import receipt survives reopen and replays",
    );
    assert(
      (await service.artifacts(1)).some((a) => a.ref === saved.ref),
      "Artifact discoverable after SQLite reopen",
    );
    assert(
      (
        await service.execute(
          "document_read",
          { skillId: skill.id, name: "squad.json" },
          { ...context, conversationId: 2 },
        )
      ).text === '{"players":[1,2]}',
      "Shared document reopens across conversations",
    );
    const localContext = { ...context, conversationId: 3 };
    const localBody = await service.execute(
      "http_request",
      { url: "https://example.com/bootstrap" },
      localContext,
    );
    assert(
      typeof localBody.bodyRef === "string",
      "General HTTP works without installed Skills",
    );
    const localArtifact = await service.execute(
      "artifact_create",
      {
        title: "Local report",
        mime: "text/plain",
        text: "Conversation only",
        operationId: "local-report",
      },
      localContext,
    );
    assert(
      (await service.artifacts(3)).some((a) => a.ref === localArtifact.ref) &&
        !(await service.artifacts(1)).some((a) => a.ref === localArtifact.ref),
      "General artifact is discoverable and conversation-isolated",
    );
    return { checks, artifact };
  } finally {
    await service.close();
  }
}
