import type { Context } from "@earendil-works/chord";
import type { EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
export type MobileWorkspaceFactory = (workspaceId: string) => ExecutionEnv;

/** Owned by one engine; Harness must finish its tools before this pool closes. */
export class MobileFileEnvironments {
  private environments = new Map<string, ExecutionEnv>();
  private closed = false;
  constructor(private factory: MobileWorkspaceFactory) {}
  get({ conversationId, cwd }: Pick<EnvTarget, "conversationId" | "cwd">) {
    if (this.closed) throw new Error("Filesystem environments are closed");
    const workspaceId = `moose-chat-${conversationId}`;
    let env = this.environments.get(workspaceId);
    if (!env) {
      env = this.factory(workspaceId);
      this.environments.set(workspaceId, env);
    }
    env.cwd = cwd ?? "/workspace";
    return env;
  }
  async close(context: Context) {
    this.closed = true;
    const environments = [...this.environments.values()];
    this.environments.clear();
    const results = await Promise.allSettled(
      environments.map((env) => env.cleanup(context)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

import { defineTool } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
export function workspaceListTool() {
  return defineTool({
    name: "workspace_list",
    description:
      "Enumerate a directory in this conversation's persistent private /workspace. Other conversations and checkpoint branches have separate files. Use read/write/edit for file content. Pages contain at most 100 entries.",
    parameters: Type.Object(
      {
        path: Type.Optional(Type.String({ maxLength: 1024 })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    outputLimits: { maxBytes: 32768 },
    async execute(args, api, context) {
      if (!api.env) throw new Error("Workspace unavailable");
      const entries = getOrThrow(
        await api.env.listDir(args.path ?? "/workspace", context),
      ).sort((a, b) => a.name.localeCompare(b.name));
      const offset = args.offset ?? 0;
      const text = JSON.stringify({
        scope: "conversation-private",
        entries: entries.slice(offset, offset + 100),
        nextOffset: offset + 100 < entries.length ? offset + 100 : null,
      });
      return { output: [{ type: "text", text }] };
    },
  });
}
