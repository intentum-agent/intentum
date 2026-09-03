import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import { clearIntentumWelcome, registerIntentumCommands } from "../src/tools/commands.js";
import { registerDesignerTools } from "../src/tools/designer-tools.js";

export default function intentumExtension(pi: ExtensionAPI): void {
  let runtime: IntentumRuntime | undefined;
  const requireRuntime = () => {
    if (!runtime) throw new Error("intentum session has not started yet");
    return runtime;
  };

  registerIntentumCommands(pi, requireRuntime);
  registerDesignerTools(pi, requireRuntime);

  pi.on("session_start", async (_event, ctx) => {
    // A restored/reloaded Pi session must never replay the one-time welcome frame.
    clearIntentumWelcome(ctx.ui);
    if (runtime) await runtime.dispose();
    runtime = new IntentumRuntime(ctx.cwd);
    const recovery = await runtime.onSessionStart(ctx);
    if (recovery.reconciled.length > 0) {
      ctx.ui.notify(
        `intentum reconciled ${recovery.reconciled.length} durable Worker result(s) after restart (${recovery.reconciled.join(", ")}). Inspect the preserved result before integration or replacement work.`,
        "warning",
      );
    }
    if (recovery.interrupted.length > 0) {
      const resources = recovery.interrupted
        .map((item) => `${item.workerId}: worktree ${item.worktreePresent ? "present" : "missing"}, session ${item.sessionPresent ? "present" : "missing"}`)
        .join("; ");
      ctx.ui.notify(
        `intentum found ${recovery.interrupted.length} interrupted Worker record(s). ${resources}. Review them before resume.`,
        "warning",
      );
    }
    if (recovery.abandoned.length > 0) {
      const records = recovery.abandoned.map((item) => item.workerId).join(", ");
      ctx.ui.notify(
        `intentum abandoned ${recovery.abandoned.length} unrecoverable startup record(s) (${records}) and released the Worker slot. Inspect preserved Git refs before creating replacement work.`,
        "warning",
      );
    }
    if (recovery.needsAttention.length > 0) {
      const records = recovery.needsAttention.map((item) => item.workerId).join(", ");
      ctx.ui.notify(
        `intentum has ${recovery.needsAttention.length} preserved unfinished Worker record(s) requiring attention (${records}). Inspect, resume, or explicitly resolve them before creating new work.`,
        "warning",
      );
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // The welcome is a first frame, not permanent chrome or transcript content.
    clearIntentumWelcome(ctx.ui);
    const runtime = requireRuntime();
    await runtime.assertContextRoot(ctx.cwd);
    const designerContext = await runtime.designerContext();
    return designerContext ? { systemPrompt: `${event.systemPrompt}\n\n${designerContext}` } : undefined;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearIntentumWelcome(ctx.ui);
    const current = runtime;
    runtime = undefined;
    await current?.dispose();
  });
}
