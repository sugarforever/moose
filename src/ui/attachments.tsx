import React, { useState } from "react";
import { Image, Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { Attachment } from "../runtime/attachments";
import { colors, Icon, IconButton } from "./kit";

export function Attachments({
  items,
  onRemove,
}: {
  items: readonly Attachment[];
  onRemove?: (id: string) => void;
}) {
  const [preview, setPreview] = useState<Attachment>();
  if (!items.length) return null;
  return (
    <>
      <ScrollView
        horizontal
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
        keyboardShouldPersistTaps="handled"
      >
        {items.map((a) => {
          const image = a.mimeType.startsWith("image/");
          return (
            <View
              key={a.id}
              style={{
                maxWidth: 210,
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
              }}
            >
              {image ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`View image: ${a.name}`}
                  onPress={() => setPreview(a)}
                >
                  <Image
                    source={{ uri: `data:${a.mimeType};base64,${a.data}` }}
                    style={{ width: 88, height: 88, borderRadius: 8 }}
                    accessibilityLabel={a.name}
                  />
                </Pressable>
              ) : (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    padding: 8,
                    flexShrink: 1,
                  }}
                >
                  <Icon name="file-text" size={18} />
                  <Text
                    numberOfLines={2}
                    style={{ color: colors.ink, flexShrink: 1 }}
                  >
                    {a.name}
                  </Text>
                </View>
              )}
              {onRemove && (
                <IconButton
                  name="x"
                  label={`Remove attachment: ${a.name}`}
                  onPress={() => onRemove(a.id)}
                />
              )}
            </View>
          );
        })}
      </ScrollView>
      <Modal
        visible={!!preview}
        transparent
        animationType="fade"
        onRequestClose={() => setPreview(undefined)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.94)",
            paddingTop: 60,
            paddingBottom: 40,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close image"
            onPress={() => setPreview(undefined)}
            style={{
              minHeight: 44,
              alignSelf: "flex-end",
              paddingHorizontal: 24,
              justifyContent: "center",
            }}
          >
            <Text style={{ color: "white" }}>Close</Text>
          </Pressable>
          {preview && (
            <Image
              source={{
                uri: `data:${preview.mimeType};base64,${preview.data}`,
              }}
              resizeMode="contain"
              style={{ flex: 1 }}
              accessibilityLabel={preview.name}
            />
          )}
        </View>
      </Modal>
    </>
  );
}
