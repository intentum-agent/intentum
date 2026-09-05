import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatThinkingForDisplay } from "../src/tui/thinking-display.js";
import { installThinkingPresentation } from "../src/tui/thinking-presentation.js";
import {
  formatPulse,
  PULSE_FRAME_MS_MAX,
  PULSE_FRAME_MS_MIN,
  pulseFrameDelay,
  SpeedTracker,
  ThinkingPulse,
} from "../src/tui/thinking-pulse.js";
import { PLAIN_TRANSCRIPT_STYLE, PLAIN_TRANSCRIPT_THEME, type TranscriptTheme } from "../src/tui/transcript-style.js";

const MARKED: TranscriptTheme = {
  ...PLAIN_TRANSCRIPT_THEME,
  style: {
    ...PLAIN_TRANSCRIPT_STYLE,
    thinking: (text) => `<t>${text}</t>`,
    muted: (text) => `<m>${text}</m>`,
    dim: (text) => `<d>${text}</d>`,
    rgb: (tone) => (tone === "dim" ? [100, 100, 100] : [255, 200, 0]),
  },
};

describe("thinking pulse", () => {
  it("breathes: the dwell eases from the minimum at the cycle start to the maximum at its midpoint", () => {
    expect(pulseFrameDelay(0, 8)).toBe(PULSE_FRAME_MS_MIN);
    expect(pulseFrameDelay(4, 8)).toBe(PULSE_FRAME_MS_MAX);
    expect(pulseFrameDelay(2, 8)).toBeCloseTo((PULSE_FRAME_MS_MIN + PULSE_FRAME_MS_MAX) / 2, 5);
  });

  it("averages rates over a window and clamps a buffered burst", () => {
    const tracker = new SpeedTracker();
    tracker.observe(40, 0);
    tracker.observe(80, 1000);
    expect(tracker.speed(1000)).toBe(60);
    tracker.observe(10_000, 1500);
    expect(tracker.speed(1500)).toBeCloseTo((40 + 80 + 200) / 3, 5);
    expect(tracker.speed(5000)).toBe(0);
  });

  it("shows only the label until the block streams tokens of its own", () => {
    expect(formatPulse({ frame: 0, tokens: 0, rate: 90, live: false }, MARKED)).toEqual({ glyph: "<t>✻</t>", message: "<m>Thinking</m>" });
    const live = formatPulse({ frame: 9, tokens: 1234, rate: 50, live: true }, MARKED);
    expect(live.glyph).toBe("<t>✼</t>");
    expect(live.message).toBe("<m>Thinking</m><d> · 1.2K</d>\u001b[38;2;178;150;50m · 50.0 toks/s\u001b[39m");
    expect(formatPulse({ frame: 0, tokens: 12, rate: 50, live: true }, PLAIN_TRANSCRIPT_THEME).message).toBe("Thinking · 12 · 50.0 toks/s");
  });

  it("advances frames on the eased schedule and hides once stopped", () => {
    const shown: string[] = [];
    let hidden = 0;
    let now = 0;
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const pulse = new ThinkingPulse(
      { show: (frame) => shown.push(frame.glyph), hide: () => hidden++ },
      PLAIN_TRANSCRIPT_THEME,
      { now: () => now, schedule: (callback, delay) => timers.push({ callback, delay }), cancel: () => timers.length = 0 },
    );
    pulse.observe(0);
    expect(shown).toEqual(["✻"]);
    expect(timers.map((t) => t.delay)).toEqual([PULSE_FRAME_MS_MIN]);
    now = 100;
    timers.shift()?.callback();
    expect(shown).toEqual(["✻", "✼"]);
    expect(pulse.active).toBe(true);
    pulse.stop();
    expect(hidden).toBe(1);
    expect(timers).toHaveLength(0);
    pulse.stop();
    expect(hidden).toBe(1);
  });

  it("stays on one static frame under reduced motion", () => {
    const shown: string[] = [];
    const timers: unknown[] = [];
    const pulse = new ThinkingPulse(
      { show: (frame) => shown.push(frame.glyph), hide: () => {} },
      PLAIN_TRANSCRIPT_THEME,
      { reducedMotion: true, now: () => 0, schedule: (callback) => timers.push(callback), cancel: () => {} },
    );
    pulse.observe(10);
    pulse.observe(20);
    expect(shown).toEqual(["✻", "✻"]);
    expect(timers).toHaveLength(0);
  });
});

describe("thinking display fold", () => {
  it("drops reasoning-summary comment noise and folds fenced code to an ellipsis", () => {
    const text = "**Plan**\n\n<!-- -->\nCheck the parser.\n```ts\nconst x = 1;\n```\nThen verify.";
    expect(formatThinkingForDisplay(text, true)).toBe("**Plan**\n\nCheck the parser...\nThen verify.");
    expect(formatThinkingForDisplay(text, false)).toBe("**Plan**\n\nCheck the parser.\n```ts\nconst x = 1;\n```\nThen verify.");
    expect(formatThinkingForDisplay("Working<!--", true)).toBe("Working<!--");
    expect(formatThinkingForDisplay("Working\n<!--", true)).toBe("Working");
  });
});

describe("thinking presentation", () => {
  it("drives the working row from streaming events and restores the idle indicator", () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
    let transformer: ((markdown: string, context: { messageType: string }) => string) | undefined;
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
      registerMarkdownTransformer: (fn: typeof transformer) => (transformer = fn),
    } as unknown as ExtensionAPI;
    installThinkingPresentation(pi, {
      idleIndicator: () => ({ message: "Designer working", frames: ["●"], intervalMs: 160 }),
      reducedMotion: true,
    });
    expect([...handlers.keys()]).toEqual(["message_update", "message_end", "turn_end", "agent_end"]);
    expect(transformer?.("a\n<!-- -->\nb", { messageType: "assistant-thinking" })).toBe("a\nb");
    expect(transformer?.("a\n<!-- -->\nb", { messageType: "assistant" })).toBe("a\n<!-- -->\nb");

    const indicators: Array<{ frames: string[]; intervalMs?: number }> = [];
    const messages: string[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        setWorkingIndicator: (indicator: { frames: string[]; intervalMs?: number }) => indicators.push(indicator),
        setWorkingMessage: (message: string) => messages.push(message),
      },
    } as unknown as ExtensionContext;
    const update = (type: string, reasoning: number) =>
      handlers.get("message_update")?.(
        { message: { role: "assistant", usage: { reasoning, output: reasoning } }, assistantMessageEvent: { type } },
        ctx,
      );
    update("thinking_start", 0);
    update("thinking_delta", 40);
    expect(indicators.map((i) => i.frames)).toEqual([["✻"], ["✻"]]);
    expect(messages.at(-1)).toMatch(/^Thinking · 40 · \d+\.\d toks\/s$/);
    update("text_start", 40);
    expect(indicators.at(-1)).toEqual({ frames: ["●"], intervalMs: 160 });
    expect(messages.at(-1)).toBe("Designer working");
    handlers.get("turn_end")?.({}, ctx);
    expect(indicators).toHaveLength(3);
  });
});
