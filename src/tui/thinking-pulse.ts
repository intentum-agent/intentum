import { formatCount } from "./tool-frame.js";
import { lerpRgb, rgbForeground, type TranscriptTheme } from "./transcript-style.js";

/**
 * The streaming "thinking" pulse: one fixed-width starburst cycles its facets
 * so the indicator animates in place, beside a speed badge that brightens
 * from dim gray toward the accent as tokens per second climb.
 */

/**
 * Pulse cadence bounds (ms). Each frame's dwell eases between these on a
 * raised-cosine "breath" — quickest at the cycle start, slowest at its
 * midpoint — so the starburst accelerates and slows instead of ticking at
 * one fixed rate. Mean ≈ 150ms.
 */
export const PULSE_FRAME_MS_MIN = 70;
export const PULSE_FRAME_MS_MAX = 230;

/** Rolling window over which streaming-rate observations are averaged. */
const SPEED_WINDOW_MS = 3000;
/** A rate at or above this maps to the full accent color. */
export const SPEED_MAX = 200;
/** Below this the badge reads as noise and is dropped. */
const SPEED_MIN_VISIBLE = 0.05;

export function pulseFrameDelay(frame: number, frameCount: number): number {
  const phase = frameCount > 0 ? (1 - Math.cos((2 * Math.PI * frame) / frameCount)) / 2 : 0;
  return PULSE_FRAME_MS_MIN + (PULSE_FRAME_MS_MAX - PULSE_FRAME_MS_MIN) * phase;
}

/**
 * Windowed-average tokens per second. Only one pulse animates at a time, so
 * one tracker smooths the jumpy per-delta readings; each block resets it on
 * its first live sample so a previous turn's rate never leaks forward.
 */
export class SpeedTracker {
  #observations: Array<{ time: number; rate: number }> = [];

  #prune(now: number): void {
    const threshold = now - SPEED_WINDOW_MS;
    while (this.#observations.length > 0 && this.#observations[0]!.time < threshold) this.#observations.shift();
  }

  /** Record one instantaneous tok/s reading, clamped so a buffered burst cannot poison the average. */
  observe(rate: number, now: number = performance.now()): void {
    if (!Number.isFinite(rate) || rate < 0) return;
    this.#observations.push({ time: now, rate: Math.min(rate, SPEED_MAX) });
    this.#prune(now);
  }

  speed(now: number = performance.now()): number {
    this.#prune(now);
    if (this.#observations.length === 0) return 0;
    let sum = 0;
    for (const observation of this.#observations) sum += observation.rate;
    return sum / this.#observations.length;
  }

  reset(): void {
    this.#observations = [];
  }
}

export interface PulseSnapshot {
  readonly frame: number;
  /** Provider-reported tokens in the live block; 0 hides the count. */
  readonly tokens: number;
  /** Windowed tok/s; shown only while `live`. */
  readonly rate: number;
  /** Whether this block has observed a positive token delta of its own. */
  readonly live: boolean;
}

export interface PulseFrame {
  /** Styled starburst facet for the indicator slot. */
  readonly glyph: string;
  /** `Thinking · 1.2K · 45.3 toks/s`, styled; the count and rate appear only while streaming. */
  readonly message: string;
}

export function formatPulse(snapshot: PulseSnapshot, theme: TranscriptTheme): PulseFrame {
  const { style, symbols } = theme;
  const frames = symbols.pulse;
  const glyph = style.thinking(frames[snapshot.frame % frames.length] ?? ELLIPSIS_GLYPH);
  const label = style.muted("Thinking");
  const rate = Math.min(SPEED_MAX, snapshot.rate);
  if (!snapshot.live || rate < SPEED_MIN_VISIBLE) return { glyph, message: label };
  const total = snapshot.tokens > 0 ? style.dim(`${symbols.dot}${formatCount(snapshot.tokens)}`) : "";
  // Ease (sqrt) so typical mid-stream rates already read as accent-tinted.
  const ratio = Math.sqrt(rate / SPEED_MAX);
  const rateText = `${symbols.dot}${rate.toFixed(1)} toks/s`;
  const dim = style.rgb("dim");
  const accent = style.rgb("accent");
  const rateSpan = dim && accent ? rgbForeground(lerpRgb(dim, accent, ratio), rateText) : style.muted(rateText);
  return { glyph, message: `${label}${total}${rateSpan}` };
}

const ELLIPSIS_GLYPH = "…";

export interface PulseSink {
  /** A new frame to show; called on every cadence tick while active. */
  show(frame: PulseFrame): void;
  /** The pulse ended (text started, a tool call began, or the message sealed). */
  hide(): void;
}

export interface ThinkingPulseOptions {
  /** One static frame, no timer: honors `INTENTUM_REDUCED_MOTION`. */
  readonly reducedMotion?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  readonly schedule?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  readonly cancel?: ((handle: unknown) => void) | undefined;
}

/**
 * Drives the pulse from streaming token counts. `observe` feeds cumulative
 * provider tokens each update; the controller derives the instantaneous rate
 * and self-reschedules frames with the eased dwell.
 */
export class ThinkingPulse {
  readonly #sink: PulseSink;
  readonly #theme: TranscriptTheme;
  readonly #reducedMotion: boolean;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancel: (handle: unknown) => void;
  readonly #speed = new SpeedTracker();
  #timer: unknown;
  #frame = 0;
  #tokens = 0;
  #live = false;
  #lastTokens: number | undefined;
  #lastTime = 0;
  #active = false;

  constructor(sink: PulseSink, theme: TranscriptTheme, options: ThinkingPulseOptions = {}) {
    this.#sink = sink;
    this.#theme = theme;
    this.#reducedMotion = options.reducedMotion ?? false;
    this.#now = options.now ?? (() => performance.now());
    this.#schedule = options.schedule ?? ((callback, delay) => {
      const handle = setTimeout(callback, delay);
      handle.unref?.();
      return handle;
    });
    this.#cancel = options.cancel ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  get active(): boolean {
    return this.#active;
  }

  /** Feed the block's cumulative provider token count; starts the pulse on first call. */
  observe(tokens: number): void {
    const now = this.#now();
    this.#tokens = tokens;
    if (this.#lastTokens !== undefined) {
      const delta = tokens - this.#lastTokens;
      const elapsed = now - this.#lastTime;
      if (delta > 0 && elapsed > 0) {
        if (!this.#live) this.#speed.reset();
        this.#speed.observe((delta / elapsed) * 1000, now);
        this.#live = true;
      }
    }
    this.#lastTokens = tokens;
    this.#lastTime = now;
    if (!this.#active) {
      this.#active = true;
      this.#frame = 0;
      this.#emit();
      if (!this.#reducedMotion) this.#scheduleFrame();
      return;
    }
    if (this.#reducedMotion) this.#emit();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      this.#cancel(this.#timer);
      this.#timer = undefined;
    }
    const wasActive = this.#active;
    this.#active = false;
    this.#frame = 0;
    this.#tokens = 0;
    this.#live = false;
    this.#lastTokens = undefined;
    if (wasActive) this.#sink.hide();
  }

  #emit(): void {
    this.#sink.show(
      formatPulse({ frame: this.#frame, tokens: this.#tokens, rate: this.#speed.speed(this.#now()), live: this.#live }, this.#theme),
    );
  }

  #scheduleFrame(): void {
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      if (!this.#active) return;
      this.#frame = (this.#frame + 1) % this.#theme.symbols.pulse.length;
      this.#emit();
      this.#scheduleFrame();
    }, pulseFrameDelay(this.#frame, this.#theme.symbols.pulse.length));
  }
}
