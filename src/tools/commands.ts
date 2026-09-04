import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { IntentumRuntime } from "../runtime/intentum-runtime.js";
import type { ProjectState, WorkerRecord } from "../state/schema.js";
import { openControlPanel } from "./control-panel-host.js";
import type { PanelTab } from "../tui/control-panel.js";
import { renderStatusBrief } from "../tui/status-widget.js";
import {
  BRAND_WIDGET_KEY,
  type BrandAssets,
  loadBrandAssets,
  normalizeTerminalColumns,
  renderBrandFrameFromAssets,
  styleBrandFrame,
} from "../tui/brand.js";

export type IntentumRuntimeSource = IntentumRuntime | (() => IntentumRuntime);

export interface IntentumCommandPresentation {
  /** One-time per Pi session/runtime, regardless of which welcome path displayed it. */
  welcomeShown: boolean;
  /** Shared claim while brand assets are loading and the widget is being published. */
  welcomeInFlight?: Promise<void>;
}

const runtimePresentations = new WeakMap<IntentumRuntime, IntentumCommandPresentation>();

export function registerIntentumCommands(pi: ExtensionAPI, runtimeSource: IntentumRuntimeSource): void {
  pi.registerCommand("intentum", {
    description: "Open the intentum control panel, or init, inspect, pause, resume, steer, and integrate the project",
    handler: async (rawArgs, ctx) => {
      try {
        const runtime = resolveRuntime(runtimeSource);
        await handleIntentumCommand(runtime, rawArgs, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

/**
 * A project named after the tool itself would read "intentum initialized intentum".
 */
function initMessage(projectName: string, created: boolean): string {
  const tail = created ? "in discovery phase." : "existing artifacts were preserved.";
  if (projectName.trim().toLowerCase() === "intentum") {
    return created ? `Project intentum initialized ${tail}` : `Project intentum is already initialized; ${tail}`;
  }
  return created ? `intentum initialized ${projectName} ${tail}` : `intentum already initialized ${projectName}; ${tail}`;
}

function resolveRuntime(source: IntentumRuntimeSource): IntentumRuntime {
  return typeof source === "function" ? source() : source;
}

export async function handleIntentumCommand(
  runtime: IntentumRuntime,
  rawArgs: string,
  ctx: ExtensionCommandContext,
  presentation = presentationFor(runtime),
): Promise<void> {
  await runtime.assertContextRoot(ctx.cwd);
  const [command = "", ...args] = splitArguments(rawArgs);

  switch (command.toLowerCase()) {
    case "init": {
      clearIntentumWelcome(ctx.ui);
      const name = args.join(" ").trim() || undefined;
      const result = await runtime.initialize(name);
      if (result.created) await showIntentumWelcomeOnce(ctx, presentation);
      ctx.ui.notify(initMessage(result.state.projectName, result.created), "info");
      return;
    }
    case "status": {
      clearIntentumWelcome(ctx.ui);
      ctx.ui.notify(renderStatusBrief((await runtime.status()).state), "info");
      return;
    }
    case "workers": {
      clearIntentumWelcome(ctx.ui);
      const { state } = await runtime.status();
      if (ctx.mode === "tui") return openControlPanel(runtime, ctx, state, "workers");
      const workers = Object.values(state.workers);
      ctx.ui.notify(
        workers.length
          ? workers.map((worker) => `${worker.id} · ${worker.status} · ${worker.progressSummary ?? worker.objective}`).join("\n")
          : "No Worker has been started.",
        "info",
      );
      return;
    }
    case "panel":
    case "decisions": {
      clearIntentumWelcome(ctx.ui);
      const { state } = await runtime.status();
      const tab: PanelTab = command.toLowerCase() === "decisions" ? "decisions" : "overview";
      if (ctx.mode === "tui") return openControlPanel(runtime, ctx, state, tab);
      const decisions = state.pendingDecisions;
      ctx.ui.notify(
        decisions.length
          ? decisions.map((decision) => `${decision.id} · ${decision.blocking ? "blocking" : "open"} · ${decision.title}`).join("\n")
          : "No pending decision.",
        "info",
      );
      return;
    }
    case "pause": {
      clearIntentumWelcome(ctx.ui);
      await runtime.pauseProject();
      ctx.ui.notify("Project paused. Active Workers stop at their next safe point; worktrees are kept.", "warning");
      return;
    }
    case "resume": {
      clearIntentumWelcome(ctx.ui);
      const state = await runtime.resumeProject();
      ctx.ui.notify(`Project resumed in ${state.phase} phase.`, "info");
      return;
    }
    case "steer": {
      clearIntentumWelcome(ctx.ui);
      const [workerId, ...messageParts] = args;
      if (!workerId || messageParts.length === 0) throw new Error("usage: /intentum steer WORKER_ID message");
      await runtime.workers.steer(workerId, messageParts.join(" "));
      ctx.ui.notify(`Instruction sent or queued for ${workerId}.`, "info");
      return;
    }
    case "worker-resume": {
      clearIntentumWelcome(ctx.ui);
      const [workerId, ...messageParts] = args;
      if (!workerId) throw new Error("usage: /intentum worker-resume WORKER_ID [message]");
      runtime.setWorkerSessionDefaults(ctx);
      await runtime.workers.resume(workerId, messageParts.join(" ") || undefined);
      ctx.ui.notify(`Resuming ${workerId} in its preserved Pi session and worktree.`, "info");
      return;
    }
    case "integrate": {
      clearIntentumWelcome(ctx.ui);
      const [workerId] = args;
      if (!workerId) throw new Error("usage: /intentum integrate WORKER_ID");
      const { state } = await runtime.status();
      if (state.autonomy === "guided") {
        const confirmed = await ctx.ui.confirm(
          "Integrate Worker result",
          `Merge ${workerId} into its recorded target branch? The result commit and clean worktree will be verified first.`,
        );
        if (!confirmed) {
          ctx.ui.notify("Integration left unchanged.", "info");
          return;
        }
      }
      await runtime.workers.integrateWorker(workerId);
      ctx.ui.notify(`${workerId} integrated into its recorded target branch.`, "info");
      return;
    }
    case "abort": {
      clearIntentumWelcome(ctx.ui);
      const [workerId, ...reasonParts] = args;
      if (!workerId || reasonParts.length === 0) throw new Error("usage: /intentum abort WORKER_ID reason");
      const confirmed = await ctx.ui.confirm(
        "Emergency abort",
        `Abort the current turn for ${workerId}? Session, branch, worktree, and files will be preserved.`,
      );
      if (!confirmed) return;
      await runtime.workers.abort(workerId, reasonParts.join(" "));
      ctx.ui.notify(`${workerId} interrupted; preserved artifacts remain available.`, "warning");
      return;
    }
    case "": {
      if (!(await runtime.store.exists())) {
        await showIntentumWelcomeOnce(ctx, presentation);
        ctx.ui.notify(uninitializedHelp(), "info");
        return;
      }
      clearIntentumWelcome(ctx.ui);
      const { state } = await runtime.status();
      if (ctx.mode === "tui") return openControlPanel(runtime, ctx, state);
      ctx.ui.notify(relevantHelp(state), "info");
      return;
    }
    case "help": {
      clearIntentumWelcome(ctx.ui);
      const state = (await runtime.store.exists()) ? (await runtime.status()).state : undefined;
      ctx.ui.notify(state ? relevantHelp(state) : uninitializedHelp(), "info");
      return;
    }
    default:
      clearIntentumWelcome(ctx.ui);
      throw new Error(`unknown /intentum action: ${command}`);
  }
}

function presentationFor(runtime: IntentumRuntime): IntentumCommandPresentation {
  let presentation = runtimePresentations.get(runtime);
  if (!presentation) {
    presentation = { welcomeShown: false };
    runtimePresentations.set(runtime, presentation);
  }
  return presentation;
}

/**
 * The welcome banner is an ephemeral editor-adjacent widget, never a transcript
 * notification. Reusing one key means repeated welcome requests replace the
 * existing frame rather than accumulating banners.
 */
export async function showIntentumWelcome(
  ctx: Pick<ExtensionCommandContext, "ui" | "mode">,
  columns?: number,
): Promise<boolean> {
  try {
    const assets = await loadBrandAssets();
    if (ctx.mode !== "tui") {
      const frame = renderBrandFrameFromAssets(assets, columns === undefined ? {} : { columns });
      ctx.ui.setWidget(BRAND_WIDGET_KEY, frame.lines.slice(), { placement: "aboveEditor" });
      return true;
    }
    ctx.ui.setWidget(
      BRAND_WIDGET_KEY,
      (_tui, theme) => new ResponsiveBrandWidget(
        assets,
        (signal) => theme.fg("error", signal),
        columns,
      ),
      { placement: "aboveEditor" },
    );
    return true;
  } catch {
    // Branding is observational. Missing assets or a UI failure must not make
    // an already-durable init/status transition appear to have failed.
    return false;
  }
}

async function showIntentumWelcomeOnce(
  ctx: Pick<ExtensionCommandContext, "ui" | "mode">,
  presentation: IntentumCommandPresentation,
): Promise<void> {
  if (presentation.welcomeShown) return;
  if (presentation.welcomeInFlight) return presentation.welcomeInFlight;

  const attempt = showIntentumWelcome(ctx).then((published) => {
    // Only a successfully published widget consumes the one-time state.
    // Transient asset/UI failures leave welcomeShown false for a later retry.
    if (published) presentation.welcomeShown = true;
  });
  presentation.welcomeInFlight = attempt;
  try {
    await attempt;
  } finally {
    if (presentation.welcomeInFlight === attempt) delete presentation.welcomeInFlight;
  }
}

class ResponsiveBrandWidget extends Container {
  constructor(
    private readonly assets: BrandAssets,
    private readonly colorSignal: (text: string) => string,
    private readonly columnsOverride: number | undefined,
  ) {
    super();
  }

  override render(width: number): string[] {
    const boundedWidth = Math.max(1, Math.floor(width));
    const detectedColumns = this.columnsOverride ?? process.stdout.columns;
    const availableColumns = Math.min(normalizeTerminalColumns(detectedColumns), boundedWidth);
    const frame = renderBrandFrameFromAssets(this.assets, { columns: availableColumns });
    this.clear();
    for (const line of styleBrandFrame(frame, this.colorSignal)) {
      this.addChild(new Text(line, 0, 0));
    }
    return super.render(boundedWidth);
  }
}

/** Best-effort cleanup keeps branding presentation from becoming a lifecycle gate. */
export function clearIntentumWelcome(ui: Pick<ExtensionUIContext, "setWidget">): void {
  try {
    ui.setWidget(BRAND_WIDGET_KEY, undefined);
  } catch {
    // UI cleanup is observational; command and recovery semantics remain canonical.
  }
}

function uninitializedHelp(): string {
  return [
    "/intentum init [project name]",
    "Describe the target users and primary outcome in normal conversation.",
    "Share constraints and non-goals in normal conversation.",
    "/intentum help",
  ].join("\n");
}

function relevantHelp(state: ProjectState): string {
  const workers = Object.values(state.workers);
  const lines = ["/intentum  (control panel)", "/intentum status", "/intentum workers"];
  if (state.pendingDecisions.length) lines.push("/intentum decisions");

  if (state.phase === "paused" || state.schedulerPaused) {
    lines.push("/intentum resume");
  } else {
    lines.push("/intentum pause");
  }

  const resumable = workers.find((worker) => worker.status === "paused" || worker.status === "interrupted");
  const completed = workers.find((worker) => worker.status === "completed");
  const active = workers.find(isActiveWorker);
  if (resumable) lines.push(`/intentum worker-resume ${resumable.id} [message]`);
  if (completed) lines.push(`/intentum integrate ${completed.id}`);
  if (active) lines.push(`/intentum steer ${active.id} message`);

  lines.push("Use normal conversation for product decisions and new Worker outcomes.");
  return lines.slice(0, 8).join("\n");
}

function isActiveWorker(worker: WorkerRecord): boolean {
  return ["starting", "working", "pause_requested", "verifying"].includes(worker.status);
}

export function splitArguments(value: string): string[] {
  const matches = value.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) ?? [];
  return matches.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1).replace(/\\([\\"'])/g, "$1");
    }
    return token;
  });
}
