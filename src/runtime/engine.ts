import {
  ExecutionDoc,
  executionDiagnostics,
  executionEvents,
  executionPhase,
  recordExecution,
  safeError,
  type AttemptFailure,
  type Cancellation,
} from "./execution-diagnostics";
import { skillWorkspaceTool } from "./skill-workspace";
import type { ExecutionGuard } from "./execution-owner";
import { executionRequestKey } from "./execution-request";
import { withContextValue } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  Harness,
  LiveDoc,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  section,
  type ConversationId,
  type EntryId,
  type TaskId,
  type ConversationView,
} from "@earendil-works/pi-durable";
import {
  SqliteStorage,
  type SqliteDatabase,
} from "@earendil-works/pi-durable/storage/sqlite";
import {
  selectedSkillPrompt,
  upgradeSkillPrompt,
  type Skill,
} from "../skills/skills";
import {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
} from "@earendil-works/pi-durable/tools";
import { createIshBashTool } from "./ish";
import {
  MobileFileEnvironments,
  workspaceListTool,
  type MobileWorkspaceFactory,
} from "./files";

import {
  CapabilityService,
  type CapabilityOptions,
} from "../capabilities/service";
import { capabilityExtension } from "../capabilities/tools";

export interface ModelSettings {
  provider: string;
  modelId: string;
}
export interface ChatMessage {
  entryId: number;
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  failure?: AttemptFailure;
}
export interface SavedCheckpoint {
  id: string;
  conversationId: number;
  entryId: number;
  label: string;
  createdAt: number;
}
type RepeatInput = { prompt: string; intervalMs: number; count: number };
type RepeatCheckpoint =
  | { phase: "run"; completed: number; at: number }
  | { phase: "wait"; completed: number; at: number };
const RepeatProgress = defineDoc({
  kind: "moose.repeat.progress",
  version: 1,
  scope: "session",
  initial: () => ({ completed: {} as Record<string, number> }),
});

