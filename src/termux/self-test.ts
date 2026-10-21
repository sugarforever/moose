import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { TermuxEnvironment, type Rpc } from "./environment";
export type SelfTestPhase = "connect" | "write" | "read" | "bash" | "cleanup";
/** Only touches a fresh directory in a reserved, non-conversation workspace. */
export async function runTermuxSelfTest(
  rpc: Rpc,
  id: string,
  context: Context,
  onPhase: (phase: SelfTestPhase) => void,
) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id))
    throw new Error("Invalid diagnostic directory");
  const env = new TermuxEnvironment(`diagnostics-${id}`, rpc);
  let failure: unknown;
  try {
    onPhase("connect");
    getOrThrow(await env.connect(context));
    getOrThrow(await env.createDir(id, undefined, context));
    onPhase("write");
    getOrThrow(await env.writeFile(`${id}/hello.txt`, "hello", context));
    onPhase("read");
    if (
      getOrThrow(await env.readTextFile(`${id}/hello.txt`, context)) !== "hello"
    )
      throw new Error("Termux self-test read mismatch");
    onPhase("bash");
    let output = "";
    const result = getOrThrow(
      await env.exec(
        ["bash", "-c", "cat hello.txt"],
        {
          cwd: id,
          timeout: 5,
          onOutput: (text, _ctx, info) => {
            if (info.stream === "stdout") output += text;
          },
        },
        context,
      ),
    );
    if (result.exitCode !== 0 || output !== "hello")
      throw new Error("Termux self-test bash failed");
  } catch (error) {
    failure = error;
  }
  onPhase("cleanup");
  try {
    getOrThrow(
      await env.remove(
        id,
        { recursive: true, force: true },
        BACKGROUND_CONTEXT,
      ),
    );
  } catch (error) {
    failure ??= error;
  }
  try {
    await env.cleanup(BACKGROUND_CONTEXT);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  context.abortSignal?.throwIfAborted();
}
