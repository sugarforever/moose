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
