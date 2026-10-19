import "./src/platform/polyfills";
import { registerRootComponent } from "expo";
import App from "./App";

if (__DEV__ && process.env.EXPO_PUBLIC_MOOSE_FILES_SMOKE === "1") {
  const { FilesSmokeApp } = require("./src/dev/FilesSmoke");
  registerRootComponent(FilesSmokeApp);
} else {
  registerRootComponent(App);
}
