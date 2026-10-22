import type { AttemptFailure } from "../runtime/execution-diagnostics";
import { memo, useMemo, useState } from "react";
import {
  Linking,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  parseMarkdown,
  safeMarkdownUrl,
  type MarkdownNode,
} from "./markdown-parser";
import { colors } from "./kit";

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";
function inline(nodes: MarkdownNode[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    const children = node.children.length
      ? inline(node.children)
      : node.content;
    switch (node.type) {
      case "softbreak":
      case "hardbreak":
        return "\n";
      case "strong":
        return (
          <Text key={i} style={styles.strong}>
            {children}
          </Text>
        );
      case "em":
        return (
          <Text key={i} style={styles.em}>
            {children}
          </Text>
        );
      case "s":
        return (
          <Text key={i} style={styles.strike}>
            {children}
          </Text>
        );
      case "code_inline":
        return (
          <Text key={i} style={styles.inlineCode}>
            {children}
          </Text>
        );
      case "image":
        return <Text key={i}>[{node.content || "Image"}]</Text>;
      case "link": {
        const href = safeMarkdownUrl(node.href ?? "");
        return (
          <Text
            key={i}
            accessibilityRole={href ? "link" : undefined}
            style={href && styles.link}
            onPress={
              href
                ? () => {
                    void Linking.openURL(href).catch(() => {});
                  }
                : undefined
            }
          >
            {children}
          </Text>
        );
      }
      default:
        return <Text key={i}>{children}</Text>;
    }
  });
}
function blocks(nodes: MarkdownNode[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    const children = () => blocks(node.children);
    switch (node.type) {
      case "inline":
        return (
          <Text selectable key={i} style={styles.text}>
            {inline(node.children)}
          </Text>
        );
      case "paragraph":
        return (
          <View key={i} style={styles.paragraph}>
            {children()}
          </View>
        );
      case "heading":
        return (
          <Text
            selectable
            accessibilityRole="header"
            key={i}
            style={[
              styles.text,
              styles.heading,
              {
                fontSize: node.tag === "h1" ? 24 : node.tag === "h2" ? 21 : 18,
              },
            ]}
          >
            {inline(node.children[0]?.children ?? [])}
          </Text>
        );
      case "fence":
      case "code_block":
        return (
          <View key={i} style={styles.code}>
            {!!node.info.trim() && (
              <Text style={styles.language}>
                {node.info.trim().split(/\s/)[0]}
              </Text>
            )}
            <ScrollView horizontal nestedScrollEnabled>
              <Text selectable style={styles.codeText}>
                {node.content.replace(/\n$/, "")}
              </Text>
            </ScrollView>
          </View>
        );
      case "bullet_list":
      case "ordered_list":
        return (
          <View key={i} style={styles.list}>
            {node.children.map((item, j) => (
              <View key={j} style={styles.listItem}>
                <Text style={[styles.text, styles.marker]}>
                  {node.type === "ordered_list"
                    ? `${(node.start ?? 1) + j}.`
                    : "•"}
                </Text>
                <View style={styles.listBody}>{blocks(item.children)}</View>
              </View>
            ))}
          </View>
        );
      case "blockquote":
        return (
          <View key={i} style={styles.quote}>
            {children()}
          </View>
        );
      case "table":
        return (
          <ScrollView
            key={i}
            horizontal
            nestedScrollEnabled
            style={styles.table}
          >
            <View>{children()}</View>
          </ScrollView>
        );
      case "tr":
        return (
          <View key={i} style={styles.tableRow}>
            {children()}
          </View>
        );
      case "th":
      case "td":
        return (
          <View
            key={i}
            style={[styles.cell, node.type === "th" && styles.tableHead]}
          >
            {children()}
          </View>
        );
      case "hr":
        return <View key={i} style={styles.rule} />;
      default:
        return (
          <View key={i}>
            {node.children.length ? (
              children()
            ) : (
              <Text selectable style={styles.text}>
                {node.content}
              </Text>
            )}
          </View>
        );
    }
  });
}
export const Markdown = memo(function Markdown({
  text,
  failure,
}: {
  text: string;
  failure?: AttemptFailure;
}) {
  const [expanded, setExpanded] = useState(false);
  const tree = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={styles.root}>
      {failure && (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attempt details"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text style={failure.recovered ? styles.recovered : styles.error}>
              {failure.recovered
                ? "Earlier attempt failed · Recovered"
                : failure.reason === "error"
                  ? "Reply failed"
                  : `Reply stopped · ${failure.reason.replaceAll("_", " ")}`}{" "}
              · {expanded ? "Hide details" : "Details"}
            </Text>
          </Pressable>
          {expanded && (
            <Text selectable style={styles.detail}>
              {failure.message}
              {"\n"}
              {new Date(failure.at).toLocaleString()} · {failure.phase} ·{" "}
              {failure.retries === null
                ? "Retry count unavailable"
                : `${failure.retries} ${failure.retries === 1 ? "retry" : "retries"}`}
            </Text>
          )}
        </View>
      )}
      {blocks(tree)}
    </View>
  );
});
const styles = StyleSheet.create({
  recovered: { color: colors.ink, fontSize: 14 },
  detail: { color: colors.ink, fontSize: 13, lineHeight: 20 },
  root: { alignSelf: "stretch", minWidth: 0 },
  text: { color: colors.ink, fontSize: 16, lineHeight: 25 },
  paragraph: { marginVertical: 4 },
  heading: {
    fontWeight: "700",
    marginTop: 12,
    marginBottom: 6,
    lineHeight: 30,
  },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  link: { color: colors.green, textDecorationLine: "underline" },
  inlineCode: { fontFamily: mono, backgroundColor: colors.soft, fontSize: 14 },
  code: {
    backgroundColor: colors.soft,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  codeText: {
    fontFamily: mono,
    fontSize: 13,
    lineHeight: 21,
    color: colors.ink,
  },
  language: { color: colors.muted, fontSize: 12, marginBottom: 6 },
  list: { marginVertical: 4 },
  listItem: { flexDirection: "row", gap: 8 },
  marker: { minWidth: 24, paddingTop: 4 },
  listBody: { flex: 1, minWidth: 0 },
  quote: {
    borderLeftWidth: 3,
    borderColor: colors.line,
    paddingLeft: 12,
    marginVertical: 8,
  },
  table: { marginVertical: 8 },
  tableRow: { flexDirection: "row" },
  cell: {
    width: 160,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: 8,
  },
  tableHead: { backgroundColor: colors.soft },
  rule: { height: 1, backgroundColor: colors.line, marginVertical: 12 },
  error: { color: colors.danger, marginBottom: 4 },
});