/** Each iteration has a stable idempotency key, including after interruption mid-submit. */
const createRepeatTask = (guard?: ExecutionGuard) =>
  defineTask<RepeatInput, RepeatCheckpoint, { completed: number }>({
    name: "moose.repeat",
    version: 1,
    initial: () => ({ phase: "run", completed: 0, at: 0 }),
    phases: {
      run: async (task, runtime, context) => {
        const lease = await guard?.(runtime.signal, [
          Number(runtime.conversationId),
        ]);
        try {
          if (lease?.signal.aborted) throw new Error("Task stopped");
          const checkpoint = task.state.checkpoint;
          const conversation = await runtime.conversation(
            runtime.conversationId,
            context,
          );
          if (!conversation) throw new Error("Repeat conversation missing");
          if (lease?.signal.aborted) throw new Error("Task stopped");
          const submission = await conversation.submit(
            {
              type: "input",
              content: task.input.prompt,
              requestId: `repeat:${task.id}:${checkpoint.completed}`,
              whenBusy: "followUp",
            },
            context,
          );
          const receipt = await submission.wait(context);
          if (receipt.status !== "done")
            throw new Error(
              "Repeat input was not answered; stopped to avoid repeated charges",
            );
          const completed = checkpoint.completed + 1;
          await runtime.commit(async (tx) => {
            (await tx.doc(RepeatProgress)).completed[String(task.id)] =
              completed;
            return completed >= task.input.count
              ? {
                  status: "terminal",
                  outcome: { status: "completed", result: { completed } },
                }
              : {
                  status: "running",
                  checkpoint: {
                    phase: "wait",
                    completed,
                    at: runtime.now() + task.input.intervalMs,
                  },
                };
          }, context);
        } finally {
          await lease?.release();
        }
      },
      wait: async (task, runtime, context) => {
        await runtime.sleep(task.state.checkpoint.at, context);
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: { ...task.state.checkpoint, phase: "run" },
          }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });

export function chatMessages(
  view: Pick<ConversationView, "entries"> &
    Partial<Pick<ConversationView, "docs">>,
): ChatMessage[] {
  const events = executionEvents(view);
  const all = view.entries.flatMap((e) => e.model ?? []);
  return view.entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) => {
      if (message.role !== "assistant" && message.role !== "user") return [];
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      if (
        !text &&
        !(
          message.role === "assistant" &&
          ["error", "aborted"].includes(message.stopReason)
        )
      )
        return [];
      const failed =
        message.role === "assistant" &&
        ["error", "aborted"].includes(message.stopReason);
      const event = failed
        ? events.findLast(
            (e) => e.kind === "response" && e.responseAt === message.timestamp,
          )
        : undefined;
      const later = all.slice(all.indexOf(message) + 1);
      const boundary = later.findIndex((m) => m.role === "user");
      const nextUserAt = boundary < 0 ? Infinity : later[boundary].timestamp;
      const request = events.findLast(
        (e) => e.kind === "request" && e.at <= message.timestamp,
      );
      const cancellation = failed
        ? events.find(
            (e) =>
              ["cancel", "restart"].includes(e.kind) &&
              e.at >= message.timestamp &&
              e.at < nextUserAt &&
              (!request || e.taskId === request.taskId),
          )
        : undefined;
      const recovered = later
        .slice(0, boundary < 0 ? undefined : boundary)
        .some(
          (m) =>
            m.role === "assistant" &&
            ["stop", "length", "toolUse"].includes(m.stopReason),
        );
      return [
        {
          ...(failed
            ? {
                failure: {
                  reason:
                    message.stopReason === "aborted"
                      ? (cancellation?.reason ?? "interrupted_unknown")
                      : message.stopReason,
                  message: safeError(
                    message.errorMessage ||
                      (message.stopReason === "aborted"
                        ? "Generation interrupted; exact cause unavailable"
                        : "Model response failed"),
                  ),
                  at: event?.at ?? cancellation?.at ?? message.timestamp,
                  phase: event?.phase ?? cancellation?.phase ?? "generation",
                  retries:
                    event || cancellation
                      ? Math.max(
                          0,
                          (event?.attempt ?? cancellation?.attempt ?? 1) - 1,
                        )
                      : null,
                  recovered,
                },
              }
            : {}),
          entryId: Number(entry.id),
          role: message.role,
          text,
          error:
            message.role === "assistant" &&
            ["error", "aborted"].includes(message.stopReason),
        },
      ];
    }),
  );
}

