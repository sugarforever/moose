import MarkdownIt from "markdown-it/browser";
import type { Token } from "markdown-it";

export interface MarkdownNode {
  type: string;
  tag: string;
  content: string;
  info: string;
  href?: string;
  start?: number;
  children: MarkdownNode[];
}
const parser = new MarkdownIt({ html: false, breaks: true, linkify: false });
export function safeMarkdownUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {}
  return undefined;
}
function nodes(tokens: Token[]): MarkdownNode[] {
  const root: MarkdownNode[] = [];
  const stack = [root];
  for (const token of tokens) {
    if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node: MarkdownNode = {
      type: token.type.replace(/_open$/, ""),
      tag: token.tag,
      content: token.content,
      info: token.info,
      href:
        token.attrGet("href") == null
          ? undefined
          : String(token.attrGet("href")),
      start:
        token.type === "ordered_list_open"
          ? Number(token.attrGet("start") ?? 1)
          : undefined,
      children: token.children ? nodes(token.children) : [],
    };
    stack[stack.length - 1].push(node);
    if (token.nesting === 1) stack.push(node.children);
  }
  return root;
}
export function parseMarkdown(text: string): MarkdownNode[] {
  return nodes(parser.parse(text, {}));
}
