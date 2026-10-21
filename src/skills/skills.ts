export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  source: string;
  installedAt: number;
}
const MAX_BYTES = 128 * 1024;

export function skillSourceUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Skill URL must use HTTPS");
  url.hash = "";
  if (url.hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    const [owner, repo, mode, ref, ...path] = parts;
    if (!owner || !repo)
      throw new Error("Provide a GitHub repository or SKILL.md URL");
    if (!mode)
      return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/SKILL.md`;
    if (!["tree", "blob"].includes(mode) || !ref)
      throw new Error("Provide a GitHub skill directory or SKILL.md URL");
    if (mode === "tree") path.push("SKILL.md");
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.join("/")}`;
  }
  if (url.pathname.endsWith("/")) url.pathname += "SKILL.md";
  return url.toString();
}

/** Download only a single bounded Markdown file. Linked scripts are never fetched. */
export async function loadSkill(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<Skill> {
  const source = skillSourceUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher(source, {
      signal: controller.signal,
      headers: { Accept: "text/markdown, text/plain" },
    });
    if (!response.ok)
      throw new Error(`Skill download failed (${response.status})`);
    if (response.url && new URL(response.url).protocol !== "https:")
      throw new Error("Skill redirect must use HTTPS");
    if (response.headers.get("content-type")?.includes("text/html"))
      throw new Error("URL returned HTML; provide a Markdown SKILL.md URL");
    if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES)
      throw new Error("Skill exceeds 128 KiB");
    let instructions = "";
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_BYTES) {
            await reader.cancel();
            throw new Error("Skill exceeds 128 KiB");
          }
          instructions += decoder.decode(next.value, { stream: true });
        }
        instructions += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    } else {
      instructions = await response.text();
      if (new TextEncoder().encode(instructions).length > MAX_BYTES)
        throw new Error("Skill exceeds 128 KiB");
    }
    if (!instructions.trim() || /^\s*<!?(html|doctype)/i.test(instructions))
      throw new Error("Provide a Markdown SKILL.md file");
    const metadata =
      instructions.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
    const field = (key: string) =>
      metadata
        .match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]
        ?.trim()
        .replace(/^["']|["']$/g, "");
    return {
      id: source,
      source,
      instructions,
      installedAt: Date.now(),
      name:
        field("name") ??
        instructions.match(/^#\s+(.+)$/m)?.[1] ??
        "Imported skill",
      description: field("description") ?? "Instruction-only skill",
    };
  } finally {
    clearTimeout(timer);
  }
}

const legacyPreamble =
  "You are Moose, a helpful mobile assistant. Reply in the user’s language. Skills provide instructions only. No shell, scripts, filesystem tools or external skill resources are available. Never claim to have executed them.";
const previousMobilePreamble =
  "You are Moose, a helpful mobile assistant. Reply in the user’s language. Skills provide instructions only. Use only tools exposed in this conversation. Shell, script execution and external Skill resource loading are unavailable. Never claim to have executed unavailable tools.";
const previousNativePreamble =
  "You are Moose, a helpful mobile assistant. Reply in the user’s language. Skills provide instructions only. Use only tools exposed in this conversation. Shell and script execution are unavailable. Read Skill resources only through available resource tools. Never claim to have executed unavailable tools.";
const mobilePreamble =
  "You are Moose, a helpful mobile assistant. Reply in the user’s language. Skills provide instructions only. Use only tools exposed in this conversation. External Skill resources are not automatically loaded. Never claim to have executed unavailable tools.";
export function upgradeSkillPrompt(prompt: string) {
  const prior = [
    legacyPreamble,
    previousMobilePreamble,
    previousNativePreamble,
  ].find((prefix) => prompt.startsWith(prefix));
  return prior ? mobilePreamble + prompt.slice(prior.length) : prompt;
}

export function selectedSkillPrompt(
  skills: Skill[],
  selected: string[],
): string {
  const enabled = skills.filter((skill) => selected.includes(skill.id));
  const total = enabled.reduce(
    (sum, skill) => sum + skill.instructions.length,
    0,
  );
  if (total > 65536)
    throw new Error("Selected skills exceed the 64 KiB prompt limit");
  return [
    mobilePreamble,
    ...enabled.map(
      (skill) =>
        `\n<skill name=${JSON.stringify(skill.name)}>\n${skill.instructions}\n</skill>`,
    ),
  ].join("\n");
}