export class MobileEngine {
  readonly context = BACKGROUND_CONTEXT;
  private disposed = false;
  private skillTail: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly harness: Awaited<ReturnType<typeof Harness.open>>,
    private database: SqliteDatabase,
    private settings: ModelSettings,
    private files?: MobileFileEnvironments,
    readonly capabilities?: CapabilityService,
    private executionGuard?: ExecutionGuard,
  ) {}

  static async open(
    database: SqliteDatabase,
    models: Models,
    settings: ModelSettings,
    now = Date.now,
    workspaceFactory?: MobileWorkspaceFactory,
    capabilityOptions?: Omit<CapabilityOptions, "skills">,
    executionOptions: { shell?: boolean } = {},
    executionGuard?: ExecutionGuard,
  ) {
    await database.exec(
      "CREATE TABLE IF NOT EXISTS moose_data (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const registry = createRegistry();
    let activeHarness: Awaited<ReturnType<typeof Harness.open>>;
    registry.install(executionDiagnostics(() => activeHarness, now));
    const RepeatTask = createRepeatTask(executionGuard);
    registry.install(
      defineExtension({ name: "moose.tasks", tasks: [RepeatTask] }),
    );
    const files = workspaceFactory
      ? new MobileFileEnvironments(workspaceFactory)
      : undefined;
    const ish = workspaceFactory?.shell === true;
    const shell = ish || executionOptions.shell === true;
    if (files)
      registry.install(
        defineExtension({
          name: "moose.files",
          tools: [
            createReadTool(),
            createWriteTool(),
            createEditTool(),
            ...(shell
              ? [ish ? createIshBashTool() : createBashTool()]
              : [workspaceListTool()]),
          ].map((tool) => ({
            ...tool,
            execute: (args, api, context) =>
              tool.execute(
                args as never,
                api,
                withContextValue(
                  executionRequestKey,
                  { taskId: String(api.taskId), sequence: 0 },
                  context,
                ),
              ),
          })),
          sections: [
            section("mobile-workspace", () =>
              ish
                ? "Use read, write and edit for files inside /workspace and bash for the local iSH POSIX shell. They share this conversation’s persistent guest files. Other conversations and new checkpoint branches have separate roots. Files are not checkpointed. Guest network access is unavailable; use advertised native tools for approved HTTP, stored documents and reports. iOS suspension may pause commands. Never repeat a command automatically after an unknown outcome."
                : executionOptions.shell
                  ? "Use read, write, edit and bash in this conversation’s Termux workspace. All tools share the same directory. Use relative paths with all tools; /workspace is a file RPC alias, not a physical shell path. Run pwd in bash to discover its physical directory. Native shell commands have Termux app permissions, not container isolation. Other conversations start in separate directories. Checkpoints do not snapshot files. Never repeat a command automatically after an unknown outcome."
                  : "Use read, write, edit and workspace_list for files inside /workspace in this conversation’s app-private device workspace. Relative paths start at /workspace. Other conversations and new checkpoint branches have separate workspaces. File contents are not part of a conversation checkpoint. Shell and script execution are unavailable. Use advertised native tools for approved HTTP, stored documents and reports.",
            ),
          ],
        }),
      );
    const enabledSkills = async (id: number) => {
      const installed = await database.get<{ value: string }>(
        "SELECT value FROM moose_data WHERE key='skills'",
      );
      const selection = await database.get<{ value: string }>(
        "SELECT value FROM moose_data WHERE key=?",
        `skills:${id}`,
      );
      const selected = selection
        ? (JSON.parse(selection.value) as string[])
        : [];
      return (installed ? (JSON.parse(installed.value) as Skill[]) : []).filter(
        (s) => selected.includes(s.id),
      );
    };
    if (files)
      registry.install(
        defineExtension({
          name: "moose.skill-files",
          tools: [skillWorkspaceTool(enabledSkills)],
        }),
      );
    const capabilities = capabilityOptions
      ? new CapabilityService({ ...capabilityOptions, skills: enabledSkills })
      : undefined;
    if (capabilities)
      registry.install(
        capabilityExtension(capabilities, enabledSkills, {
          termux: !!executionOptions.shell && !ish,
        }),
      );
    const harness = await Harness.open(
      await SqliteStorage.open(database),
      {
        models,
        registry,
        now,
        env: files ? (target) => files.get(target) : undefined,
        settings: {
          progress: { partialIntervalMs: 150 },
          stream: { maxRetries: 0 },
          retry: {
            enabled: true,
            maxRetries: 3,
            baseDelayMs: 2000,
            maxAgentDelayMs: 30000,
          },
          // Keep automatic compaction inside the generation's execution lease.
          compaction: { backgroundTokens: 0 },
        },
      },
      BACKGROUND_CONTEXT,
    );
    activeHarness = harness;
    const engine = new MobileEngine(
      harness,
      database,
      settings,
      files,
      capabilities,
      executionGuard,
    );
    try {
      if (files)
        for (const item of await engine.listConversations())
          await engine.upgradeFilePrompt(item.id);
      return engine;
    } catch (error) {
      await engine.close();
      throw error;
    }
  }
  private async upgradeFilePrompt(id: number) {
    const conversation = await this.conversation(id);
    const instructions = (await conversation.agent(this.context)).instructions;
    if (instructions) {
      const next = upgradeSkillPrompt(instructions);
      if (next !== instructions)
        await conversation.configure({ instructions: next }, this.context);
    }
  }
  async read<T>(key: string, fallback: T): Promise<T> {
    const row = await this.database.get<{ value: string }>(
      "SELECT value FROM moose_data WHERE key = ?",
      key,
    );
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  async write(key: string, value: unknown) {
    await this.database.run(
      "INSERT INTO moose_data(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  async listConversations() {
    const page = await this.harness.commit(
      (tx) => tx.scanConversations({}, 1000),
      this.context,
    );
    return Promise.all(
      [...page.items].reverse().map(async (item) => ({
        id: Number(item.id),
        title: await this.read(`title:${item.id}`, `Conversation ${item.id}`),
      })),
    );
  }
  async newConversation(title = "New conversation") {
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: this.settings,
          instructions: selectedSkillPrompt([], []),
        },
      },
      this.context,
    );
    await this.write(`title:${conversation.id}`, title);
    return conversation;
  }
  async conversation(id: number) {
    const conversation = await this.harness.conversation(
      id as ConversationId,
      this.context,
    );
    if (!conversation) throw new Error("Conversation not found");
    return conversation;
  }
  async configure(
    id: number,
    settings: ModelSettings,
    skills: Skill[],
    selected: string[],
  ) {
    const prompt = selectedSkillPrompt(skills, selected);
    await (
      await this.conversation(id)
    ).configure({ model: settings, instructions: prompt }, this.context);
    await this.write(`skills:${id}`, selected);
    this.settings = settings;
  }
  updateSettings(settings: ModelSettings) {
    this.settings = settings;
  }
  private serializeSkills<T>(change: () => Promise<T>): Promise<T> {
    const result = this.skillTail.then(change);
    this.skillTail = result.catch(() => {});
    return result;
  }
  installSkill(skill: Skill) {
    return this.serializeSkills(async () => {
      const installed = await this.read<Skill[]>("skills", []);
      await this.write("skills", [
        ...installed.filter((item) => item.id !== skill.id),
        skill,
      ]);
    });
  }
  toggleSkill(id: number, skillId: string) {
    return this.serializeSkills(async () => {
      const installed = await this.read<Skill[]>("skills", []);
      if (!installed.some((item) => item.id === skillId))
        throw new Error("Skill is not installed");
      const selected = await this.read<string[]>(`skills:${id}`, []);
      const next = selected.includes(skillId)
        ? selected.filter((item) => item !== skillId)
        : [...selected, skillId];
      await this.configure(id, this.settings, installed, next);
      return next;
    });
  }
  uninstallSkill(skillId: string) {
    return this.serializeSkills(async () => {
      const installed = (await this.read<Skill[]>("skills", [])).filter(
        (item) => item.id !== skillId,
      );
      for (const conversation of await this.listConversations()) {
        const selected = await this.read<string[]>(
          `skills:${conversation.id}`,
          [],
        );
        const next = selected.filter((item) =>
          installed.some((skill) => skill.id === item),
        );
        if (next.length !== selected.length) {
          await (
            await this.conversation(conversation.id)
          ).configure(
            { instructions: selectedSkillPrompt(installed, next) },
            this.context,
          );
          await this.write(`skills:${conversation.id}`, next);
        }
      }
      await this.write("skills", installed);
    });
  }
  prepareConversation(id: number, settings: ModelSettings) {
    return this.serializeSkills(async () =>
      this.configure(
        id,
        settings,
        await this.read<Skill[]>("skills", []),
        await this.read<string[]>(`skills:${id}`, []),
      ),
    );
  }
  async submit(id: number, text: string, requestId: string) {
    if (!text.trim()) throw new Error("Enter a message");
    const lease = await this.executionGuard?.(undefined, [id]);
    try {
      await this.resume();
      const conversation = await this.conversation(id);
      if (lease?.signal.aborted) throw new Error("Task stopped");
      const submission = await conversation.submit(
        {
          type: "input",
          content: text.trim(),
          requestId,
          whenBusy: "followUp",
        },
        this.context,
      );
      // Ownership is independent of whether a UI still awaits the receipt.
      void submission
        .wait(this.context)
        .finally(() => lease?.release())
        .catch(() => {});
      return submission;
    } catch (error) {
      await lease?.release();
      throw error;
    }
  }
  async acknowledgeUnknownEffects(id: number) {
    const view = await this.view(id);
    const through = Math.max(
      0,
      ...view.entries.map((entry) => Number(entry.id)),
    );
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(ExecutionDoc, id as ConversationId);
      doc.acknowledgedThrough = Math.max(doc.acknowledgedThrough ?? 0, through);
      doc.unknown = (doc.unknownThrough ?? 0) > doc.acknowledgedThrough;
    }, this.context);
  }
  async pendingRequest(id: number) {
    const key = `outbox:${id}`;
    const pending = await this.read<{
      conversationId: number;
      text: string;
      requestId: string;
    } | null>(key, null);
    if (!pending) return null;
    const record = await this.harness.commit(
      (tx) => tx.submissionByRequest(id as ConversationId, pending.requestId),
      this.context,
    );
    if (record && record.status !== "queued" && record.status !== "placed") {
      // Compare-and-clear cannot erase a newer request written during this read.
      await this.database.run(
        "UPDATE moose_data SET value='null' WHERE key=? AND value=?",
        key,
        JSON.stringify(pending),
      );
      return null;
    }
    return pending;
  }
  async messages(id: number): Promise<ChatMessage[]> {
    return chatMessages(await this.view(id));
  }
  async view(id: number) {
    const chat = await this.conversation(id);
    const state = await chat.viewState(this.context);
    try {
      return await this.withDiagnostics(id, state.value);
    } finally {
      await state.dispose();
    }
  }
  private async withDiagnostics(
    id: number,
    view: ConversationView,
  ): Promise<ConversationView> {
    const diagnostics = await this.harness.snapshot(
      ExecutionDoc,
      id as ConversationId,
      this.context,
    );
    let outcome: { reason: string; at: number; phase: string } | undefined;
    const latest = diagnostics?.events.at(-1);
    if (!view.docs["pi.live"]?.run && latest) {
      const task = await this.harness.getTask(
        Number(latest.taskId) as TaskId,
        this.context,
      );
      if (
        task?.state.status === "terminal" &&
        ["faulted", "orphaned"].includes(task.state.outcome.status)
      ) {
        const result = task.state.outcome;
        outcome = {
          reason: safeError(
            result.error?.message ??
              result.reason ??
              "Runtime task interrupted",
          ),
          at: task.endedAt ?? latest.at,
          phase: latest.phase,
        };
      }
    }
    return {
      ...view,
      docs: {
        ...view.docs,
        ...(outcome ? { "moose.outcome": outcome } : {}),
        ...(diagnostics ? { "moose.execution": diagnostics } : {}),
      },
    };
  }
  async watch(id: number, listener: (view: ConversationView) => void) {
    const watch = await (await this.conversation(id)).watch(this.context);
    listener(await this.withDiagnostics(id, watch.value));
    watch.start(async (value) =>
      listener(await this.withDiagnostics(id, value)),
    );
    return () => watch.stop();
  }
  async checkpoint(id: number, label: string): Promise<SavedCheckpoint> {
    const conversation = await this.conversation(id);
    const [view, live] = await Promise.all([
      conversation.context(this.context),
      this.harness.snapshot(LiveDoc, id as ConversationId, this.context),
    ]);
    const latest = chatMessages(view).at(-1);
    const completed = view.entries.some(
      (entry) =>
        Number(entry.id) === latest?.entryId &&
        (entry.model ?? []).some(
          (message) =>
            message.role === "assistant" &&
            ["stop", "length"].includes(message.stopReason),
        ),
    );
    if (
      live?.run ||
      !completed ||
      !latest ||
      latest.role !== "assistant" ||
      latest.error
    )
      throw new Error("Wait for a completed answer before saving a checkpoint");
    const snapshot: SavedCheckpoint = {
      id: `${id}:${latest.entryId}`,
      conversationId: id,
      entryId: latest.entryId,
      label: label.trim() || "Checkpoint",
      createdAt: Date.now(),
    };
    const saved = await this.read<SavedCheckpoint[]>("checkpoints", []);
    await this.write("checkpoints", [
      ...saved.filter((item) => item.id !== snapshot.id),
      snapshot,
    ]);
    return snapshot;
  }
  async restoreCheckpoint(checkpointId: string) {
    const saved = (await this.read<SavedCheckpoint[]>("checkpoints", [])).find(
      (item) => item.id === checkpointId,
    );
    if (!saved) throw new Error("Checkpoint not found");
    const branch = await (
      await this.conversation(saved.conversationId)
    ).fork(
      saved.entryId as EntryId,
      { ownership: { kind: "ownerless" } },
      this.context,
    );
    if (this.files) await this.upgradeFilePrompt(Number(branch.id));
    await this.write(`title:${branch.id}`, `↳ ${saved.label}`);
    await this.write(
      `skills:${branch.id}`,
      await this.read(`skills:${saved.conversationId}`, []),
    );
    return branch;
  }
  async repeat(id: number, prompt: string, intervalMs: number, count: number) {
    if (
      !prompt.trim() ||
      !Number.isFinite(intervalMs) ||
      intervalMs < 60000 ||
      !Number.isInteger(count) ||
      count < 2 ||
      count > 100
    )
      throw new Error("Repeat needs text, at least 1 minute and 2–100 runs");
    await this.resume();
    const conversation = await this.conversation(id);
    const taskId = await conversation.commit(
      (tx) =>
        tx.createTask(
          createRepeatTask(),
          { prompt: prompt.trim(), intervalMs, count },
          { ownership: { kind: "conversation" }, background: true },
        ),
      this.context,
    );
    this.harness.resume();
    return Number(taskId);
  }
  async repeatStatus(id: number) {
    const task = await this.harness.getTask(
      id as TaskId<{ completed: number }>,
      this.context,
    );
    if (!task) throw new Error("Task not found");
    const checkpoint =
      task.state.status !== "terminal" && task.state.status !== "completing"
        ? (task.state.checkpoint as RepeatCheckpoint)
        : undefined;
    const progress = await this.harness.snapshot(RepeatProgress, this.context);
    const completed =
      progress?.completed[String(task.id)] ??
      checkpoint?.completed ??
      (task.state.status === "terminal" &&
      task.state.outcome.status === "completed"
        ? task.state.outcome.result.completed
        : 0);
    return {
      id: Number(task.id),
      status: task.state.status,
      completed,
      at: checkpoint?.at,
      input: task.input as RepeatInput,
      outcome:
        task.state.status === "terminal"
          ? task.state.outcome.status
          : undefined,
    };
  }
  async tasks() {
    const page = await this.harness.commit(
      (tx) => tx.scanTasks({ kind: "moose.repeat" }, 1000),
      this.context,
    );
    return Promise.all(
      [...page.items]
        .reverse()
        .map((task) => this.repeatStatus(Number(task.id))),
    );
  }
  async assertEnvironmentSwitchIdle() {
    if ((await this.tasks()).some((task) => task.status !== "terminal"))
      throw new Error(
        "Stop the repeating task before switching execution environments",
      );
    for (const chat of await this.listConversations()) {
      const live = await this.harness.snapshot(
        LiveDoc,
        chat.id as ConversationId,
        this.context,
      );
      if (live?.run)
        throw new Error(
          "Wait for all conversations to finish before switching execution environments",
        );
    }
    const pending = await this.database.get<{ key: string }>(
      "SELECT key FROM moose_data WHERE key LIKE 'outbox:%' AND value != 'null' LIMIT 1",
    );
    if (pending)
      throw new Error(
        "Resolve pending requests before switching execution environments",
      );
    const pendingWork = await this.harness.inspect(this.context);
    if (pendingWork.tasks.length || pendingWork.submissions.length)
      throw new Error(
        "Wait for all conversations and tasks before switching execution environments",
      );
  }
  async stopTask(id: number) {
    const task = await this.harness.getTask(id as TaskId, this.context);
    if (task)
      await this.recordCancellation(Number(task.conversationId), {
        reason: "user_stop",
        at: Date.now(),
      });
    await this.harness.abortTask(id as TaskId, this.context);
  }
  async stopConversation(id: number) {
    await this.recordCancellation(id, { reason: "user_stop", at: Date.now() });
    // Conversation.abort enables Pi scheduling, so protect other persisted runs first.
    await this.resume();
    await (await this.conversation(id)).abort(this.context);
  }
  private resumed = false;
  private recovery?: Promise<void>;
  resume(): Promise<void> {
    // The first progress-producing action restores every persisted run. AppState does not.
    if (this.resumed) {
      this.harness.resume();
      return Promise.resolve();
    }
    return (this.recovery ??= this.resumePending()
      .then(() => {
        this.resumed = true;
      })
      .finally(() => {
        this.recovery = undefined;
      }));
  }
  private async resumePending() {
    const pending = await this.harness.inspect(this.context);
    const ids = new Set<number>([
      ...pending.submissions.map((item) => Number(item.conversationId)),
      ...pending.tasks
        .filter((item) => item.record.kind !== "moose.repeat")
        .map((item) => Number(item.record.conversationId)),
    ]);
    const lease = ids.size
      ? await this.executionGuard?.(undefined, [...ids])
      : undefined;
    if (lease?.signal.aborted) {
      await lease.release();
      throw new Error("Task stopped");
    }
    try {
      for (const id of ids) {
        const live = await this.harness.snapshot(
          LiveDoc,
          id as ConversationId,
          this.context,
        );
        if (live?.run)
          await recordExecution(this.harness, id as ConversationId, {
            kind: "restart",
            taskId: String(live.run.taskId),
            ...(live.run.inputs[0]
              ? { runId: String(live.run.inputs[0]) }
              : {}),
            phase: executionPhase(live),
            at: Date.now(),
            attempt: live.generation?.attempt ?? 1,
            reason: "runtime_restart",
          });
      }
      this.harness.resume();
    } catch (error) {
      await lease?.release();
      throw error;
    }
    if (lease) {
      void Promise.all([
        ...[...ids].map(async (id) =>
          (await this.conversation(id)).waitForIdle(this.context),
        ),
        // Older databases may contain speculative background compactions.
        ...pending.tasks
          .filter((item) => item.record.kind !== "moose.repeat")
          .map((item) =>
            this.harness.waitForTask(item.record.id, this.context),
          ),
      ])
        .finally(() => lease.release())
        .catch(() => {});
    }
  }
  private async recordCancellation(id: number, cause: Cancellation) {
    const live = await this.harness.snapshot(
      LiveDoc,
      id as ConversationId,
      this.context,
    );
    if (!live?.run) return;
    await recordExecution(
      this.harness,
      id as ConversationId,
      {
        kind: "cancel",
        taskId: String(live.run.taskId),
        ...(live.run.inputs[0] ? { runId: String(live.run.inputs[0]) } : {}),
        phase: executionPhase(live),
        at: cause.at,
        attempt: live.generation?.attempt ?? 1,
        reason: cause.reason,
      },
      true,
    );
  }
  async stopAll(cause: Cancellation = { reason: "user_stop", at: Date.now() }) {
    // Cross repeat/background ownership boundaries and withdraw queued inputs.
    const pending = await this.harness.inspect(this.context);
    const ids = new Set([
      ...pending.tasks.map((item) => Number(item.record.conversationId)),
      ...pending.submissions.map((item) => Number(item.conversationId)),
    ]);
    await Promise.all([...ids].map((id) => this.recordCancellation(id, cause)));
    const conversations = await Promise.all(
      [...ids].map((id) => this.conversation(id)),
    );
    await Promise.all(
      conversations.map((chat) =>
        chat.abort(this.context, { background: true }),
      ),
    );
    await this.database.run(
      "DELETE FROM moose_data WHERE key LIKE 'permission-wait:%'",
    );
  }
  async close() {
    if (!this.disposed) {
      this.disposed = true;
      try {
        await this.harness.close(this.context);
      } finally {
        try {
          await this.files?.close(this.context);
        } finally {
          await this.capabilities?.close();
        }
      }
    }
  }
}
