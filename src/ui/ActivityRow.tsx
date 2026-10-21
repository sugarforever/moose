import React, { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { colors, Icon } from "./kit";
import type { Activity } from "./chat-activity";

export function ActivityRow({ activity }: { activity: Activity }) {
  const [expanded, setExpanded] = useState(false);
  const color = activity.error ? colors.danger : colors.muted;
  const label = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {activity.active ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <Icon
          name={activity.error ? "alert-circle" : "check"}
          size={14}
          color={color}
        />
      )}
      <Text style={{ color, fontSize: 13, flexShrink: 1 }}>
        {activity.label}
      </Text>
      {activity.output && (
        <Icon
          name={expanded ? "chevron-up" : "chevron-down"}
          size={14}
          color={color}
        />
      )}
    </View>
  );
  return (
    <View>
      {activity.output ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={activity.label}
          accessibilityHint="Expand or collapse tool output"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          {label}
        </Pressable>
      ) : (
        <View
          accessibilityLiveRegion="polite"
          style={{ minHeight: 28, justifyContent: "center" }}
        >
          {label}
        </View>
      )}
      {expanded && activity.output && (
        <Text
          selectable
          style={{
            color: colors.muted,
            fontSize: 13,
            lineHeight: 20,
            paddingVertical: 6,
          }}
        >
          {activity.output}
        </Text>
      )}
    </View>
  );
}
