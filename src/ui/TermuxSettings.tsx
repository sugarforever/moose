import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, Platform, Text } from "react-native";
import { termux, termuxSetupCommand } from "../platform/termux";
import { termuxDiagnostics } from "../termux/diagnostics";
import type { SelfTestPhase } from "../termux/self-test";
import type { SetupPhase } from "../termux/setup";
import type { Moose } from "./useMoose";
import { Button, Caption, Card, s } from "./kit";
const phases: Record<SetupPhase, string> = {
  checking: "Checking Termux and service versions",
  installing:
    "Installing dependencies and starting the service. The first download may take a few minutes.",
  connecting: "Connecting to the Termux service",
  ready: "Connected. Switching environments",
};
const selfTestPhases: Record<SelfTestPhase, string> = {
  connect: "Self-test: signed connection",
  write: "Self-test: writing a temporary file",
  read: "Self-test: reading the temporary file",
  bash: "Self-test: reading with bash",
  cleanup: "Self-test: removing the temporary file",
};
export function TermuxSettings({ moose }: { moose: Moose }) {
  const [state, setState] =
    useState<Awaited<ReturnType<typeof termux.status>>>();
  const diagnostics = useSyncExternalStore(
    termuxDiagnostics.subscribe,
    termuxDiagnostics.snapshot,
  );
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refresh = async () => {
    try {
      const value = await termux.status();
      if (mounted.current) setState(value);
    } catch (error) {
      if (mounted.current)
        setMessage(
          error instanceof Error ? error.message : "Cannot check Termux",
        );
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (Platform.OS === "android") void refresh();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && !controller.current && Platform.OS === "android")
        void refresh();
    });
    return () => {
      mounted.current = false;
      controller.current?.abort();
      sub.remove();
    };
  }, []);
  if (Platform.OS !== "android") return null;
  const active = moose.runtime?.executionEnvironment === "termux";
  const act = async (operation: () => Promise<unknown>) => {
    try {
      setMessage("");
      await operation();
      await refresh();
    } catch (error) {
      if (mounted.current)
        setMessage(error instanceof Error ? error.message : "Operation failed");
    }
  };
  async function change(enabled: boolean) {
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setMessage("");
    try {
      await moose.changeExecutionEnvironment(enabled, next.signal, (phase) => {
        if (mounted.current && !next.signal.aborted) setMessage(phases[phase]);
      });
      if (mounted.current)
        setMessage(
          enabled ? "Connected to Termux." : "Switched to local files.",
        );
    } catch (error) {
      if (mounted.current)
        setMessage(
          next.signal.aborted
            ? "Waiting canceled. Installed dependencies are kept."
            : error instanceof Error
              ? error.message
              : "Connection failed. Try again.",
        );
    } finally {
      controller.current = null;
      if (mounted.current) {
        setBusy(false);
        await refresh();
      }
    }
  }
  async function selfTest() {
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setMessage("");
    try {
      await termux.selfTest(next.signal, (phase) => {
        if (mounted.current) setMessage(selfTestPhases[phase]);
      });
      if (mounted.current)
        setMessage(
          "Self-test passed: connection, file access, and bash work. No model was called.",
        );
    } catch (error) {
      if (mounted.current)
        setMessage(
          next.signal.aborted
            ? "Self-test canceled. Temporary file cleanup was attempted."
            : error instanceof Error
              ? error.message
              : "Self-test failed. Check or repair the connection.",
        );
    } finally {
      controller.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Card>
      <Text style={s.heading}>Execution environment</Text>
      <Caption>{active ? "Termux selected" : "Local files selected"}</Caption>
      {(active || diagnostics.checkedAt) && (
        <Caption>
          {diagnostics.connection === "unknown"
            ? "Connection has not been checked this session"
            : `Last contact: ${diagnostics.connection === "available" ? "Service reachable" : "Connection error. Check or repair it."} (${new Date(diagnostics.checkedAt!).toLocaleTimeString("en-GB")})`}
        </Caption>
      )}
      <Caption>
        Termux commands have that app's file and network access. Switching does
        not move files.
      </Caption>
      {!state?.installed && <Caption>Install and open Termux first.</Caption>}
      <Button
        secondary
        label="Open Termux"
        disabled={busy}
        onPress={() => void act(termux.openTermux)}
      />
      {state?.installed && !state.granted && (
        <>
          <Button
            secondary
            label="Allow command execution"
            disabled={busy}
            onPress={() => void act(termux.requestPermission)}
          />
          <Button
            secondary
            label="Open system settings"
            disabled={busy}
            onPress={() => void act(termux.openSettings)}
          />
        </>
      )}
      {!active && (
        <>
          <Caption>
            First use: run this command in Termux, then return here. Long-press
            to copy.
          </Caption>
          <Text selectable>{termuxSetupCommand}</Text>
          <Button
            label="Set up and connect Termux"
            busy={busy}
            disabled={
              !state?.installed || !moose.runtime || (moose.working && !busy)
            }
            onPress={() => void change(true)}
          />
        </>
      )}
      {active && (
        <>
          <Button
            secondary
            label="Check or repair connection"
            busy={busy}
            disabled={!moose.runtime || (moose.working && !busy)}
            onPress={() => void change(true)}
          />
          <Button
            secondary
            label="Use local files"
            disabled={busy || moose.working || !moose.runtime}
            onPress={() => void change(false)}
          />
        </>
      )}
      {state?.installed && (
        <Button
          secondary
          label="Run self-test (no model)"
          disabled={busy || moose.working || !moose.runtime}
          onPress={() => void selfTest()}
        />
      )}
      <Button
        secondary
        label={showDiagnostics ? "Hide diagnostics" : "View diagnostics"}
        onPress={() => setShowDiagnostics(!showDiagnostics)}
      />
      {showDiagnostics && (
        <>
          <Caption>
            Keeps the last 40 operations, results, and timings from this
            session. Excludes commands, file contents, and credentials.
            Long-press to select and copy.
          </Caption>
          <Text selectable>
            {termuxDiagnostics.export() || "No diagnostics"}
          </Text>
        </>
      )}
      {busy && (
        <Button
          secondary
          label="Cancel waiting"
          onPress={() => controller.current?.abort()}
        />
      )}
      {!!message && <Caption>{message}</Caption>}
    </Card>
  );
}
