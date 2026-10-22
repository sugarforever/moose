import { expect, it } from "vitest";
import { parseMarkdown, safeMarkdownUrl } from "../src/ui/markdown-parser";

it("keeps nested list and table structure for native layout", () => {
  const tree = parseMarkdown(
    "# Hello\n\n3. **one**\n   - two\n\n| Name | Value |\n| --- | --- |\n| café | `2` |",
  );
  expect(tree[0]).toMatchObject({
    type: "heading",
    tag: "h1",
    children: [{ type: "inline" }],
  });
  expect(tree[1]).toMatchObject({ type: "ordered_list", start: 3 });
  expect(JSON.stringify(tree)).toContain('"type":"bullet_list"');
  expect(tree[2].type).toBe("table");
  expect(JSON.stringify(tree[2])).toContain("café");
});
it("renders unfinished streaming code and literal HTML without loading images", () => {
  expect(parseMarkdown("```ts\nconst x = 1")[0]).toMatchObject({
    type: "fence",
    content: "const x = 1",
    info: "ts",
  });
  const tree = parseMarkdown(
    "<script>alert(1)</script>\n\n![private](https://example.com/track.png)",
  );
  expect(JSON.stringify(tree)).toContain("<script>");
  expect(JSON.stringify(tree)).toContain('"type":"image"');
});
it("allows only explicit web links", () => {
  for (const url of [
    "javascript:alert(1)",
    "file:///secret",
    "intent://x",
    "//evil.test",
    "data:text/html,x",
  ])
    expect(safeMarkdownUrl(url)).toBeUndefined();
  expect(safeMarkdownUrl("https://example.com/path?q=1")).toBe(
    "https://example.com/path?q=1",
  );
});
