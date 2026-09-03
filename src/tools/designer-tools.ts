import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { IntentumRuntime } from "../runtime/intentum-runtime.js";
import type { IntentumRuntimeSource } from "./commands.js";
import type { ProjectPhase } from "../state/schema.js";
import type { ProjectArtifact } from "../state/project-store.js";

const phaseSchema = StringEnum([
  "discovery",
  "direction",
  "architecture",
  "build",
  "verify",
  "review",
  "ship",
  "maintain",
  "paused",
] as const);

export function registerDesignerTools(pi: ExtensionAPI, runtimeSource: IntentumRuntimeSource): void {
  pi.registerTool(defineTool({
    name: "intentum_project",
    label: "intentum project",
    description: "Read or update durable product artifacts and move through the explicit project lifecycle.",
    promptSnippet: "Use intentum_project for charter, architecture, status, and lifecycle changes.",
    executionMode: "sequential",
    parameters: Type.Object({
      action: StringEnum(["status", "read_artifact", "write_artifact", "transition"] as const),
      artifact: Type.Optional(StringEnum(["charter", "architecture"] as const)),
      content: Type.Optional(Type.String()),
      phase: Type.Optional(phaseSchema),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = resolveRuntime(runtimeSource);
      await runtime.assertContextRoot(ctx.cwd);
      if (params.action === "status") return toolResult((await runtime.status()).text);
      if (params.action === "read_artifact") {
        if (!params.artifact) throw new Error("artifact is required for read_artifact");
        return toolResult(await runtime.readArtifact(params.artifact as ProjectArtifact));
      }
      if (params.action === "write_artifact") {
        if (!params.artifact || !params.content) throw new Error("artifact and content are required for write_artifact");
        await runtime.writeArtifact(params.artifact as ProjectArtifact, params.content);
        return toolResult(`${params.artifact} updated.`);
      }
      if (!params.phase) throw new Error("phase is required for transition");
      const state = await runtime.transition(params.phase as ProjectPhase);
      return toolResult(`Project moved to ${state.phase}.`);
    },
  }));

  pi.registerTool(defineTool({
    name: "intentum_create_work",
    label: "intentum create work",
    description: "Create and start one broad outcome-based WorkContract in an independent Pi Worker and Git worktree.",
    promptSnippet: "Use intentum_create_work for a complete vertical slice, not microtasks.",
    executionMode: "sequential",
    parameters: Type.Object({
      featureId: Type.String({ minLength: 1 }),
      title: Type.String({ minLength: 1 }),
      objective: Type.String({ minLength: 1 }),
      why: Type.String({ minLength: 1 }),
      userVisibleResult: Type.String({ minLength: 1 }),
      inScope: Type.Array(Type.String()),
      outOfScope: Type.Array(Type.String()),
      interfaces: Type.Array(Type.String()),
      constraints: Type.Array(Type.String()),
      acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
      dependencies: Type.Array(Type.String()),
      touchHints: Type.Array(Type.String()),
      risk: StringEnum(["low", "medium", "high"] as const),
      preferredWorkerKind: StringEnum(["implementation", "fix", "integration"] as const),
      contextFiles: Type.Array(Type.String()),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = resolveRuntime(runtimeSource);
      await runtime.assertContextRoot(ctx.cwd);
      runtime.setWorkerSessionDefaults(ctx);
      const worker = await runtime.createWork({
        featureId: params.featureId,
        title: params.title,
        objective: params.objective,
        why: params.why,
        userVisibleResult: params.userVisibleResult,
        scope: { inScope: params.inScope, outOfScope: params.outOfScope },
        interfaces: params.interfaces,
        constraints: params.constraints,
        acceptanceCriteria: params.acceptanceCriteria,
        dependencies: params.dependencies,
        touchHints: params.touchHints,
        risk: params.risk,
        preferredWorkerKind: params.preferredWorkerKind,
        contextFiles: params.contextFiles,
      });
      return toolResult(`${worker.id} started in ${worker.worktreePath} on ${worker.branch}.`);
    },
  }));

  pi.registerTool(defineTool({
    name: "intentum_worker",
    label: "intentum worker",
    description: "Inspect, safely pause, steer, resume, or explicitly abort the current Phase 2 Worker.",
    promptSnippet: "Use intentum_worker to operate the persistent Worker without replacing its session.",
    executionMode: "sequential",
    parameters: Type.Object({
      action: StringEnum(["inspect", "pause", "steer", "resume", "abort"] as const),
      workerId: Type.String({ minLength: 1 }),
      message: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = resolveRuntime(runtimeSource);
      await runtime.assertContextRoot(ctx.cwd);
      if (params.action === "inspect") return toolResult(JSON.stringify(await runtime.workers.inspect(params.workerId), null, 2));
      if (params.action === "pause") return toolResult(JSON.stringify(await runtime.workers.requestPause(params.workerId), null, 2));
      if (params.action === "steer") {
        if (!params.message) throw new Error("message is required for steer");
        return toolResult(JSON.stringify(await runtime.workers.steer(params.workerId, params.message), null, 2));
      }
      if (params.action === "resume") {
        runtime.setWorkerSessionDefaults(ctx);
        return toolResult(JSON.stringify(await runtime.workers.resume(params.workerId, params.message), null, 2));
      }
      if (!params.message) throw new Error("an explicit reason is required for abort");
      await requireConfirmation(ctx, "Emergency Worker abort", `Abort ${params.workerId}'s current turn while preserving its session and worktree?`);
      return toolResult(JSON.stringify(await runtime.workers.abort(params.workerId, params.message), null, 2));
    },
  }));

  pi.registerTool(defineTool({
    name: "intentum_integrate",
    label: "intentum integrate",
    description: "Verify and deterministically merge a completed Worker result into its recorded target branch.",
    promptSnippet: "Use intentum_integrate only after structured Worker completion.",
    executionMode: "sequential",
    parameters: Type.Object({ workerId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = resolveRuntime(runtimeSource);
      await runtime.assertContextRoot(ctx.cwd);
      const { state } = await runtime.status();
      if (state.autonomy === "guided") {
        await requireConfirmation(ctx, "Integrate Worker result", `Merge ${params.workerId} into its recorded target branch?`);
      }
      return toolResult(JSON.stringify(await runtime.workers.integrateWorker(params.workerId), null, 2));
    },
  }));
}

function resolveRuntime(source: IntentumRuntimeSource): IntentumRuntime {
  return typeof source === "function" ? source() : source;
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

async function requireConfirmation(ctx: ExtensionContext, title: string, message: string): Promise<void> {
  if (!ctx.hasUI) throw new Error(`${title} requires explicit user confirmation in guided mode`);
  if (!(await ctx.ui.confirm(title, message))) throw new Error(`${title} was not confirmed`);
}
