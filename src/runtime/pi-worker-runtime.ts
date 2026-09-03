import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createWorkerTools } from "./worker-tools.js";
import { createWorkerSandboxTools } from "./worker-sandbox.js";
import {
  WorkerModelSelectionError,
  WorkerSessionUnavailableError,
  type CreateWorkerRuntimeInput,
  type RestoreWorkerRuntimeInput,
  type WorkerEventListener,
  type WorkerRuntime,
  type WorkerRuntimeFactory,
} from "./worker-runtime.js";

const WORKER_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "intentum_git_snapshot",
  "intentum_commit",
  "intentum_progress",
  "intentum_escalate",
  "intentum_complete",
];

export class PiWorkerRuntimeFactory implements WorkerRuntimeFactory {
  private defaults: {
    model?: CreateAgentSessionOptions["model"];
    thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
    projectTrusted?: boolean;
  } = {};

  constructor(private readonly sessionRoot?: string) {}

  setSessionDefaults(defaults: {
    model?: CreateAgentSessionOptions["model"];
    thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
    projectTrusted?: boolean;
  }): void {
    this.defaults = { ...defaults };
  }

  async create(input: CreateWorkerRuntimeInput): Promise<WorkerRuntime> {
    const sessionManager = await this.createSessionManager(input);
    return this.createWithSessionManager(input, sessionManager, true);
  }

  private async createSessionManager(input: CreateWorkerRuntimeInput): Promise<SessionManager> {
    if (this.sessionRoot) {
      const sessionDir = join(this.sessionRoot, input.workerId);
      await mkdir(sessionDir, { recursive: true });
      return SessionManager.create(input.worktreePath, sessionDir);
    }
    await mkdir(join(getAgentDir(), "sessions"), { recursive: true });
    return SessionManager.create(input.worktreePath);
  }

  async restore(input: RestoreWorkerRuntimeInput): Promise<WorkerRuntime> {
    let sessionManager: SessionManager;
    try {
      sessionManager = SessionManager.open(input.sessionRef, undefined, input.worktreePath);
    } catch (error) {
      throw new WorkerSessionUnavailableError(
        `Pi could not open the recorded Worker session ${input.sessionRef}`,
        { cause: error },
      );
    }
    return this.createWithSessionManager(input, sessionManager, false);
  }

  /** Test seams may replace tool construction while keeping the real Pi SDK path. */
  protected createSandboxTools(worktreePath: string): Promise<ToolDefinition<any, any, any>[]> {
    return createWorkerSandboxTools(worktreePath);
  }

  private async createWithSessionManager(
    input: CreateWorkerRuntimeInput,
    sessionManager: SessionManager,
    useCurrentDesignerDefaults: boolean,
  ): Promise<WorkerRuntime> {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(input.worktreePath, agentDir, {
      projectTrusted: this.defaults.projectTrusted === true,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.worktreePath,
      agentDir,
      settingsManager,
      noExtensions: true,
      appendSystemPrompt: [renderWorkerRole(input.workerId)],
    });
    await resourceLoader.reload();

    const options: CreateAgentSessionOptions = {
      cwd: input.worktreePath,
      agentDir,
      tools: WORKER_TOOL_NAMES,
      customTools: [
        ...await this.createSandboxTools(input.worktreePath),
        ...createWorkerTools(input.callbacks),
      ],
      resourceLoader,
      sessionManager,
      settingsManager,
    };
    // A restored Pi session owns its persisted model and thinking level. Current
    // Designer defaults apply only to a newly-created Worker session.
    if (useCurrentDesignerDefaults && this.defaults.model) options.model = this.defaults.model;
    if (useCurrentDesignerDefaults && this.defaults.thinkingLevel) options.thinkingLevel = this.defaults.thinkingLevel;

    const { session, extensionsResult, modelFallbackMessage } = await createAgentSession(options);
    if (extensionsResult.errors.length > 0) {
      session.dispose();
      throw new Error(
        `Pi Worker resource loading failed: ${extensionsResult.errors.map((item) => `${item.path}: ${item.error}`).join("; ")}`,
      );
    }
    if (modelFallbackMessage) {
      session.dispose();
      throw new WorkerModelSelectionError(`Pi Worker model selection requires explicit review: ${modelFallbackMessage}`);
    }
    return new PiWorkerRuntime(input.workerId, session);
  }
}

export class PiWorkerRuntime implements WorkerRuntime {
  constructor(
    readonly id: string,
    private readonly session: AgentSession,
  ) {}

  get sessionRef(): string | undefined {
    return this.session.sessionFile;
  }

  prompt(text: string): Promise<void> {
    return this.session.prompt(text);
  }

  steer(text: string): Promise<void> {
    return this.session.steer(text);
  }

  followUp(text: string): Promise<void> {
    return this.session.followUp(text);
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  waitForIdle(): Promise<void> {
    return this.session.waitForIdle();
  }

  async dispose(): Promise<void> {
    try {
      // AgentSession.dispose() requests cancellation but is synchronous. Wait
      // for abort/idle first so a previous Pi session cannot keep a tool child
      // writing into the worktree after the controller lease is released.
      await this.session.abort();
      await this.session.waitForIdle();
    } finally {
      this.session.dispose();
    }
  }

  subscribe(listener: WorkerEventListener): () => void {
    let pendingAssistantError: string | undefined;
    return this.session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        pendingAssistantError = event.message.stopReason === "error"
          ? event.message.errorMessage ?? "Pi provider ended the Worker turn with an unspecified error"
          : undefined;
      }
      if (event.type === "agent_settled") {
        // agent_settled is later than provider retry and automatic compaction
        // continuations. Only the last assistant outcome at that point is the
        // final outcome of this Intentum turn.
        if (pendingAssistantError) listener({ type: "turn_failed", error: pendingAssistantError });
        pendingAssistantError = undefined;
        listener({ type: "settled" });
      }
      const sessionRef = this.session.sessionFile;
      if (sessionRef && event.type === "message_end") {
        listener({ type: "session_ref_changed", sessionRef });
      }
    });
  }
}

function renderWorkerRole(workerId: string): string {
  return `# intentum Worker ${workerId}

You are an independent, persistent implementation Worker operating in your own Git worktree.

- Own the complete outcome contract and choose the implementation details.
- Read the repository, implement, test, repair, and commit your work on the current Worker branch.
- Use intentum_git_snapshot for Git state and intentum_commit to create Worker commits; the isolated bash tool intentionally cannot access or mutate shared Git metadata.
- Do not create other workers, merge into the target branch, or edit .intentum project state.
- Do not change the product charter, public API, data model, or core architecture unilaterally.
- Use intentum_progress only at meaningful milestones.
- Use intentum_escalate for blockers and decisions instead of asking the Human directly.
- Finish with intentum_complete. A completed result must have a clean worktree and at least one commit after the base commit.
`;
}
