import { type SymbolPreset, type SymbolSet, SYMBOL_SETS, symbolPreset } from "./symbols.mjs";

/**
 * Transcript styling: the tones tool frames and the thinking pulse draw with.
 * Host themes map onto it once; renderers never touch Pi's `Theme` directly,
 * so tests can render with the plain style and assert exact text.
 */

export type FrameState = "pending" | "running" | "success" | "error" | "warning";

export type Rgb = readonly [number, number, number];

export interface TranscriptStyle {
  bold(text: string): string;
  italic(text: string): string;
  dim(text: string): string;
  muted(text: string): string;
  accent(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  /** Tool titles in status lines and frame headers. */
  title(text: string): string;
  /** Tool output bodies. */
  output(text: string): string;
  /** Reasoning prose and the thinking pulse glyph. */
  thinking(text: string): string;
  added(text: string): string;
  removed(text: string): string;
  context(text: string): string;
  /** Muted frame border for quiet blocks that must not compete with state-colored ones. */
  borderMuted(text: string): string;
  /** Endpoints for gradient badges; undefined outside truecolor hosts. */
  rgb(tone: "dim" | "accent"): Rgb | undefined;
}

export type TranscriptTone = Exclude<keyof TranscriptStyle, "bold" | "italic" | "rgb">;

const identity = (text: string) => text;

export const PLAIN_TRANSCRIPT_STYLE: TranscriptStyle = {
  bold: identity,
  italic: identity,
  dim: identity,
  muted: identity,
  accent: identity,
  success: identity,
  warning: identity,
  error: identity,
  title: identity,
  output: identity,
  thinking: identity,
  added: identity,
  removed: identity,
  context: identity,
  borderMuted: identity,
  rgb: () => undefined,
};

/** Everything a transcript renderer needs besides its own data. */
export interface TranscriptTheme {
  readonly style: TranscriptStyle;
  readonly symbols: SymbolSet;
  /** Human-readable key that toggles tool-output expansion, e.g. `ctrl+o`. */
  readonly expandKey: string;
}

export const DEFAULT_EXPAND_KEY = "ctrl+o";

export const PLAIN_TRANSCRIPT_THEME: TranscriptTheme = {
  style: PLAIN_TRANSCRIPT_STYLE,
  symbols: SYMBOL_SETS.unicode,
  expandKey: DEFAULT_EXPAND_KEY,
};

/** The subset of Pi's `Theme` the adapter reads; kept structural so tests can pass a fake. */
export interface HostThemeLike {
  fg(color: HostThemeColor, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  getFgAnsi?(color: HostThemeColor): string;
}

export type HostThemeColor =
  | "accent"
  | "dim"
  | "muted"
  | "success"
  | "warning"
  | "error"
  | "toolTitle"
  | "toolOutput"
  | "thinkingText"
  | "toolDiffAdded"
  | "toolDiffRemoved"
  | "toolDiffContext"
  | "borderMuted";

const TRUECOLOR_SGR = /\x1b\[38;2;(\d{1,3});(\d{1,3});(\d{1,3})m/;

/** RGB of a foreground SGR when it is a truecolor sequence; undefined for 256-color or unknown. */
export function rgbFromAnsi(sequence: string | undefined): Rgb | undefined {
  const match = sequence ? TRUECOLOR_SGR.exec(sequence) : null;
  if (!match) return undefined;
  const channel = (value: string) => Math.min(255, Number.parseInt(value, 10));
  return [channel(match[1]!), channel(match[2]!), channel(match[3]!)];
}

export function transcriptStyle(theme: HostThemeLike): TranscriptStyle {
  const fg = (color: HostThemeColor) => (text: string) => theme.fg(color, text);
  return {
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    dim: fg("dim"),
    muted: fg("muted"),
    accent: fg("accent"),
    success: fg("success"),
    warning: fg("warning"),
    error: fg("error"),
    title: fg("toolTitle"),
    output: fg("toolOutput"),
    thinking: fg("thinkingText"),
    added: fg("toolDiffAdded"),
    removed: fg("toolDiffRemoved"),
    context: fg("toolDiffContext"),
    borderMuted: fg("borderMuted"),
    rgb: (tone) => rgbFromAnsi(theme.getFgAnsi?.(tone)),
  };
}

export interface TranscriptThemeOptions {
  readonly symbols?: SymbolPreset;
  readonly expandKey?: string;
}

export function transcriptTheme(theme: HostThemeLike, options: TranscriptThemeOptions = {}): TranscriptTheme {
  return {
    style: transcriptStyle(theme),
    symbols: SYMBOL_SETS[options.symbols ?? symbolPreset()],
    expandKey: options.expandKey ?? DEFAULT_EXPAND_KEY,
  };
}

/** Linear-interpolate two colors in sRGB; `t` clamps to [0, 1]. */
export function lerpRgb(from: Rgb, to: Rgb, t: number): Rgb {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    Math.round(from[0] + (to[0] - from[0]) * k),
    Math.round(from[1] + (to[1] - from[1]) * k),
    Math.round(from[2] + (to[2] - from[2]) * k),
  ];
}

export function rgbForeground(rgb: Rgb, text: string): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
}
