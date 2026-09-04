import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type OverlayHandle, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";
import type { IntentumRuntime } from "../runtime/intentum-runtime.js";
import type { ProjectState, WorkerRecord } from "../state/schema.js";
import { intentumLabel } from "../tui/brand.js";
import { renderStatusBrief } from "../tui/status-widget.js";
import { deriveHarnessPresentation } from "../tui/presentation.js";
import { singleLine } from "../tui/text-layout.js";
import {
  centeredOverlayOrigin,
  IntentumControlPanel,
  parseMouseSequences,
  type MouseAvailability,
  type PanelAction,
  type PanelActionState,
  type PanelStyle,
  type PanelTab,
  type SgrMouseEvent,
} from "../tui/control-panel.js";

/** Press/release reports with SGR encoding; no motion, so multiplexers stay quiet. */
export const ENABLE_MOUSE_REPORTS = "\u001b[?1000h\u001b[?1006h";
export const DISABLE_MOUSE_REPORTS = "\u001b[?1006l\u001b[?1000l";

const MAX_PANEL_WIDTH = 100;
const MAX_BODY_ROWS = 24;
/** Title, tabs, two rules, hint line, bottom border. */
const PANEL_CHROME_ROWS = 6;
export const MIN_INTERACTIVE_PANEL_COLUMNS = 60;
export const MIN_INTERACTIVE_PANEL_ROWS = 16;
export const WIDE_PANEL_COLUMNS = 100;
export const WIDE_PANEL_ROWS = 22;
const LEFT_BUTTON = 0;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const PANEL_PULSE_INTERVAL_MS = 360;
const ACTION_SUCCESS_HOLD_MS = 700;

export type PanelSurface =
  | { kind: "fallback"; columns: number; rows: number }
  | { kind: "workspace"; columns: number; rows: number; width: number; bodyRows: number; density: "wide" | "compact" }
  | { kind: "dialog"; columns: number; rows: number; width: number; bodyRows: number; density: "wide" | "compact" };

