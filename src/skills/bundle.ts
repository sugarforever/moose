/** Portable installed bytes; no Node Buffer or filesystem dependency. */
export interface SkillFile {
  path: string;
  base64: string;
  size: number;
}
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function encodeFile(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      alphabet[(n >>> 18) & 63] +
      alphabet[(n >>> 12) & 63] +
      (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : "=") +
      (i + 2 < bytes.length ? alphabet[n & 63] : "=");
  }
  return out;
}
export function decodeFile(file: SkillFile): Uint8Array {
  const text = file.base64;
  if (
    text.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(text) ||
    !/^[^=]*={0,2}$/.test(text)
  )
    throw new Error("Invalid installed file encoding");
  const result = new Uint8Array(
    (text.length / 4) * 3 -
      (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0),
  );
  let offset = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n =
      (alphabet.indexOf(text[i]) << 18) |
      (alphabet.indexOf(text[i + 1]) << 12) |
      (Math.max(0, alphabet.indexOf(text[i + 2])) << 6) |
      Math.max(0, alphabet.indexOf(text[i + 3]));
    for (const shift of [16, 8, 0])
      if (offset < result.length) result[offset++] = (n >>> shift) & 255;
  }
  if (result.length !== file.size)
    throw new Error("Installed file size mismatch");
  return result;
}
export function fileText(file: SkillFile): string | undefined {
  const bytes = decodeFile(file);
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
export function validSkillPath(path: string): boolean {
  const parts = path.split("/");
  return (
    path.length <= 512 &&
    parts.length <= 9 &&
    parts.every(
      (p) =>
        /^[A-Za-z0-9_. -]+$/.test(p) &&
        p !== "." &&
        p !== ".." &&
        !p.endsWith(".") &&
        !p.endsWith(" "),
    )
  );
}
async function readBytes(
  url: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  max: number,
): Promise<Uint8Array> {
  const response = await fetcher(url, {
    signal,
    headers: {
      Accept: "application/vnd.github+json, application/octet-stream",
    },
  });
  if (!response.ok)
    throw new Error(`Skill download failed (${response.status})`);
  if (response.url && new URL(response.url).protocol !== "https:")
    throw new Error("Skill redirect must use HTTPS");
  if (Number(response.headers.get("content-length") ?? 0) > max)
    throw new Error("Skill file exceeds size limit");
  if (!response.body?.getReader) {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length > max) throw new Error("Skill file exceeds size limit");
    return data;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new Error("Skill file exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function loadFolder(
  input: string,
  fetcher: typeof fetch,
): Promise<
  { files: SkillFile[]; revision: string; source: string } | undefined
> {
  const url = new URL(input.trim());
  if (url.hostname !== "github.com") return;
  const [owner, repo, mode, ref, ...paths] = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  if (mode && mode !== "tree") return;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !owner ||
    !repo ||
    (mode && !ref)
  )
    throw new Error("Provide a public HTTPS GitHub Skill folder URL");
  if (
    ![owner, repo, ref ?? "HEAD"].every((p) => /^[A-Za-z0-9_.-]+$/.test(p)) ||
    (paths.length && !validSkillPath(paths.join("/")))
  )
    throw new Error("Invalid GitHub Skill folder path or ref");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  try {
    const json = async (url: string) =>
      JSON.parse(
        new TextDecoder().decode(
          await readBytes(url, fetcher, controller.signal, 2 * 1024 * 1024),
        ),
      );
    const commit = await json(`${api}/commits/${ref ?? "HEAD"}`);
    if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/.test(commit.sha))
      throw new Error("Invalid GitHub commit");
    const listing = await json(`${api}/git/trees/${commit.sha}?recursive=1`);
    if (listing.truncated !== false || !Array.isArray(listing.tree))
      throw new Error("Incomplete GitHub folder listing");
    const prefix = paths.length ? paths.join("/") + "/" : "";
    const files: { path: string; size: number }[] = [];
    const names = new Map<string, string>();
    let total = 0;
    for (const entry of listing.tree) {
      if (typeof entry.path !== "string" || !entry.path.startsWith(prefix))
        continue;
      const path = entry.path.slice(prefix.length);
      if (!validSkillPath(path)) throw new Error("Unsafe Skill file path");
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const name = parts.slice(0, i).join("/");
        const key = name.toLowerCase();
        if (names.has(key) && names.get(key) !== name)
          throw new Error("Case-colliding Skill paths");
        names.set(key, name);
      }
      if (entry.type === "tree" && entry.mode === "040000") continue;
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        throw new Error("Skill symlinks and submodules are unsupported");
      const max = path === "SKILL.md" ? 128 * 1024 : 512 * 1024;
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > max
      )
        throw new Error("Skill file exceeds size limit");
      total += entry.size;
      files.push({ path, size: entry.size });
      if (files.length > 128 || total > 4 * 1024 * 1024)
        throw new Error("Skill folder exceeds 128 files or 4 MiB");
    }
    if (!files.some((f) => f.path === "SKILL.md"))
      throw new Error("Skill folder must contain SKILL.md");
    const seen = new Set<string>();
    for (const file of files) {
      if (
        seen.has(file.path) ||
        files.some((other) => other.path.startsWith(file.path + "/"))
      )
        throw new Error("Conflicting Skill paths");
      seen.add(file.path);
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    const base = `https://raw.githubusercontent.com/${owner}/${repo}/${commit.sha}/${prefix}`;
    const installed: SkillFile[] = [];
    for (const file of files) {
      const bytes = await readBytes(
        base + file.path.split("/").map(encodeURIComponent).join("/"),
        fetcher,
        controller.signal,
        file.path === "SKILL.md" ? 128 * 1024 : 512 * 1024,
      );
      if (bytes.length !== file.size)
        throw new Error("Skill file changed or download was incomplete");
      installed.push({
        path: file.path,
        size: bytes.length,
        base64: encodeFile(bytes),
      });
    }
    return {
      files: installed,
      revision: commit.sha,
      source: base + "SKILL.md",
    };
  } finally {
    clearTimeout(timer);
  }
}
