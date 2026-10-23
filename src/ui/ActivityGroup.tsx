import React, { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  Text,
  View,
} from "react-native";
import { ActivityRow } from "./ActivityRow";
import { activitySummary, type Activity } from "./chat-activity";
import { colors, Icon } from "./kit";

export function ActivityGroup({ activities }: { activities: Activity[] }) {
  const [expanded, setExpanded] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(true);
  const opacity = useRef(new Animated.Value(1)).current;
  const summary = activitySummary(activities);
  useEffect(() => {
    let mounted = true;
    let changed = false;
    const listener = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (value) => {
        changed = true;
        setReduceMotion(value);
      },
    );
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted && !changed) setReduceMotion(value);
      })
      .catch(() => {});
    return () => {
      mounted = false;
      listener.remove();
    };
  }, []);
  useEffect(() => {
    if (!summary.active || reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.55,
          duration: 900,
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );
    pulse.start();
    return () => {
      pulse.stop();
      opacity.setValue(1);
    };
  }, [summary.active, reduceMotion, opacity]);
  const color = summary.error ? colors.danger : colors.muted;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLiveRegion="polite"
        accessibilityLabel={summary.label}
        accessibilityHint="Expand or collapse activity details"
        accessibilityState={{ expanded, busy: summary.active }}
        onPress={() => setExpanded((value) => !value)}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Animated.View
          style={{
            opacity,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Text style={{ color, fontSize: 13, flexShrink: 1 }}>
            {summary.label}
          </Text>
          <Icon
            name={expanded ? "chevron-down" : "chevron-right"}
            size={14}
            color={color}
          />
        </Animated.View>
      </Pressable>
      {expanded && (
        <View
          style={{
            paddingLeft: 8,
            borderLeftWidth: 1,
            borderLeftColor: colors.line,
          }}
        >
          {activities.map((activity) => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              initiallyExpanded
            />
          ))}
        </View>
      )}
    </View>
  );
}
