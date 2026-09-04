import { readFile } from "node:fs/promises";
import { SYMBOL_SETS, type SymbolPreset, symbolPreset } from "./symbols.mjs";

export const BRAND_WIDGET_KEY = "intentum-welcome";
export const SIGNAL_RED_LIGHT = "#E8302A";
export const SIGNAL_RED_DARK = "#FF5148";

const DEFAULT_COLUMNS = 80;
const PLAIN_WORDMARK = "intentum";
const COMPACT_GAP = " ";
const BRAND_ASCII_DIRECTORY = new URL("../../brand/ascii/", import.meta.url);

export type BrandLayout = "banner-big" | "banner-small" | "compact" | "logo-small" | "label";

export interface BrandAssets {
  readonly bannerBig: readonly string[];
  readonly bannerSmall: readonly string[];
  readonly logoBig: readonly string[];
  readonly logoSmall: readonly string[];
  readonly textBig: readonly string[];
  readonly textSmall: readonly string[];
}

export interface BrandLayoutWidths {
  readonly bannerBig: number;
  readonly bannerSmall: number;
  readonly compact: number;
  readonly logoSmall: number;
}

export const DEFAULT_BRAND_LAYOUT_WIDTHS: BrandLayoutWidths = Object.freeze({
  bannerBig: 113,
  // The shipped asset is 58 columns wide; never select it for a narrower terminal.
  bannerSmall: 58,
  compact: 21,
  logoSmall: 12,
});

export interface SignalSpan {
  /** Inclusive JavaScript string offset. Brand assets are 7-bit ASCII. */
  readonly start: number;
  /** Exclusive JavaScript string offset. */
  readonly end: number;
}

export interface BrandFrame {
  readonly layout: BrandLayout;
  readonly columns: number;
  readonly width: number;
  /** Unstyled lines, ready to be passed to one Pi TUI Text component per line. */
  readonly lines: readonly string[];
  /** Point-only spans. Applying a colour to these spans cannot colour the wordmark. */
  readonly signalSpans: readonly (readonly SignalSpan[])[];
}

export interface BrandRenderOptions {
  /** Defaults to process.stdout.columns, then 80 when the width is unavailable. */
  readonly columns?: number | null;
  /** Glyph preset for the label layout's mark; defaults to the process preset. */
  readonly symbols?: SymbolPreset | undefined;
  /** Optional point-only styling for renderBrandLines(). */
  readonly colorSignal?: (text: string) => string;
}

/**
 * Resolve an absent or unusable terminal width deterministically.
 */
export function normalizeTerminalColumns(columns: number | null | undefined = process.stdout.columns): number {
  if (typeof columns !== "number" || !Number.isFinite(columns) || columns < 1) return DEFAULT_COLUMNS;
  return Math.max(1, Math.floor(columns));
}

/**
 * Select the largest layout that fits. The extra logo-small state is the safe
 * degradation for 12–20 columns, where `logo-small + intentum` cannot fit.
 */
export function selectBrandLayout(
  columns: number | null | undefined = process.stdout.columns,
  widths: BrandLayoutWidths = DEFAULT_BRAND_LAYOUT_WIDTHS,
): BrandLayout {
  const available = normalizeTerminalColumns(columns);
  if (available >= widths.bannerBig) return "banner-big";
  if (available >= widths.bannerSmall) return "banner-small";
  if (available >= widths.compact) return "compact";
  if (available >= widths.logoSmall) return "logo-small";
  return "label";
}

/**
 * The compact identity used after the one-time banner.
 */
export function intentumLabel(
  projectName?: string,
  options: { readonly symbols?: SymbolPreset | undefined } = {},
): string {
  const base = `${SYMBOL_SETS[options.symbols ?? symbolPreset()].mark} ${PLAIN_WORDMARK}`;
  // A project named after the tool itself would read "intentum · intentum".
  if (!projectName || projectName.trim().toLowerCase() === PLAIN_WORDMARK) return base;
  return `${base} · ${projectName}`;
}

/**
 * Footer identity: the mark beside the project name, or beside the wordmark
 * when the project has no other name.
 */
export function intentumMark(
  projectName?: string,
  options: { readonly symbols?: SymbolPreset | undefined } = {},
): string {
  const name = projectName?.trim();
  return `${SYMBOL_SETS[options.symbols ?? symbolPreset()].mark} ${name && name.toLowerCase() !== PLAIN_WORDMARK ? name : PLAIN_WORDMARK}`;
}

/**
 * Load the canonical ASCII artwork. No logo shape or wordmark is duplicated in
 * source code: every rendered frame is derived from these files.
 */
export async function loadBrandAssets(): Promise<BrandAssets> {
  const [bannerBig, bannerSmall, logoBig, logoSmall, textBig, textSmall] = await Promise.all([
    loadAsciiAsset("banner-big.txt"),
    loadAsciiAsset("banner-small.txt"),
    loadAsciiAsset("logo-big.txt"),
    loadAsciiAsset("logo-small.txt"),
    loadAsciiAsset("text-big.txt"),
    loadAsciiAsset("text-small.txt"),
  ]);
  return { bannerBig, bannerSmall, logoBig, logoSmall, textBig, textSmall };
}

/**
 * Build an unstyled frame and an exact point mask. Consumers that only receive
 * a Pi theme inside a synchronous widget factory can call styleBrandFrame()
 * there without rereading assets.
 */
export async function renderBrandFrame(options: BrandRenderOptions = {}): Promise<BrandFrame> {
  const assets = await loadBrandAssets();
  return renderBrandFrameFromAssets(assets, options);
}

/**
 * Synchronous counterpart for TUI components that preload the canonical files
 * once, then need to reflow on every render after a terminal resize.
 */
