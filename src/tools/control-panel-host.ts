import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { IntentumRuntime } from "../runtime/intentum-runtime.js";
import type { ProjectState } from "../state/schema.js";
import { renderStatusBrief } from "../tui/status-widget.js";
import {
  centeredOverlayOrigin,
  IntentumControlPanel,
  parseMouseSequences,
  type MouseAvailability,
  type PanelAction,
  type PanelStyle,
  type PanelTab,
  type SgrMouseEvent,
} from "../tui/control-panel.js";

/** Press/release reports with SGR encoding; no motion, so multiplexers stay quiet. */
export const ENABLE_MOUSE_REPORTS = "\u001b[?1000h\u001b[?1006h";
export const DISABLE_MOUSE_REPORTS = "\u001b[?1006l\u001b[?1000l";

const MIN_PANEL_WIDTH = 40;
const MAX_PANEL_WIDTH = 100;
const MAX_BODY_ROWS = 24;
/** Title, tabs, two rules, hint line, bottom border. */
const PANEL_CHROME_ROWS = 6;
const LEFT_BUTTON = 0;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

export interface PanelStyleSource {
  fg(color: "accent" | "dim" | "muted" | "success" | "warning" | "error" | "border", text: string): string;
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
    focus: (text) => theme.bg("selectedBg", theme.bold(text)),
  };
}

export function panelWidthFor(columns: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, columns - 4));
}

export function panelBodyRowsFor(rows: number): number {
  return Math.min(MAX_BODY_ROWS, rows - PANEL_CHROME_ROWS - 2);
}

export function mouseAvailabilityFor(tui: Pick<TUI, "mode">): MouseAvailability {
  // The alternate-screen renderer consumes every SGR mouse report for
  // viewport scrolling and selection before extension listeners see it.
  return tui.mode === "regular" ? "available" : "fullscreen";
}

export interface PanelActionHost {
  runtime: IntentumRuntime;
  ctx: ExtensionCommandContext;
  state: () => ProjectState;
  close: () => void;
}

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

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    overlayOptions = { width: panelWidthFor(tui.terminal.columns), anchor: "center" };
    let current = state;
    let closed = false;
    let busy = false;
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
      bodyHeight: panelBodyRowsFor(tui.terminal.rows),
      onAction: (action) => {
        void runAction(action);
      },
    });

    const host: PanelActionHost = { runtime, ctx, state: () => current, close };
    const runAction = async (action: PanelAction): Promise<void> => {
      if (closed || busy) return;
      busy = true;
      panel.setSuspended(true);
      try {
        await performPanelAction(host, action);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        busy = false;
        panel.setSuspended(false);
        tui.requestRender();
      }
    };

    const unsubscribeState = runtime.onStateChange((next) => {
      current = next;
      panel.setState(next);
      tui.requestRender();
    });

    const handleMouse = (event: SgrMouseEvent): void => {
      if (event.release || busy || closed) return;
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
        const desiredWidth = panelWidthFor(tui.terminal.columns);
        if (overlayOptions.width !== desiredWidth) {
          overlayOptions.width = desiredWidth;
          queueMicrotask(() => tui.requestRender());
        }
        panel.setBodyHeight(panelBodyRowsFor(tui.terminal.rows));
        return panel.render(width);
      },
      handleInput(data: string): void {
        panel.handleInput(data);
        tui.requestRender();
      },
      invalidate(): void {
        panel.invalidate();
      },
      dispose(): void {
        closed = true;
        unsubscribeState();
        stopMouse?.();
      },
    };
  }, { overlay: true, overlayOptions: () => overlayOptions });
}

/**
 * Execute one panel action with the same confirmations as the slash commands.
 * Decisions are never resolved from the panel: they are drafted into the
 * editor so the user still sends them to the Designer in their own words.
 */
export async function performPanelAction(host: PanelActionHost, action: PanelAction): Promise<void> {
  const { runtime, ctx } = host;
  switch (action.type) {
    case "close":
      host.close();
      return;
    case "pause-project":
      await runtime.pauseProject();
      ctx.ui.notify("Project paused. Active Workers stop at their next safe point; worktrees are kept.", "warning");
      return;
    case "resume-project": {
      const state = await runtime.resumeProject();
      ctx.ui.notify(`Project resumed in ${state.phase} phase.`, "info");
      return;
    }
    case "show-status":
      ctx.ui.notify(renderStatusBrief((await runtime.status()).state), "info");
      return;
    case "steer": {
      const message = await ctx.ui.input(`Steer ${action.workerId}`, "Instruction for the Worker");
      if (!message?.trim()) return;
      await runtime.workers.steer(action.workerId, message.trim());
      ctx.ui.notify(`Instruction sent or queued for ${action.workerId}.`, "info");
      return;
    }
    case "pause-worker":
      await runtime.workers.requestPause(action.workerId);
      ctx.ui.notify(`Safe pause requested for ${action.workerId}; it stops at the next safe point.`, "info");
      return;
    case "resume-worker": {
      const message = await ctx.ui.input(`Resume ${action.workerId}`, "Optional message for the Worker (Enter to skip)");
      if (message === undefined) return;
      runtime.setWorkerSessionDefaults(ctx);
      await runtime.workers.resume(action.workerId, message.trim() || undefined);
      ctx.ui.notify(`Resuming ${action.workerId} in its preserved Pi session and worktree.`, "info");
      return;
    }
    case "integrate": {
      if (host.state().autonomy === "guided") {
        const confirmed = await ctx.ui.confirm(
          "Integrate Worker result",
          `Merge ${action.workerId} into its recorded target branch? The result commit and clean worktree will be verified first.`,
        );
        if (!confirmed) return;
      }
      await runtime.workers.integrateWorker(action.workerId);
      ctx.ui.notify(`${action.workerId} integrated into its recorded target branch.`, "info");
      return;
    }
    case "abort": {
      const reason = await ctx.ui.input(`Abort ${action.workerId}`, "Reason (required)");
      if (!reason?.trim()) return;
      const confirmed = await ctx.ui.confirm(
        "Emergency abort",
        `Abort the current turn for ${action.workerId}? Session, branch, worktree, and files will be preserved.`,
      );
      if (!confirmed) return;
      await runtime.workers.abort(action.workerId, reason.trim());
      ctx.ui.notify(`${action.workerId} interrupted; preserved artifacts remain available.`, "warning");
      return;
    }
    case "decide": {
      const decision = host.state().pendingDecisions.find((item) => item.id === action.decisionId);
      const option = decision?.options.find((item) => item.id === action.optionId);
      if (!decision || !option) throw new Error(`decision ${action.decisionId} is no longer pending`);
      host.close();
      ctx.ui.setEditorText(`Decision ${decision.id} (${decision.title}): I choose ${option.label}.`);
      ctx.ui.notify("Your choice is drafted in the editor. Press Enter to send it to the Designer.", "info");
      return;
    }
    case "discuss": {
      const decision = host.state().pendingDecisions.find((item) => item.id === action.decisionId);
      if (!decision) throw new Error(`decision ${action.decisionId} is no longer pending`);
      host.close();
      ctx.ui.setEditorText(`About decision ${decision.id} (${decision.title}): `);
      ctx.ui.notify("Continue the sentence in the editor and send it to discuss this decision.", "info");
      return;
    }
  }
}
