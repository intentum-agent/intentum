import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import { clearIntentumWelcome, registerIntentumCommands } from "../src/tools/commands.js";
import { registerDesignerTools } from "../src/tools/designer-tools.js";
import { registerBuiltinToolRenderers } from "../src/tools/transcript/builtin-renderers.js";
import {
  designerWorkingIndicator,
  hostChromeStyle,
  installSessionChrome,
  reducedMotionEnabled,
} from "../src/tui/session-chrome.js";
import { installThinkingPresentation } from "../src/tui/thinking-presentation.js";
import { registerModelPicker } from "../src/tools/model-picker-host.js";

export default function intentumExtension(pi: ExtensionAPI): void {
  let runtime: IntentumRuntime | undefined;
  let disposeChrome: (() => void) | undefined;
  const requireRuntime = () => {
    if (!runtime) throw new Error("intentum session has not started yet");
    return runtime;
  };

  registerIntentumCommands(pi, requireRuntime);
  registerModelPicker(pi);
  registerDesignerTools(pi, requireRuntime);
  // Reasoning and tool activity render in the transcript style; the working
  // row pulses while the Designer thinks and returns to its indicator after.
  const reducedMotion = reducedMotionEnabled();
  installThinkingPresentation(pi, {
    idleIndicator: (ctx) => designerWorkingIndicator(hostChromeStyle(ctx), reducedMotion),
    reducedMotion,
  });

  pi.on("session_start", async (_event, ctx) => {
    // A restored/reloaded Pi session must never replay the one-time welcome frame.
    clearIntentumWelcome(ctx.ui);
    disposeChrome?.();
    if (runtime) await runtime.dispose();
    runtime = new IntentumRuntime(ctx.cwd);
    // Pi's built-in tools keep their behavior; only their transcript frames
    // change. They need the session cwd, so this waits for the session.
    registerBuiltinToolRenderers(pi, ctx.cwd);
    const recovery = await runtime.onSessionStart(ctx);
    // Pi's startup hints and three-line footer give way to one card and one line.
    disposeChrome = await installSessionChrome(runtime, ctx);
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
    let designerContext: string | undefined;
    try {
      designerContext = await runtime.designerContext();
    } catch (error) {
      // A lost lease or unreadable state must not make every Designer turn
      // fail; the Designer can still run and the next command reports it.
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`intentum could not load its Designer context: ${message}`, "warning");
      return undefined;
    }
    return designerContext ? { systemPrompt: `${event.systemPrompt}\n\n${designerContext}` } : undefined;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearIntentumWelcome(ctx.ui);
    disposeChrome?.();
    disposeChrome = undefined;
    const current = runtime;
    runtime = undefined;
    await current?.dispose();
  });
}
