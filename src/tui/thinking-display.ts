/**
 * Thinking text prepared for display. Both modes drop the empty `<!-- -->`
 * sentinel lines some reasoning summaries pad every part with; prose-only
 * mode additionally elides fenced code down to a trailing ellipsis, so a
 * reasoning trace reads as prose instead of a scrolling code dump.
 */

// gpt-5.x reasoning summaries pad every summary part with an empty HTML
// comment (`**Headline**\n\n<!-- -->`), streamed as `<!--` then ` -->`.
const EMPTY_COMMENT_RE = /^<!--\s*-->$/;
const OPEN_COMMENT_RE = /^<!--\s*$/;
const FENCE = /^( {0,3})([`~]{3,})/;

interface DisplayCache {
  text: string;
  value: string;
}

// Streaming renders the same growing text several times per tick; one slot
// per mode collapses those to a single fold.
const proseCache: DisplayCache = { text: "", value: "" };
const rawCache: DisplayCache = { text: "", value: "" };

/** Whether `line` is reasoning-summary comment noise, including its unterminated prefix while streaming. */
function isCommentNoise(line: string, isLastLine: boolean): boolean {
  const trimmed = line.trim();
  return EMPTY_COMMENT_RE.test(trimmed) || (isLastLine && OPEN_COMMENT_RE.test(trimmed));
}

class Fold {
  #lines: string[] = [];
  /** Index of the last non-blank output line, the prose ellipsis target. */
  #tail = -1;

  push(line: string): void {
    if (line.trim() !== "") this.#tail = this.#lines.length;
    this.#lines.push(line);
  }

  /** Prose-mode ellipsis: rewrite the last non-blank line in place. */
  ellipsis(): void {
    if (this.#tail < 0) {
      this.push("...");
      return;
    }
    const trimmed = this.#lines[this.#tail]!.trimEnd();
    this.#lines[this.#tail] = trimmed.endsWith("...") ? trimmed : trimmed.endsWith(".") ? `${trimmed.slice(0, -1)}...` : `${trimmed}...`;
  }

  render(): string {
    return this.#lines.join("\n");
  }
}

export function formatThinkingForDisplay(text: string, proseOnly = true): string {
  if (!text) return text;
  const cache = proseOnly ? proseCache : rawCache;
  if (text === cache.text) return cache.value;
  const hasComment = text.includes("<!--");
  // Raw mode without comments is the identity: fences pass through verbatim.
  if (!proseOnly && !hasComment) {
    cache.text = text;
    cache.value = text;
    return text;
  }

  const fold = new Fold();
  const lines = text.split("\n");
  const last = lines.length - 1;
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inFence) {
      const close = FENCE.exec(line);
      // A closing fence is the same char, at least as long, with nothing else on the line.
      if (close && close[2]![0] === fenceChar && close[2]!.length >= fenceLen && line.slice(close[1]!.length + close[2]!.length).trim() === "") {
        inFence = false;
      }
      // Comment markers inside fences are code, not noise; raw mode keeps them.
      if (!proseOnly) fold.push(line);
      continue;
    }
    // Drop the whole line so `**Headline**\n\n<!-- -->` leaves no blank tail.
    if (hasComment && isCommentNoise(line, i === last)) continue;
    const open = FENCE.exec(line);
    // A backtick fence's info string may not contain a backtick.
    if (open && !(open[2]![0] === "`" && line.slice(open[1]!.length + open[2]!.length).includes("`"))) {
      inFence = true;
      fenceChar = open[2]![0]!;
      fenceLen = open[2]!.length;
      if (proseOnly) fold.ellipsis();
      else fold.push(line);
      continue;
    }
    fold.push(line);
  }
  const formatted = fold.render();
  cache.text = text;
  cache.value = formatted;
  return formatted;
}
