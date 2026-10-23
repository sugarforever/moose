const { withMainActivity } = require("expo/config-plugins");

module.exports = function withNotificationIntent(config) {
  return withMainActivity(config, (result) => {
    if (result.modResults.language !== "kt")
      throw new Error("Moose notification links require the Kotlin Activity");
    const marker = "// Retain links delivered before React Native is ready.";
    const source = result.modResults.contents;
    if (source.includes(marker)) return result;
    const anchor = "  override fun onCreate(";
    if (
      !source.includes(anchor) ||
      source.includes("override fun onNewIntent(")
    )
      throw new Error("Review MainActivity intent handling before prebuilding");
    result.modResults.contents = source.replace(
      anchor,
      `  override fun onNewIntent(intent: android.content.Intent) {
    ${marker}
    setIntent(intent)
    super.onNewIntent(intent)
  }

${anchor}`,
    );
    return result;
  });
};
