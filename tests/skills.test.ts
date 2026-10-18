import { expect, it } from "vitest";
import {
  loadSkill,
  skillSourceUrl,
  selectedSkillPrompt,
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
