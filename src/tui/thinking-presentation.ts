import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { settleLiveTools } from "./live-ticker.js";
import { type DesignerWorkingIndicator } from "./session-chrome.js";
import { formatThinkingForDisplay } from "./thinking-display.js";
import { type PulseFrame, ThinkingPulse } from "./thinking-pulse.js";
import { type HostThemeLike, transcriptTheme } from "./transcript-style.js";

/**
 * How reasoning shows up while the Designer streams.
 *
 * Visible thinking keeps Pi's italic prose, folded to prose only (fenced
 * code becomes an ellipsis, reasoning-summary comment noise disappears).
 * Hidden thinking gets one static starburst label in the transcript, and
 * the working row under the transcript becomes the live pulse: the
 * starburst breathes through its facets while tokens stream, beside the
 * count and a tok/s badge that brightens toward the accent with speed.
 * Once text or a tool call starts, the row returns to the Designer indicator.
 */

export interface ThinkingPresentationOptions {
  /** The indicator restored whenever the pulse ends. */
  readonly idleIndicator: (ctx: ExtensionContext) => DesignerWorkingIndicator;
  readonly reducedMotion?: boolean | undefined;
}

type WorkingUi = Partial<Pick<ExtensionContext["ui"], "setWorkingIndicator" | "setWorkingMessage">> & {
  readonly theme?: HostThemeLike;
};

const PULSE_EVENTS: Record<string, true> = { thinking_start: true, thinking_delta: true, thinking_end: true };
const SETTLE_EVENTS: Record<string, true> = {
  text_start: true,
  text_delta: true,
  text_end: true,
  toolcall_start: true,
  toolcall_delta: true,
  toolcall_end: true,
  done: true,
  error: true,
};

const PLAIN_HOST_THEME: HostThemeLike = {
  fg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
};

export function installThinkingPresentation(pi: ExtensionAPI, options: ThinkingPresentationOptions): void {
  pi.registerMarkdownTransformer((markdown, context) =>
    context.messageType === "assistant-thinking" ? formatThinkingForDisplay(markdown, true) : markdown,
  );

  let ctxRef: ExtensionContext | undefined;
  let pulse: ThinkingPulse | undefined;
  let pulseTheme: HostThemeLike | undefined;

  const workingUi = (): WorkingUi | undefined => ctxRef?.ui as WorkingUi | undefined;
  const sink = {
    show(frame: PulseFrame) {
      try {
        workingUi()?.setWorkingIndicator?.({ frames: [frame.glyph] });
        workingUi()?.setWorkingMessage?.(frame.message);
      } catch {
        // The working row is cosmetic; a host without it must not break streaming.
      }
    },
    hide() {
      if (!ctxRef) return;
      const idle = options.idleIndicator(ctxRef);
      try {
        workingUi()?.setWorkingIndicator?.({
          frames: [...idle.frames],
          ...(idle.intervalMs === undefined ? {} : { intervalMs: idle.intervalMs }),
        });
        workingUi()?.setWorkingMessage?.(idle.message);
      } catch {
        // Restoration is best-effort while the TUI is shutting down.
      }
    },
  };
  const stop = (ctx: ExtensionContext) => {
    ctxRef = ctx;
    pulse?.stop();
  };

  pi.on("message_update", (event, ctx) => {
    if (!ctx.hasUI || event.message.role !== "assistant") return;
    ctxRef = ctx;
    const kind = event.assistantMessageEvent.type;
    if (SETTLE_EVENTS[kind]) {
      pulse?.stop();
      return;
    }
    if (!PULSE_EVENTS[kind]) return;
    const hostTheme = workingUi()?.theme;
    if (!pulse || pulseTheme !== hostTheme) {
      pulse?.stop();
      pulseTheme = hostTheme;
      pulse = new ThinkingPulse(sink, transcriptTheme(hostTheme ?? PLAIN_HOST_THEME), { reducedMotion: options.reducedMotion });
    }
    const usage = event.message.usage;
    pulse.observe(usage.reasoning ?? usage.output);
  });
  pi.on("message_end", (_event, ctx) => stop(ctx));
  pi.on("turn_end", (_event, ctx) => {
    stop(ctx);
    settleLiveTools();
  });
  pi.on("agent_end", (_event, ctx) => {
    stop(ctx);
    settleLiveTools();
  });
}
