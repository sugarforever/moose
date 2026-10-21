import "./src/platform/polyfills";
import { registerRootComponent } from "expo";
import App from "./App";
import { registerBackgroundTask } from "./src/platform/background";
registerBackgroundTask();

if (__DEV__ && process.env.EXPO_PUBLIC_MOOSE_BACKGROUND_SMOKE === "1") {
  const { BackgroundSmokeApp } = require("./src/dev/BackgroundSmoke");
  registerRootComponent(BackgroundSmokeApp);
} else if (
  __DEV__ &&
  process.env.EXPO_PUBLIC_MOOSE_CAPABILITIES_SMOKE === "1"
) {
  const { CapabilitiesSmokeApp } = require("./src/dev/CapabilitiesSmoke");
  registerRootComponent(CapabilitiesSmokeApp);
} else if (__DEV__ && process.env.EXPO_PUBLIC_MOOSE_FILES_SMOKE === "1") {
  const { FilesSmokeApp } = require("./src/dev/FilesSmoke");
  registerRootComponent(FilesSmokeApp);
} else {
  registerRootComponent(App);
}
