import type { Context } from "@earendil-works/chord";
import type { EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
export type MobileWorkspaceFactory = ((workspaceId: string) => ExecutionEnv) & {
  /** Explicit capability; never infer shell availability by trying a command. */
  shell?: boolean;
};

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
