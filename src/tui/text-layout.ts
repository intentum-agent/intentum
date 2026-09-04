import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ELLIPSIS = "…";

/** Collapse untrusted or multi-line copy into one display-safe line. */
export function singleLine(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Clip plain text to terminal cells without splitting CJK or emoji graphemes.
 * Styling should be applied after this helper so escape sequences stay intact.
 */
export function clipToCellWidth(value: string, maximum: number, ellipsis = ELLIPSIS): string {
  const width = Math.max(0, Math.floor(maximum));
  if (width === 0) return "";
  if (visibleWidth(value) <= width) return value;

  const boundedEllipsis = takeGraphemes(ellipsis, width);
  const ellipsisWidth = visibleWidth(boundedEllipsis);
  const contentWidth = Math.max(0, width - ellipsisWidth);
  return `${takeGraphemes(value, contentWidth)}${boundedEllipsis}`;
}

/** Collapse to one line, then clip by terminal cell width. */
export function clipSingleLine(value: string, maximum: number, ellipsis = ELLIPSIS): string {
  return clipToCellWidth(singleLine(value), maximum, ellipsis);
}

/** Pad plain text to an exact terminal-cell width, clipping when necessary. */
export function padToCellWidth(value: string, width: number, ellipsis = ELLIPSIS): string {
  const boundedWidth = Math.max(0, Math.floor(width));
  const clipped = clipToCellWidth(value, boundedWidth, ellipsis);
  return `${clipped}${" ".repeat(Math.max(0, boundedWidth - visibleWidth(clipped)))}`;
}

/**
 * Wrap plain text at terminal-cell boundaries while preserving every grapheme.
 * Explicit line breaks are retained; empty input still occupies one line.
 */
export function wrapToCellWidth(value: string, maximum: number): string[] {
  const width = Math.max(1, Math.floor(maximum));
  const result: string[] = [];

  for (const sourceLine of value.replace(/\t/g, "   ").split(/\r?\n/)) {
    if (!sourceLine.trim()) {
      result.push("");
      continue;
    }

    let line = "";
    let pendingSpace = false;
    const tokens = sourceLine.split(/(\s+)/u).filter(Boolean);
    for (const token of tokens) {
      if (/^\s+$/u.test(token)) {
        pendingSpace = line.length > 0;
        continue;
      }

      const separator = line && pendingSpace ? " " : "";
      if (visibleWidth(line) + visibleWidth(separator) + visibleWidth(token) <= width) {
        line += `${separator}${token}`;
        pendingSpace = false;
        continue;
      }

      if (line) result.push(line);
      line = "";
      pendingSpace = false;
      const chunks = splitGraphemesToWidth(token, width);
      for (const chunk of chunks.slice(0, -1)) result.push(chunk);
      line = chunks.at(-1) ?? "";
    }
    if (line) result.push(line);
  }

  return result.length ? result : [""];
}

function splitGraphemesToWidth(value: string, maximum: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const segmentWidth = visibleWidth(segment);
    if (chunk && width + segmentWidth > maximum) {
      chunks.push(chunk);
      chunk = "";
      width = 0;
    }
    // Keep an over-wide grapheme intact; corrupting a joined emoji is worse
    // than one-cell overflow in an impossibly narrow viewport.
    chunk += segment;
    width += segmentWidth;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function takeGraphemes(value: string, maximum: number): string {
  let result = "";
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const segmentWidth = visibleWidth(segment);
    if (width + segmentWidth > maximum) break;
    result += segment;
    width += segmentWidth;
  }
  return result;
}
