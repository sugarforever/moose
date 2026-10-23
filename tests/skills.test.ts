import { expect, it } from "vitest";
import {
  loadSkill,
  skillSourceUrl,
  selectedSkillPrompt,
  upgradeSkillPrompt,
} from "../src/skills/skills";

it("resolves GitHub skill directories and blob files to raw Markdown", () => {
  expect(
    skillSourceUrl("https://github.com/acme/skills/tree/main/review"),
  ).toBe("https://raw.githubusercontent.com/acme/skills/main/review/SKILL.md");
  expect(
    skillSourceUrl("https://github.com/acme/skills/blob/main/review/SKILL.md"),
  ).toBe("https://raw.githubusercontent.com/acme/skills/main/review/SKILL.md");
  expect(() => skillSourceUrl("file:///etc/passwd")).toThrow("HTTPS");
});

it("installs instruction text, never follows or executes script links", async () => {
  const markdown =
    "---\nname: reviewer\ndescription: Review changes\n---\n# Review\nRead carefully. [script](scripts/run.sh)";
  const visited: string[] = [];
  const skill = await loadSkill("https://example.com/SKILL.md", async (url) => {
    visited.push(String(url));
    return new Response(markdown);
  });
  expect(skill.name).toBe("reviewer");
  expect(skill.instructions).toContain("[script](scripts/run.sh)");
  expect(visited).toEqual(["https://example.com/SKILL.md"]);
  expect(selectedSkillPrompt([skill], [])).not.toContain("Read carefully");
  expect(selectedSkillPrompt([skill], [skill.id])).toContain("Read carefully");
});

it("rejects oversized responses and HTML rather than installing a website", async () => {
  await expect(
    loadSkill(
      "https://example.com/SKILL.md",
      async () => new Response("x".repeat(131073)),
    ),
  ).rejects.toThrow("128");
  await expect(
    loadSkill(
      "https://example.com/SKILL.md",
      async () =>
        new Response("<html>login</html>", {
          headers: { "content-type": "text/html" },
        }),
    ),
  ).rejects.toThrow("Markdown");
});

it("describes tool availability without denying injected filesystem tools", () => {
  const prompt = selectedSkillPrompt([], []);
  expect(prompt).not.toContain("No shell, scripts, filesystem tools");
  expect(prompt).toContain("tools exposed in this conversation");
});

it("preserves a legacy sentence quoted inside a Skill when upgrading the app preamble", () => {
  const legacy =
    "You are Moose, a helpful mobile assistant. Reply in the user’s language. Skills provide instructions only. No shell, scripts, filesystem tools or external skill resources are available. Never claim to have executed them.";
  const current = selectedSkillPrompt([], []) + `\n<skill>${legacy}</skill>`;
  expect(upgradeSkillPrompt(current)).toBe(current);
});

it("upgrades the prior file-only preamble without changing appended skill instructions", () => {
  const old =
    "You are Moose, a helpful mobile assistant. Reply in the user’s language. Skills provide instructions only. Use only tools exposed in this conversation. Shell, script execution and external Skill resource loading are unavailable. Never claim to have executed unavailable tools.";
  const skill = "\n<skill>Shell, script execution is quoted here.</skill>";
  expect(upgradeSkillPrompt(old + skill)).toBe(
    selectedSkillPrompt([], []) + skill,
  );
});

it("upgrades the native-only preamble before enabling Termux without changing Skill text", () => {
  const old =
    "You are Moose, a helpful mobile assistant. Reply in the user’s language. Skills provide instructions only. Use only tools exposed in this conversation. Shell and script execution are unavailable. Read Skill resources only through available resource tools. Never claim to have executed unavailable tools.";
  const suffix = "\n<skill>Keep native data unchanged</skill>";
  expect(upgradeSkillPrompt(old + suffix)).toBe(
    selectedSkillPrompt([], []) + suffix,
  );
});

it("installs all folder files from one pinned GitHub commit, preserving binary bytes", async () => {
  const requests: string[] = [];
  const sha = "a".repeat(40);
  const skill = await loadSkill(
    "https://github.com/acme/skills/tree/main/review",
    async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/commits/main")) return Response.json({ sha });
      if (url.includes("/git/trees/"))
        return Response.json({
          truncated: false,
          tree: [
            { path: "review/SKILL.md", type: "blob", mode: "100644", size: 18 },
            {
              path: "review/scripts/run.sh",
              type: "blob",
              mode: "100755",
              size: 12,
            },
            {
              path: "review/assets/data.bin",
              type: "blob",
              mode: "100644",
              size: 3,
            },
            { path: "other/secret", type: "blob", mode: "100644", size: 1 },
          ],
        });
      if (url.endsWith("SKILL.md")) return new Response("# Review\nUse files");
      if (url.endsWith("run.sh")) return new Response("echo working");
      if (url.endsWith("data.bin"))
        return new Response(new Uint8Array([0, 255, 1]));
      throw new Error(`Unexpected ${url}`);
    },
  );
  expect(skill.files?.map((f) => f.path)).toEqual([
    "SKILL.md",
    "assets/data.bin",
    "scripts/run.sh",
  ]);
  expect(skill.files?.find((f) => f.path === "assets/data.bin")?.base64).toBe(
    "AP8B",
  );
  expect(skill.revision).toBe(sha);
  expect(
    requests
      .filter((u) => u.includes("raw.githubusercontent.com"))
      .every((u) => u.includes(sha)),
  ).toBe(true);
  expect(requests.some((u) => u.includes("other/secret"))).toBe(false);
  expect(selectedSkillPrompt([skill], [skill.id])).toContain("skill_workspace");
});

