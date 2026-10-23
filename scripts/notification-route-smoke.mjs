/** Opt-in emulator regression: requires the isolated BackgroundSmoke SQLite fixture. */
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const [source, target] = process.argv.slice(2);
if (
  ![source, target].every((id) => /^[1-9]\d*$/.test(id ?? "")) ||
  source === target
)
  throw new Error("Provide two distinct controlled probe conversation IDs");
const adb = (...args) =>
  execFileSync(process.env.ADB ?? "adb", args, {
    encoding: "utf8",
    timeout: 15000,
  });
const shell = (...args) => adb("shell", ...args);
const app = "dev.verysmallwoods.moose";
function launch(id) {
  shell(
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-c",
    "android.intent.category.LAUNCHER",
    "-n",
    `${app}/.MainActivity`,
    "-d",
    `moose://conversation/${id}`,
    "-f",
    "0x24000000",
  );
}
async function shows(id) {
  for (let n = 0; n < 5; n++) {
    shell("uiautomator", "dump", "/sdcard/moose-route-smoke.xml");
    const view = adb("exec-out", "cat", "/sdcard/moose-route-smoke.xml");
    if (new RegExp(`probe=${id}(?![0-9])`).test(view)) return true;
    await delay(500);
  }
  return false;
}
launch(source);
if (!(await shows(source)))
  throw new Error(
    "Source controlled fixture not visible; refusing to kill the app",
  );
if (
  shell("dumpsys", "activity", "services", app).includes(
    "MooseExecutionService",
  )
)
  throw new Error("An execution service is active; refusing to kill the app");
shell("input", "keyevent", "KEYCODE_HOME");
await delay(1000);
shell("am", "kill", app);
await delay(500);
let running = false;
try {
  running = !!shell("pidof", app).trim();
} catch {}
if (running)
  throw new Error("Process is still running; cold launch was not established");
launch(target);
if (!(await shows(target)))
  throw new Error(
    `Cold intent did not select controlled conversation ${target}`,
  );
if (
  shell("dumpsys", "activity", "services", app).includes(
    "MooseExecutionService",
  )
)
  throw new Error("Reading the saved route unexpectedly started execution");
console.log(
  `PASS: standalone cold route ${source} → ${target}, with no execution service`,
);
