import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Skill } from "../skills/skills";
import { fileText } from "../skills/bundle";
import { colors } from "./kit";

export function SkillContent({ skill }: { skill: Skill }) {
  const [path, setPath] = useState("SKILL.md");
  const files = skill.files ?? [];
  const selected = files.find((f) => f.path === path) ?? files[0];
  const text = selected ? fileText(selected) : skill.instructions;
  return (
    <View style={{ gap: 8 }}>
      {!!skill.revision && (
        <Text style={{ color: colors.muted, fontSize: 12 }}>
          {files.length} files · {skill.revision.slice(0, 12)}
        </Text>
      )}
      {files.length > 1 && (
        <ScrollView nestedScrollEnabled style={{ maxHeight: 200 }}>
          {files.map((file) => (
            <Pressable
              key={file.path}
              accessibilityRole="button"
              accessibilityState={{ selected: file.path === selected?.path }}
              onPress={() => setPath(file.path)}
              style={{
                minHeight: 44,
                justifyContent: "center",
                paddingHorizontal: 8,
                backgroundColor:
                  file.path === selected?.path ? colors.soft : undefined,
              }}
            >
              <Text style={{ color: colors.ink, fontSize: 13 }}>
                {file.path} · {file.size.toLocaleString()} B
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <Text selectable style={{ color: colors.muted, fontSize: 12 }}>
        {selected?.path ?? "SKILL.md"}
      </Text>
      <ScrollView nestedScrollEnabled style={{ maxHeight: 360 }}>
        <Text
          selectable
          style={{ color: colors.ink, fontSize: 13, lineHeight: 21 }}
        >
          {text ??
            `Binary file · ${selected?.size.toLocaleString()} bytes. Exact bytes are available through skill_workspace.`}
        </Text>
      </ScrollView>
    </View>
  );
}