it.each(
  [
    [{ path: "review/link", type: "blob", mode: "120000", size: 1 }],
    [{ path: "review/sub", type: "commit", mode: "160000" }],
    [{ path: "review/../outside", type: "blob", mode: "100644", size: 1 }],
    [
      { path: "review/SKILL.md", type: "blob", mode: "100644", size: 1 },
      { path: "review/skill.md", type: "blob", mode: "100644", size: 1 },
    ],
    [{ path: "review/huge", type: "blob", mode: "100644", size: 524289 }],
  ].map((tree) => ({ tree })),
)(
  "rejects unsafe or oversized folder entries before fetching files: %j",
  async ({ tree }) => {
    let files = 0;
    await expect(
      loadSkill(
        "https://github.com/acme/skills/tree/main/review",
        async (input) => {
          const url = String(input);
          if (url.includes("/commits/"))
            return Response.json({ sha: "a".repeat(40) });
          if (url.includes("/git/trees/"))
            return Response.json({ truncated: false, tree });
          files++;
          return new Response("# Skill");
        },
      ),
    ).rejects.toThrow();
    expect(files).toBe(0);
  },
);

it.each([
  { truncated: true, tree: [] },
  { truncated: false, tree: [] },
  {
    truncated: false,
    tree: Array.from({ length: 129 }, (_, i) => ({
      path: `review/${i === 0 ? "SKILL.md" : `file-${i}`}`,
      type: "blob",
      mode: "100644",
      size: 1,
    })),
  },
  {
    truncated: false,
    tree: [
      { path: "review/SKILL.md", type: "blob", mode: "100644", size: 1 },
      ...Array.from({ length: 9 }, (_, i) => ({
        path: `review/file-${i}`,
        type: "blob",
        mode: "100644",
        size: 524288,
      })),
    ],
  },
])(
  "rejects incomplete, missing, and over-limit folder snapshots before downloading: %j",
  async (listing) => {
    await expect(
      loadSkill(
        "https://github.com/acme/repo/tree/main/review",
        async (input) => {
          if (String(input).includes("/commits/"))
            return Response.json({ sha: "a".repeat(40) });
          if (String(input).includes("/git/trees/"))
            return Response.json(listing);
          throw new Error("Must reject before downloading");
        },
      ),
    ).rejects.toThrow();
  },
);
it("does not return a partial Skill after a folder file fails to download", async () => {
  await expect(
    loadSkill(
      "https://github.com/acme/repo/tree/main/review",
      async (input) => {
        const url = String(input);
        if (url.includes("/commits/"))
          return Response.json({ sha: "b".repeat(40) });
        if (url.includes("/git/trees/"))
          return Response.json({
            truncated: false,
            tree: [
              {
                path: "review/SKILL.md",
                type: "blob",
                mode: "100644",
                size: 7,
              },
              {
                path: "review/script.sh",
                type: "blob",
                mode: "100644",
                size: 1,
              },
            ],
          });
        return url.endsWith("SKILL.md")
          ? new Response("# Skill")
          : new Response("", { status: 404 });
      },
    ),
  ).rejects.toThrow("404");
});

it("includes installed manifests and UTF-8 bytes in the selected Skill prompt limit", () => {
  const skill = {
    id: "bundle",
    name: "Bundle",
    description: "",
    instructions: "Use files",
    source: "https://example.com/SKILL.md",
    installedAt: 0,
    files: Array.from({ length: 128 }, (_, i) => ({
      path: "a".repeat(508) + String(i).padStart(4, "0"),
      size: 0,
      base64: "",
    })),
  };
  expect(() => selectedSkillPrompt([skill], [skill.id])).toThrow("64 KiB");
  expect(() =>
    selectedSkillPrompt(
      [{ ...skill, files: undefined, instructions: "界".repeat(23000) }],
      [skill.id],
    ),
  ).toThrow("64 KiB");
});

it("migrates the iSH preamble to current native capabilities without altering Skill text", () => {
  const prior =
    "You are Moose, a helpful mobile assistant. Reply in the user’s language. Skills provide instructions only. Use only tools exposed in this conversation. The local iSH guest provides a POSIX shell; network access and external Skill resource loading are unavailable. Never claim to have executed unavailable tools.";
  const suffix = "\n<skill>Keep shell instructions unchanged</skill>";
  expect(upgradeSkillPrompt(prior + suffix)).toBe(
    selectedSkillPrompt([], []) + suffix,
  );
});
