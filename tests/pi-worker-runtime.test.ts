import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { PiWorkerRuntime, PiWorkerRuntimeFactory } from "../src/runtime/pi-worker-runtime.js";
import type { WorkContract } from "../src/work/contract.js";
import { createTempRepository } from "./helpers/temp-repo.js";

const CONTRACT: WorkContract = {
  id: "W-001",
  featureId: "F-001",
  title: "Adapter probe",
  objective: "Create a persistent Pi AgentSession handle without making a provider request.",
  why: "It validates the locked SDK construction boundary.",
  userVisibleResult: "A restorable session reference exists.",
  scope: { inScope: ["SDK construction"], outOfScope: ["model invocation"] },
  interfaces: [],
  constraints: [],
  acceptanceCriteria: ["Session reference uses Pi SessionManager"],
  dependencies: [],
  touchHints: [],
  risk: "low",
  preferredWorkerKind: "implementation",
  contextFiles: [],
};

const FIXTURE_MODEL: Model<"openai-completions"> = {
  id: "intentum-fixture-model",
  name: "Intentum fixture model",
  api: "openai-completions",
  provider: "intentum-fixture",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

/**
 * These tests prove Pi session construction only and never execute a tool or
 * contact a provider. Sandbox enforcement has its own boundary tests.
 */
class ConstructionOnlyPiWorkerRuntimeFactory extends PiWorkerRuntimeFactory {
  protected override async createSandboxTools(worktreePath: string): Promise<ToolDefinition<any, any, any>[]> {
    return [
      createReadToolDefinition(worktreePath),
      createBashToolDefinition(worktreePath),
      createEditToolDefinition(worktreePath),
      createWriteToolDefinition(worktreePath),
    ];
  }
}

describe("PiWorkerRuntimeFactory", () => {
  it("constructs a persistent Pi session through the real locked SDK without calling a model", async () => {
    const fixture = await createTempRepository();
    try {
      const factory = new ConstructionOnlyPiWorkerRuntimeFactory(`${fixture.root}/pi-sessions`);
      factory.setSessionDefaults({ model: FIXTURE_MODEL, projectTrusted: true });
      const runtime = await factory.create({
        workerId: "W-001",
        worktreePath: fixture.repo,
        contract: CONTRACT,
        callbacks: {
          commit: async () => ({ commit: "a".repeat(40), files: [] }),
          progress: async () => undefined,
          escalate: async () => undefined,
          complete: async () => undefined,
        },
      });
      expect(runtime.id).toBe("W-001");
      expect(runtime.sessionRef).toMatch(/\.jsonl$/);
      expect(runtime.sessionRef).not.toContain(fixture.repo);
      await runtime.dispose();
    } finally {
      await fixture.cleanup();
    }
  });

  it("surfaces missing restored-model selection synchronously without invoking a provider", async () => {
    const fixture = await createTempRepository();
    try {
      const sessionDir = join(fixture.root, "existing-pi-session");
      await mkdir(sessionDir, { recursive: true });
      const manager = SessionManager.create(fixture.repo, sessionDir, { id: "intentum-restore-probe" });
      manager.appendSessionInfo("Intentum restore probe");
      const sessionRef = manager.getSessionFile();
      if (!sessionRef) throw new Error("Pi did not create a persistent session reference");

      const restore = new ConstructionOnlyPiWorkerRuntimeFactory(join(fixture.root, "new-pi-sessions")).restore({
        workerId: "W-001",
        worktreePath: fixture.repo,
        sessionRef,
        contract: CONTRACT,
        callbacks: {
          commit: async () => ({ commit: "a".repeat(40), files: [] }),
          progress: async () => undefined,
          escalate: async () => undefined,
          complete: async () => undefined,
        },
      });
      // Dispose instead of leaking when a session is unexpectedly constructed:
      // asserting on the outcome keeps the failure message about model
      // selection rather than about the TUI theme Vitest touches while
      // serializing a live AgentSession.
      const outcome = await restore.then(
        async (runtime) => {
          await runtime.dispose();
          return "restore constructed a Worker session instead of rejecting";
        },
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(outcome).toContain("model selection requires explicit review");
    } finally {
      await fixture.cleanup();
    }
  });

  it("forwards only the final unretried Pi provider error before agent_settled", async () => {
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const session = {
      sessionFile: "/tmp/intentum-provider-error.jsonl",
      subscribe(next: (event: AgentSessionEvent) => void) {
        listener = next;
        return () => { listener = undefined; };
      },
      prompt: async () => undefined,
      steer: async () => undefined,
      followUp: async () => undefined,
      abort: async () => undefined,
      waitForIdle: async () => undefined,
      dispose: () => undefined,
    } as unknown as AgentSession;
    const runtime = new PiWorkerRuntime("W-001", session);
    const events: Array<{ type: string; error?: string }> = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));

    listener?.({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "temporary provider failure" },
    } as AgentSessionEvent);
    listener?.({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop" },
    } as AgentSessionEvent);
    listener?.({ type: "agent_settled" });
    expect(events).toEqual([
      { type: "session_ref_changed", sessionRef: "/tmp/intentum-provider-error.jsonl" },
      { type: "session_ref_changed", sessionRef: "/tmp/intentum-provider-error.jsonl" },
      { type: "settled" },
    ]);

    events.length = 0;
    listener?.({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "final credential failure" },
    } as AgentSessionEvent);
    listener?.({ type: "agent_settled" });
    expect(events).toEqual([
      { type: "session_ref_changed", sessionRef: "/tmp/intentum-provider-error.jsonl" },
      { type: "turn_failed", error: "final credential failure" },
      { type: "settled" },
    ]);

    unsubscribe();
    await runtime.dispose();
  });
});