export interface PanelStyleSource {
  fg(color: "accent" | "dim" | "muted" | "success" | "warning" | "error" | "border" | "text", text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

export function panelStyleFromTheme(theme: PanelStyleSource): PanelStyle {
  return {
    accent: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold(text),
    dim: (text) => theme.fg("dim", text),
    muted: (text) => theme.fg("muted", text),
    success: (text) => theme.fg("success", text),
    warning: (text) => theme.fg("warning", text),
    error: (text) => theme.fg("error", text),
    border: (text) => theme.fg("border", text),
    // Pair the selection background with the theme's own text colour: the
    // terminal default foreground is not guaranteed to contrast with it.
    focus: (text) => theme.bg("selectedBg", theme.fg("text", theme.bold(text))),
  };
}

export function panelWidthFor(columns: number): number {
  return Math.max(1, Math.min(MAX_PANEL_WIDTH, Math.floor(columns)));
}

export function panelBodyRowsFor(rows: number): number {
  return Math.max(3, Math.min(MAX_BODY_ROWS, Math.floor(rows) - PANEL_CHROME_ROWS - 2));
}

/**
 * Fullscreen is Intentum's primary surface: it receives a temporary viewport-
 * filling workspace. Regular mode keeps a centred dialog and mouse support.
 * Terminals below the readable floor fall back to a plain notification rather
 * than publishing clipped or unreachable controls.
 */
export function panelSurfaceFor(
  columns: number,
  rows: number,
  mode: Pick<TUI, "mode">["mode"],
): PanelSurface {
  const safeColumns = Math.max(1, Math.floor(columns));
  const safeRows = Math.max(1, Math.floor(rows));
  if (safeColumns < MIN_INTERACTIVE_PANEL_COLUMNS || safeRows < MIN_INTERACTIVE_PANEL_ROWS) {
    return { kind: "fallback", columns: safeColumns, rows: safeRows };
  }
  const density = safeColumns >= WIDE_PANEL_COLUMNS && safeRows >= WIDE_PANEL_ROWS ? "wide" : "compact";
  if (mode === "fullscreen") {
    return {
      kind: "workspace",
      columns: safeColumns,
      rows: safeRows,
      width: safeColumns,
      bodyRows: Math.max(3, safeRows - PANEL_CHROME_ROWS),
      density,
    };
  }
  return {
    kind: "dialog",
    columns: safeColumns,
    rows: safeRows,
    width: panelWidthFor(safeColumns),
    bodyRows: panelBodyRowsFor(safeRows),
    density,
  };
}

export function mouseAvailabilityFor(tui: Pick<TUI, "mode">): MouseAvailability {
  // The alternate-screen renderer consumes every SGR mouse report for
  // viewport scrolling and selection before extension listeners see it.
  return tui.mode === "regular" ? "available" : "fullscreen";
}

export function reducedMotionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INTENTUM_REDUCED_MOTION === "1" || env.TERM === "dumb";
}

export function hasAnimatedWorker(state: ProjectState): boolean {
  return Object.values(state.workers).some((worker) => (
    worker.status === "starting" || worker.status === "working" || worker.status === "verifying"
  ));
}

export interface PanelActionHost {
  runtime: IntentumRuntime;
  ctx: ExtensionCommandContext;
  state: () => ProjectState;
  close: () => void;
  withPanelHidden?<T>(operation: () => Promise<T>): Promise<T>;
}

export type PanelActionOutcome =
  | { status: "success"; message: string }
  | { status: "cancelled" }
  | { status: "closed" };

/**
 * Show the control center as a focused overlay. Mouse reports are enabled for
 * the panel's lifetime only, so the terminal's native selection and scrollback
 * return the moment it closes.
 */
export async function openControlPanel(
  runtime: IntentumRuntime,
  ctx: ExtensionCommandContext,
  state: ProjectState,
  initialTab: PanelTab = "overview",
): Promise<void> {
  // Pi resolves overlay options once when the overlay is shown but reads the
  // resulting object on every frame, so the factory shares one mutable object.
  let overlayOptions: OverlayOptions = {};
  let overlayHandle: OverlayHandle | undefined;
  let fallbackMessage: string | undefined;

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let surface = panelSurfaceFor(tui.terminal.columns, tui.terminal.rows, tui.mode);
    if (surface.kind === "fallback") {
      fallbackMessage = renderPanelFallback(state, surface.columns, surface.rows);
      queueMicrotask(() => done());
      return {
        render: () => [],
        handleInput: () => undefined,
        invalidate: () => undefined,
      };
    }
    setOverlayOptions(overlayOptions, surface);
    let current = state;
    let closed = false;
    let busy = false;
    const reducedMotion = reducedMotionEnabled();
    const close = () => {
      if (closed) return;
      closed = true;
      done();
    };

    const panel = new IntentumControlPanel({
      state,
      initialTab,
      style: panelStyleFromTheme(theme),
      mouse: mouseAvailabilityFor(tui),
      bodyHeight: surface.bodyRows,
      fillBody: surface.kind === "workspace",
      density: surface.density,
      reducedMotion,
      onAction: (action) => {
        void runAction(action);
      },
    });

    const withPanelHidden = async <T>(operation: () => Promise<T>): Promise<T> => {
      overlayHandle?.setHidden(true);
      try {
        return await operation();
      } finally {
        if (!closed) {
          overlayHandle?.setHidden(false);
          overlayHandle?.focus();
          tui.requestRender();
        }
      }
    };
    const host: PanelActionHost = { runtime, ctx, state: () => current, close, withPanelHidden };
    let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
    let pulseTimer: ReturnType<typeof setInterval> | undefined;
    let pulseFrame = 0;
    const syncPulseTimer = () => {
      const shouldAnimate = !closed && !reducedMotion
        && surface.kind !== "fallback"
        && (busy || hasAnimatedWorker(current));
      if (shouldAnimate && !pulseTimer) {
        pulseTimer = setInterval(() => {
          if (closed) return;
          pulseFrame += 1;
          panel.setPulseFrame(pulseFrame);
          tui.requestRender();
        }, PANEL_PULSE_INTERVAL_MS);
      } else if (!shouldAnimate && pulseTimer) {
        clearInterval(pulseTimer);
        pulseTimer = undefined;
      }
    };
    const setActionState = (next: PanelActionState, clearAfter = false) => {
      if (feedbackTimer) {
        clearTimeout(feedbackTimer);
        feedbackTimer = undefined;
      }
      panel.setActionState(next);
      tui.requestRender();
      if (clearAfter && !closed) {
        feedbackTimer = setTimeout(() => {
          feedbackTimer = undefined;
          if (closed) return;
          panel.setActionState({ status: "idle" });
          tui.requestRender();
        }, ACTION_SUCCESS_HOLD_MS);
      }
    };
    const runAction = async (action: PanelAction): Promise<void> => {
      if (closed) return;
      if (busy) {
        ctx.ui.notify("Wait for the current control-center operation to finish.", "info");
        return;
      }
      busy = true;
      syncPulseTimer();
      if (action.type === "inspect-worker") {
        const requestedIdentity = workerEvidenceIdentity(current.workers[action.workerId]);
        panel.setWorkerDetailState(action.workerId, { status: "loading" });
        tui.requestRender();
        try {
          const detail = await runtime.workers.inspect(action.workerId);
          const latestIdentity = workerEvidenceIdentity(current.workers[action.workerId]);
          if (!closed && requestedIdentity !== undefined && requestedIdentity === latestIdentity) {
            panel.setWorkerDetailState(action.workerId, { status: "loaded", detail });
          } else if (!closed) {
            panel.setWorkerDetailState(action.workerId, { status: "idle" });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const latestIdentity = workerEvidenceIdentity(current.workers[action.workerId]);
          if (!closed && requestedIdentity !== undefined && requestedIdentity === latestIdentity) {
            panel.setWorkerDetailState(action.workerId, { status: "error", message });
          } else if (!closed) {
            panel.setWorkerDetailState(action.workerId, { status: "idle" });
          }
          ctx.ui.notify(message, "error");
        } finally {
          busy = false;
          panel.setSuspended(false);
          syncPulseTimer();
          if (!closed) tui.requestRender();
        }
        return;
      }
      panel.setSuspended(true);
      setActionState({ status: "loading", label: panelActionProgressLabel(action) });
      try {
        const outcome = await performPanelAction(host, action);
        if (!closed) {
          if (outcome.status === "success") setActionState({ status: "success", message: outcome.message }, true);
          else if (outcome.status === "cancelled") setActionState({ status: "idle" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!closed) setActionState({ status: "error", message });
        ctx.ui.notify(message, "error");
      } finally {
        busy = false;
        panel.setSuspended(false);
        syncPulseTimer();
        if (!closed) tui.requestRender();
      }
    };

    const unsubscribeState = runtime.onStateChange((next) => {
      current = next;
      panel.setState(next);
      syncPulseTimer();
      tui.requestRender();
    });
    syncPulseTimer();

    const handleMouse = (event: SgrMouseEvent): void => {
      if (event.release || busy || closed || surface.kind === "fallback") return;
      if (event.button === WHEEL_UP || event.button === WHEEL_DOWN) {
        panel.handleWheel(event.button === WHEEL_UP ? -1 : 1);
        tui.requestRender();
        return;
      }
      if (event.button !== LEFT_BUTTON) return;
      const origin = centeredOverlayOrigin(tui.terminal, {
        width: panel.width || panelWidthFor(tui.terminal.columns),
        height: panel.height,
      });
      const inside = panel.handleClick(event.x - origin.col, event.y - origin.row);
      if (!inside) close();
      tui.requestRender();
    };

    let stopMouse: (() => void) | undefined;
    if (mouseAvailabilityFor(tui) === "available") {
      tui.terminal.write(ENABLE_MOUSE_REPORTS);
      const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
        const { events, remainder } = parseMouseSequences(data);
        if (events.length === 0) return undefined;
        for (const event of events) handleMouse(event);
        return remainder.length === 0 ? { consume: true } : { data: remainder };
      });
      stopMouse = () => {
        unsubscribeInput();
        tui.terminal.write(DISABLE_MOUSE_REPORTS);
      };
    }

    return {
      render(width: number): string[] {
        const nextSurface = panelSurfaceFor(tui.terminal.columns, tui.terminal.rows, tui.mode);
        if (!sameSurface(surface, nextSurface)) {
          surface = nextSurface;
          setOverlayOptions(overlayOptions, surface);
          syncPulseTimer();
          queueMicrotask(() => tui.requestRender());
        }
        if (surface.kind === "fallback") {
          return fillViewport(
            renderInlineFallback(current, Math.max(1, Math.floor(width))),
            Math.max(1, Math.floor(width)),
            Math.max(1, tui.terminal.rows),
          );
        }
        panel.setBodyHeight(surface.bodyRows);
        panel.setFillBody(surface.kind === "workspace");
        panel.setDensity(surface.density);
        const lines = panel.render(width);
        return surface.kind === "workspace"
          ? fillViewport(lines, Math.max(1, Math.floor(width)), surface.rows)
          : lines;
      },
      handleInput(data: string): void {
        if (surface.kind === "fallback") {
          if (isCloseInput(data)) close();
          return;
        }
        if (busy && isCloseInput(data)) {
          ctx.ui.notify("The current operation will continue after the control center closes.", "info");
          close();
          return;
        }
        panel.handleInput(data);
        tui.requestRender();
      },
      invalidate(): void {
        panel.invalidate();
      },
      dispose(): void {
        closed = true;
        if (feedbackTimer) clearTimeout(feedbackTimer);
        if (pulseTimer) clearInterval(pulseTimer);
        unsubscribeState();
        stopMouse?.();
      },
    };
  }, {
    overlay: true,
    overlayOptions: () => overlayOptions,
    onHandle: (handle) => {
      overlayHandle = handle;
    },
  });