export function renderBrandFrameFromAssets(
  assets: BrandAssets,
  options: BrandRenderOptions = {},
): BrandFrame {
  const columns = normalizeTerminalColumns(options.columns);
  const widths = measureLayoutWidths(assets);
  const layout = selectBrandLayout(columns, widths);

  if (layout === "label") {
    const label = intentumLabel(undefined, { symbols: options.symbols });
    const lines = [sliceToColumns(label, columns)];
    return frame(layout, columns, lines, [[]]);
  }

  if (layout === "logo-small") {
    const lines = assets.logoSmall.slice();
    return frame(layout, columns, lines, findPointSpans(lines, "o"));
  }

  if (layout === "compact") {
    const lines = composeCompact(assets.logoSmall);
    return frame(layout, columns, lines, findPointSpans(assets.logoSmall, "o"));
  }

  if (layout === "banner-small") {
    const lines = assets.bannerSmall.slice();
    return frame(layout, columns, lines, findPointSpans(assets.logoSmall, "o"));
  }

  const lines = assets.bannerBig.slice();
  return frame(layout, columns, lines, findPointSpans(assets.logoBig, "@"));
}

/**
 * Apply styling only to the precomputed signal-point spans.
 */
export function styleBrandFrame(frameToStyle: BrandFrame, colorSignal: (text: string) => string): string[] {
  return frameToStyle.lines.map((line, lineIndex) => {
    const spans = frameToStyle.signalSpans[lineIndex] ?? [];
    if (spans.length === 0) return line;

    let cursor = 0;
    let rendered = "";
    for (const span of spans) {
      rendered += line.slice(cursor, span.start);
      rendered += colorSignal(line.slice(span.start, span.end));
      cursor = span.end;
    }
    return rendered + line.slice(cursor);
  });
}

/**
 * Convenience API for CLI and non-factory callers.
 */
export async function renderBrandLines(options: BrandRenderOptions = {}): Promise<string[]> {
  const brandFrame = await renderBrandFrame(options);
  return options.colorSignal ? styleBrandFrame(brandFrame, options.colorSignal) : brandFrame.lines.slice();
}

/** ANSI 31 foreground, reset to the caller's default foreground afterwards. */
export function ansi31(text: string): string {
  return `\u001b[31m${text}\u001b[39m`;
}

function frame(
  layout: BrandLayout,
  columns: number,
  lines: readonly string[],
  signalSpans: readonly (readonly SignalSpan[])[],
): BrandFrame {
  if (lines.some((line) => cellCount(line) > columns)) {
    throw new Error(`Brand layout ${layout} does not fit ${columns} columns`);
  }
  return {
    layout,
    columns,
    width: maxWidth(lines),
    lines,
    signalSpans: lines.map((_, index) => signalSpans[index] ?? []),
  };
}

function measureLayoutWidths(assets: BrandAssets): BrandLayoutWidths {
  const logoSmall = maxWidth(assets.logoSmall);
  return {
    bannerBig: maxWidth(assets.bannerBig),
    bannerSmall: maxWidth(assets.bannerSmall),
    compact: logoSmall + COMPACT_GAP.length + PLAIN_WORDMARK.length,
    logoSmall,
  };
}

function composeCompact(logoLines: readonly string[]): string[] {
  const logoWidth = maxWidth(logoLines);
  const wordmarkLine = Math.floor((logoLines.length - 1) / 2);
  return logoLines.map((line, index) =>
    index === wordmarkLine ? `${line.padEnd(logoWidth)}${COMPACT_GAP}${PLAIN_WORDMARK}` : line,
  );
}

function findPointSpans(lines: readonly string[], pointCharacter: "o" | "@"): SignalSpan[][] {
  return lines.map((line) => {
    const spans: SignalSpan[] = [];
    let start = line.indexOf(pointCharacter);
    while (start !== -1) {
      let end = start + 1;
      while (line[end] === pointCharacter) end += 1;
      spans.push({ start, end });
      start = line.indexOf(pointCharacter, end);
    }
    return spans;
  });
}

function maxWidth(lines: readonly string[]): number {
  return lines.reduce((maximum, line) => Math.max(maximum, cellCount(line)), 0);
}

/**
 * Terminal cells of a brand line. Artwork is 7-bit ASCII and every mark glyph
 * is single-cell, so counting code points is exact; the Nerd Font mark is a
 * surrogate pair, which `String#length` would count twice.
 */
function cellCount(line: string): number {
  let count = 0;
  for (const _ of line) count += 1;
  return count;
}

function sliceToColumns(value: string, columns: number): string {
  return Array.from(value).slice(0, columns).join("");
}

async function loadAsciiAsset(fileName: string): Promise<readonly string[]> {
  // "utf8" rather than "ascii": Node's ascii decoder masks bit 7, which would
  // make the 7-bit check below unreachable.
  const raw = await readFile(new URL(fileName, BRAND_ASCII_DIRECTORY), "utf8");
  if (raw.includes("\r")) throw new Error(`Brand asset ${fileName} must use LF line endings`);
  if (raw.includes("\u001b")) throw new Error(`Brand asset ${fileName} must not contain ANSI escapes`);
  if ([...raw].some((character) => character.charCodeAt(0) > 0x7f)) {
    throw new Error(`Brand asset ${fileName} must contain only 7-bit ASCII`);
  }

  const withoutFinalNewline = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = withoutFinalNewline.split("\n");
  if (lines.length === 0 || lines.every((line) => line.length === 0)) {
    throw new Error(`Brand asset ${fileName} must not be empty`);
  }
  if (lines.some((line) => /[\t ]$/.test(line))) {
    throw new Error(`Brand asset ${fileName} must not contain trailing whitespace`);
  }
  return lines;
}
