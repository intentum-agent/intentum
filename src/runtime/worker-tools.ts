import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { WorkerCallbacks } from "./worker-runtime.js";
import type { WorkerResultInput } from "../work/result.js";

const testRunSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  status: StringEnum(["passed", "failed", "not_run"] as const),
  exitCode: Type.Optional(Type.Integer()),
  durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  summary: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export function createWorkerTools(callbacks: WorkerCallbacks): ToolDefinition[] {
  const commit = defineTool({
    name: "intentum_commit",
    label: "intentum commit",
    description: "Create a controller-validated commit from the current Worker worktree changes.",
    promptSnippet: "Use intentum_commit instead of Git mutation commands in bash.",
    executionMode: "sequential",
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: 200 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = await callbacks.commit(params, signal);
      return {
        content: [{ type: "text", text: `Committed ${result.commit}: ${result.files.join(", ")}` }],
        details: result,
        terminate: false,
      };
    },
  });

  const progress = defineTool({
    name: "intentum_progress",
    label: "intentum progress",
    description: "Report a meaningful implementation milestone or acknowledge a safe pause request.",
    promptSnippet: "Report only meaningful Worker progress or a confirmed safe pause.",
    executionMode: "sequential",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 2_000 }),
      state: Type.Optional(StringEnum(["working", "paused"] as const)),
      wipCommit: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      await callbacks.progress(params);
      return {
        content: [{ type: "text", text: params.state === "paused" ? "Safe pause recorded; end this turn now." : "Progress recorded." }],
        details: params,
        terminate: params.state === "paused",
      };
    },
  });

  const escalate = defineTool({
    name: "intentum_escalate",
    label: "intentum escalate",
    description: "Escalate a blocker, architecture concern, ambiguity, conflict, or destructive change to the Designer.",
    promptSnippet: "Escalate decisions instead of asking the Human directly.",
    executionMode: "sequential",
    parameters: Type.Object({
      kind: StringEnum([
        "blocker",
        "architecture_concern",
        "requirement_ambiguity",
        "interface_conflict",
        "destructive_change",
      ] as const),
      summary: Type.String({ minLength: 1, maxLength: 2_000 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      await callbacks.escalate(params);
      return {
        content: [{ type: "text", text: "Escalation recorded; stop at a safe boundary." }],
        details: params,
        terminate: true,
      };
    },
  });

  const complete = defineTool({
    name: "intentum_complete",
    label: "intentum complete",
    description: "Submit the factual structured result after committing and verifying the Worker outcome.",
    promptSnippet: "End every Worker run with one factual intentum_complete result.",
    executionMode: "sequential",
    parameters: Type.Object({
      status: StringEnum(["completed", "blocked", "failed"] as const),
      summary: Type.String({ minLength: 1, maxLength: 4_000 }),
      userVisibleChanges: Type.Array(Type.String()),
      filesChanged: Type.Array(Type.String()),
      testsRun: Type.Array(testRunSchema),
      architectureConcerns: Type.Array(Type.String()),
      remainingRisks: Type.Array(Type.String()),
      suggestedFollowUps: Type.Array(Type.String()),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      await callbacks.complete(params as WorkerResultInput, signal);
      return {
        content: [{ type: "text", text: "Structured Worker result accepted." }],
        details: params,
        terminate: true,
      };
    },
  });

  return [commit, progress, escalate, complete];
}
