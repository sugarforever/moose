import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";

export const colors = {
  bg: "#F6F7F4",
  paper: "#FFFFFF",
  ink: "#1D342D",
  muted: "#6D7B75",
  green: "#244E3D",
  soft: "#E9EFE6",
  line: "#E1E6DD",
  danger: "#A83E35",
};
export type IconName = React.ComponentProps<typeof Feather>["name"];
export function Icon({
  name,
  size = 20,
  color = colors.ink,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return <Feather name={name} size={size} color={color} />;
}
export function Button({
  label,
  onPress,
  icon,
  secondary = false,
  disabled = false,
  busy = false,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  secondary?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        secondary && s.secondary,
        { opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={secondary ? colors.green : "#fff"} />
      ) : icon ? (
        <Icon name={icon} size={17} color={secondary ? colors.green : "#fff"} />
      ) : null}
      <Text style={[s.buttonText, secondary && { color: colors.green }]}>
        {label}
      </Text>
    </Pressable>
  );
}
export function IconButton({
  name,
  label,
  onPress,
  disabled = false,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.iconButton,
        { opacity: disabled ? 0.35 : pressed ? 0.5 : 1 },
      ]}
    >
      <Icon name={name} />
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#9AA59E"
        {...props}
        style={[
          s.field,
          props.multiline && { minHeight: 100, textAlignVertical: "top" },
          props.style,
        ]}
      />
    </View>
  );
}
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[s.card, style]}>{children}</View>;
}
export function Caption({ children }: { children: React.ReactNode }) {
  return <Text style={s.caption}>{children}</Text>;
}
export const s = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: 10,
    backgroundColor: colors.green,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  secondary: { backgroundColor: colors.soft },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
  },
  field: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "#fff",
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: 13,
    fontSize: 15,
    color: colors.ink,
    minHeight: 48,
  },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted },
  card: {
    backgroundColor: colors.paper,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 19,
    gap: 14,
  },
  caption: { fontSize: 12, lineHeight: 19, color: colors.muted },
  heading: {
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: -1,
    color: colors.ink,
  },
  subheading: { fontSize: 15, fontWeight: "600", color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  between: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  page: { padding: 20, gap: 20, paddingBottom: 36 },
  link: { color: colors.green, fontSize: 13, fontWeight: "600" },
});