  if (fallbackMessage) ctx.ui.notify(fallbackMessage, "info");
}

function setOverlayOptions(target: OverlayOptions, surface: PanelSurface): void {
  for (const key of Object.keys(target) as Array<keyof OverlayOptions>) delete target[key];
  if (surface.kind === "workspace") {
    Object.assign(target, { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 });
    return;
  }
  if (surface.kind === "dialog") {
    Object.assign(target, { width: surface.width, maxHeight: surface.rows - 2, anchor: "center" });
    return;
  }
  Object.assign(target, { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 });
}

function sameSurface(left: PanelSurface, right: PanelSurface): boolean {
  if (left.kind !== right.kind || left.columns !== right.columns || left.rows !== right.rows) return false;
  if (left.kind === "fallback" || right.kind === "fallback") return true;
  return left.width === right.width && left.bodyRows === right.bodyRows && left.density === right.density;
}

function fillViewport(lines: readonly string[], width: number, height: number): string[] {
  const fitted = lines.slice(0, height).map((line) => fitLine(line, width));
  while (fitted.length < height) fitted.push(" ".repeat(width));
  return fitted;
}

function fitLine(line: string, width: number): string {
  const clipped = visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function renderPanelFallback(state: ProjectState, columns: number, rows: number): string {
  const presentation = deriveHarnessPresentation(state);
  return [
    `${singleLine(state.projectName)} · ${presentation.phase.label}`,
    `Next: ${presentation.primaryAction.label}.`,
    `Control center: ${MIN_INTERACTIVE_PANEL_COLUMNS}×${MIN_INTERACTIVE_PANEL_ROWS} required; current ${columns}×${rows}.`,
    "Use /intentum status or resize the terminal.",
  ].join("\n");
}

function renderInlineFallback(state: ProjectState, width: number): string[] {
  const lines = [
    `${intentumLabel()} · compact status`,
    "",
    ...renderStatusBrief(state).split("\n"),
    "",
    `Resize to ${MIN_INTERACTIVE_PANEL_COLUMNS}×${MIN_INTERACTIVE_PANEL_ROWS} for the control center.`,
    "/intentum status · /intentum workers · /intentum decisions",
    "Esc  back to chat",
  ];
  return lines.map((line) => fitLine(line, width));
}

function workerEvidenceIdentity(worker: WorkerRecord | undefined): string | undefined {
  if (!worker) return undefined;
  if (worker.attemptId) return `attempt:${worker.attemptId}:${worker.status}:${worker.resultCommit ?? ""}`;
  return `legacy:${worker.status}:${worker.resultCommit ?? ""}:${worker.updatedAt}`;
}

function isCloseInput(data: string): boolean {
  return data === "\u001b" || data === "\u0003" || data === "q";
}

/**
 * Execute one panel action with the same confirmations as the slash commands.
 * Decisions are never resolved from the panel: they are drafted into the
 * editor so the user still sends them to the Designer in their own words.
 */
export async function performPanelAction(host: PanelActionHost, action: PanelAction): Promise<PanelActionOutcome> {
  const { runtime, ctx } = host;
  const withPanelHidden = host.withPanelHidden ?? (async <T>(operation: () => Promise<T>) => operation());
  switch (action.type) {
    case "close":
      host.close();
      return { status: "closed" };
    case "inspect-worker":
      await runtime.workers.inspect(action.workerId);
      return { status: "success", message: `${action.workerId} evidence loaded.` };
    case "pause-project":
      await runtime.pauseProject();
      ctx.ui.notify("Project paused. Active Workers stop at their next safe point; worktrees are kept.", "warning");
      return { status: "success", message: "Project paused; active Workers are stopping safely." };
    case "resume-project": {
      const state = await runtime.resumeProject();
      ctx.ui.notify(`Project resumed in ${state.phase} phase.`, "info");
      return { status: "success", message: `Project resumed in ${state.phase}.` };
    }
    case "show-status": {
      const summary = renderStatusBrief((await runtime.status()).state);
      host.close();
      ctx.ui.notify(summary, "info");
      return { status: "closed" };
    }
    case "steer": {
      const message = await withPanelHidden(() => ctx.ui.input(`Steer ${action.workerId}`, "Instruction for the Worker"));
      if (!message?.trim()) return { status: "cancelled" };
      await runtime.workers.steer(action.workerId, message.trim());
      ctx.ui.notify(`Instruction sent or queued for ${action.workerId}.`, "info");
      return { status: "success", message: `Instruction sent or queued for ${action.workerId}.` };
    }
    case "pause-worker":
      await runtime.workers.requestPause(action.workerId);
      ctx.ui.notify(`Safe pause requested for ${action.workerId}; it stops at the next safe point.`, "info");
      return { status: "success", message: `Safe pause requested for ${action.workerId}.` };
    case "resume-worker": {
      const message = await withPanelHidden(() => (
        ctx.ui.input(`Resume ${action.workerId}`, "Optional message for the Worker (Enter to skip)")
      ));
      if (message === undefined) return { status: "cancelled" };
      runtime.setWorkerSessionDefaults(ctx);
      await runtime.workers.resume(action.workerId, message.trim() || undefined);
      ctx.ui.notify(`Resuming ${action.workerId} in its preserved Pi session and worktree.`, "info");
      return { status: "success", message: `${action.workerId} is resuming.` };
    }
    case "integrate": {
      if (host.state().autonomy === "guided") {
        const confirmed = await withPanelHidden(() => ctx.ui.confirm(
          "Integrate Worker result",
          `Merge ${action.workerId} into its recorded target branch? The result commit and clean worktree will be verified first.`,
        ));
        if (!confirmed) return { status: "cancelled" };
      }
      await runtime.workers.integrateWorker(action.workerId);
      ctx.ui.notify(`${action.workerId} integrated into its recorded target branch.`, "info");
      return { status: "success", message: `${action.workerId} integrated.` };
    }
    case "abort": {
      const request = await withPanelHidden(async () => {
        const reason = await ctx.ui.input(`Abort ${action.workerId}`, "Reason (required)");
        if (!reason?.trim()) return undefined;
        const confirmed = await ctx.ui.confirm(
          "Emergency abort",
          `Abort the current turn for ${action.workerId}? Session, branch, worktree, and files will be preserved.`,
        );
        return confirmed ? reason.trim() : undefined;
      });
      if (!request) return { status: "cancelled" };
      await runtime.workers.abort(action.workerId, request);
      ctx.ui.notify(`${action.workerId} interrupted; preserved artifacts remain available.`, "warning");
      return { status: "success", message: `${action.workerId} interrupted; artifacts preserved.` };
    }
    case "decide": {
      const decision = host.state().pendingDecisions.find((item) => item.id === action.decisionId);
      const option = decision?.options.find((item) => item.id === action.optionId);
      if (!decision || !option) throw new Error(`decision ${singleLine(action.decisionId)} is no longer pending`);
      host.close();
      ctx.ui.setEditorText(
        `Decision ${singleLine(decision.id)} (${singleLine(decision.title)}): I choose ${singleLine(option.label)}.`,
      );
      ctx.ui.notify("Your choice is drafted in the editor. Press Enter to send it to the Designer.", "info");
      return { status: "closed" };
    }
    case "discuss": {
      const decision = host.state().pendingDecisions.find((item) => item.id === action.decisionId);
      if (!decision) throw new Error(`decision ${singleLine(action.decisionId)} is no longer pending`);
      host.close();
      ctx.ui.setEditorText(`About decision ${singleLine(decision.id)} (${singleLine(decision.title)}): `);
      ctx.ui.notify("Continue the sentence in the editor and send it to discuss this decision.", "info");
      return { status: "closed" };
    }
  }
}

function panelActionProgressLabel(action: Exclude<PanelAction, { type: "inspect-worker" }>): string {
  switch (action.type) {
    case "close": return "Closing control center…";
    case "pause-project": return "Pausing project at safe points…";
    case "resume-project": return "Resuming project…";
    case "show-status": return "Preparing plain-text status…";
    case "steer": return `Preparing an instruction for ${action.workerId}…`;
    case "pause-worker": return `Requesting a safe pause for ${action.workerId}…`;
    case "resume-worker": return `Resuming ${action.workerId}…`;
    case "integrate": return `Verifying and integrating ${action.workerId}…`;
    case "abort": return `Preparing emergency stop for ${action.workerId}…`;
    case "decide": return "Drafting your decision in chat…";
    case "discuss": return "Opening this decision in chat…";
  }
}
