import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTool } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import type { Skill } from "../skills/skills";
import { decodeFile, validSkillPath } from "../skills/bundle";

export function skillWorkspaceTool(
  skills: (conversationId: number) => Promise<Skill[]>,
) {
  return defineTool({
    name: "skill_workspace",
    description:
      "Copy an installed, enabled Skill folder into a fresh directory in this conversation's workspace. Returns the relative directory and file paths for read/bash. Preserves binary bytes and relative references. Does not execute scripts or install dependencies. Use explicit interpreters, e.g. bash scripts/run.sh or python scripts/run.py. Copies remain conversation files after uninstall. Calling again makes a fresh copy; reuse the returned directory for this workflow.",
    parameters: Type.Object(
      { skillId: Type.String({ minLength: 1, maxLength: 4096 }) },
      { additionalProperties: false },
    ),
    replay: "safe",
    executionMode: "sequential",
    async execute(args, api, context) {
      if (!api.env) throw new Error("Workspace unavailable");
      const skill = (await skills(Number(api.conversationId))).find(
        (s) => s.id === args.skillId,
      );
      if (!skill) throw new Error("Skill must be installed and enabled");
      if (!skill.files?.length)
        throw new Error(
          "Reinstall this Skill using its GitHub folder URL to include files",
        );
      // Validate and decode the complete snapshot before creating anything.
      const files = skill.files.map((file) => {
        if (!validSkillPath(file.path))
          throw new Error("Unsafe installed Skill path");
        return { ...file, bytes: decodeFile(file) };
      });
      const env = api.env;
      const directory =
        "moose-skill-" +
        Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
      getOrThrow(await env.createDir(directory, undefined, context));
      try {
        for (const file of files) {
          context.abortSignal?.throwIfAborted();
          if (
            !(await skills(Number(api.conversationId))).some(
              (s) => s.id === skill.id && s.installedAt === skill.installedAt,
            )
          )
            throw new Error("Skill changed or was disabled during copy");
          const path = `${directory}/${file.path}`;
          const parent = path.slice(0, path.lastIndexOf("/"));
          getOrThrow(await env.createDir(parent, { recursive: true }, context));
          getOrThrow(await env.writeFile(path, file.bytes, context));
        }
        const relative = directory.startsWith("/workspace/")
          ? directory.slice("/workspace/".length)
          : directory;
        if (relative.startsWith("/"))
          throw new Error(
            "Workspace did not return a relative-compatible directory",
          );
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify({
                directory: relative,
                files: files.map((f) => f.path),
                execution:
                  "Use read or bash with this relative directory. Commands require available interpreters and dependencies.",
              }),
            },
          ],
        };
      } catch (error) {
        await env
          .remove(
            directory,
            { recursive: true, force: true },
            BACKGROUND_CONTEXT,
          )
          .catch(() => {});
        throw error;
      }
    },
  });
}
