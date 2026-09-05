import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { registerLiveTool, sharedSpinnerFrame, unregisterLiveTool } from "./live-ticker.js";
import { type FrameState, type TranscriptTheme, type TranscriptTone } from "./transcript-style.js";

/**
 * Tool transcript primitives: the status header every tool draws, the rounded
 * frame around its output, and the collapsed-preview conventions they share.
 * Renderers compose these; nothing here knows a specific tool.
 */

export type ToolStatus = "pending" | "running" | "success" | "done" | "error" | "warning" | "info" | "aborted";

export const ELLIPSIS = "…";

// =============================================================================
// Status line
// =============================================================================

const STATUS_TONE: Record<Exclude<ToolStatus, "running">, TranscriptTone> = {
  success: "success",
  done: "success",
  error: "error",
  warning: "warning",
  info: "accent",
  pending: "muted",
  aborted: "error",
};

/** Colored status glyph; a live `running` status draws the shared spinner frame instead. */
export function statusIcon(status: ToolStatus, theme: TranscriptTheme, spinnerFrame?: number): string {
  const { style, symbols } = theme;
  if (status === "running") {
    if (spinnerFrame !== undefined) {
      const frames = symbols.spinner;
      return style.accent(frames[spinnerFrame % frames.length] ?? symbols.status.running);
    }
    return style.accent(symbols.status.running);
  }
  return style[STATUS_TONE[status]](symbols.status[status]);
}

export interface StatusLineOptions {
  icon?: ToolStatus | undefined;
  /** Pre-rendered glyph that replaces the status icon. */
  iconOverride?: string | undefined;
  spinnerFrame?: number | undefined;
  title: string;
  titleTone?: TranscriptTone | undefined;
  description?: string | undefined;
  badge?: { label: string; tone: TranscriptTone } | undefined;
  meta?: string[] | undefined;
}

/** A single newline in a header fragment would break the frame it sits on. */
function flattenForHeader(text: string): string {
  return text.replace(/\r\n?|\n/g, " ");
}

export function renderStatusLine(options: StatusLineOptions, theme: TranscriptTheme): string {
  const { style, symbols } = theme;
  const icon = options.iconOverride ?? (options.icon ? statusIcon(options.icon, theme, options.spinnerFrame) : "");
  const title = style[options.titleTone ?? "accent"](flattenForHeader(options.title));
  let line = icon ? `${icon} ${title}` : title;
  if (options.description) line += `: ${style.muted(flattenForHeader(options.description))}`;
  if (options.badge) {
    line += ` ${style[options.badge.tone](`${symbols.bracketLeft}${flattenForHeader(options.badge.label)}${symbols.bracketRight}`)}`;
  }
  const meta = options.meta?.map(flattenForHeader).filter((value) => value.trim().length > 0) ?? [];
  if (meta.length > 0) line += ` ${style.dim(meta.join(symbols.dot))}`;
  return line;
}

export function wrapBrackets(text: string, theme: TranscriptTheme): string {
  return `${theme.symbols.bracketLeft}${text}${theme.symbols.bracketRight}`;
}

/** Dim `[ctrl+o: Expand]` hint; empty when already expanded or nothing is hidden. */
export function formatExpandHint(theme: TranscriptTheme, expanded?: boolean, hasMore?: boolean): string {
  if (expanded || hasMore === false) return "";
  return theme.style.dim(wrapBrackets(`${theme.expandKey}: Expand`, theme));
}

export function pluralize(noun: string, count: number): string {
  if (count === 1) return noun;
  return /(?:s|x|z|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`;
}

export function formatMoreItems(remaining: number, noun: string): string {
  const safe = Number.isFinite(remaining) ? remaining : 0;
  return `${ELLIPSIS} ${safe} more ${pluralize(noun, safe)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Compact counts: 512, 1.5K, 18K, 1.2M. */
export function formatCount(count: number): string {
  if (count < 1000) return String(Math.max(0, Math.round(count)));
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}K`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Path as the user reads it: relative inside `cwd`, `~` for the home directory. */
export function shortenPath(path: string, cwd: string = process.cwd()): string {
  if (!path) return path;
  if (isAbsolute(path)) {
    const rel = relative(cwd, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    const home = homedir();
    if (home && (path === home || path.startsWith(home + sep))) return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Text blocks of a tool result joined; images contribute nothing. */
export function textOutput(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
  if (!result?.content) return "";
  let text = "";
  for (const block of result.content) {
    if (block.type !== "text" || !block.text) continue;
    text += text ? `\n${block.text}` : block.text;
  }
  return text;
}

// =============================================================================
// Collapsed previews
// =============================================================================

const PREVIEW_WINDOW_RESERVED_ROWS = 20;
const PREVIEW_WINDOW_MIN_LINES = 6;
const PREVIEW_WINDOW_FALLBACK_ROWS = 30;

/** Tail-window height for collapsed previews, sized from the live viewport. */
export function previewWindowRows(rows: number | undefined = process.stdout.rows): number {
  return Math.max(PREVIEW_WINDOW_MIN_LINES, (rows || PREVIEW_WINDOW_FALLBACK_ROWS) - PREVIEW_WINDOW_RESERVED_ROWS);
}

export interface CapPreviewOptions {
  max?: number | undefined;
  expanded?: boolean | undefined;
  /** Raw prefix (e.g. a dim gutter) for the marker row so nested previews stay aligned. */
  prefix?: string | undefined;
  expandHint?: boolean | undefined;
}

/**
 * Keep the tail of a preview visible behind an `… N earlier lines` marker:
 * the end is the live edge while args stream, and the same window applies
 * after completion so the block never jumps. Only `expanded` uncaps it.
 */
export function capPreviewLines(lines: readonly string[], theme: TranscriptTheme, options: CapPreviewOptions = {}): string[] {
  if (options.expanded) return [...lines];
  const max = options.max ?? previewWindowRows();
  if (lines.length <= max) return [...lines];
  const visible = max <= 1 ? [] : lines.slice(lines.length - (max - 1));
  const hidden = lines.length - visible.length;
  const hint = options.expandHint === false ? "" : formatExpandHint(theme, false, true);
  const marker = `${ELLIPSIS} ${hidden} earlier ${pluralize("line", hidden)}${hint ? ` ${hint}` : ""}`;
  return [`${options.prefix ?? ""}${theme.style.dim(marker)}`, ...visible];
}

/** First `maxLines` rows plus an `… N more lines` marker when cut. */
export function headPreviewLines(
  lines: readonly string[],
  theme: TranscriptTheme,
  options: { max: number; expanded?: boolean | undefined; noun?: string | undefined },
): string[] {
  const max = options.expanded ? lines.length : Math.min(lines.length, options.max);
  const shown = lines.slice(0, max);
  const remaining = lines.length - max;
  if (remaining > 0) {
    const hint = formatExpandHint(theme, options.expanded, true);
    shown.push(theme.style.dim(`${formatMoreItems(remaining, options.noun ?? "line")}${hint ? ` ${hint}` : ""}`));
  }
  return shown;
}

/** Collapse `\r\n`, honor in-line carriage returns as overwrites, split rows. */
export function sanitizeTerminalLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => {
    const index = line.lastIndexOf("\r");
    return index < 0 ? line : line.slice(index + 1);
  });
}

export function replaceTabs(text: string): string {
  return text.includes("\t") ? text.replace(/\t/g, "   ") : text;
}

// =============================================================================
// Output block
// =============================================================================

export interface OutputBlockSection {
  label?: string | undefined;
  lines: readonly string[];
  separator?: boolean | undefined;
}

export interface OutputBlockOptions {
  header?: string | undefined;
  headerMeta?: string | undefined;
  state?: FrameState | undefined;
  sections?: OutputBlockSection[] | undefined;
  width: number;
  contentPaddingLeft?: number | undefined;
  contentPaddingRight?: number | undefined;
  /** Quiet border for blocks that must not compete with state-colored frames. */
  borderMuted?: boolean | undefined;
}

type BlockRow =
  | { kind: "bar"; left: string; right: string; label?: string | undefined; meta?: string | undefined }
  | { kind: "bottom" }
  | { kind: "content"; inner: string };

function normalizePadding(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 1 : Math.max(0, Math.floor(value));
}

/** Inner width a block wraps its body to: both borders plus content padding. */
export function outputBlockContentWidth(width: number, paddingLeft?: number, paddingRight?: number): number {
  const left = normalizePadding(paddingLeft);
  const right = normalizePadding(paddingRight ?? left);
  return Math.max(1, width - 2 - left - right);
}

/**
 * Rounded frame with the header in its top bar, labeled section separators,
 * and a border colored by state: running/pending accent, success dim,
 * error/warning in their own colors. The frame is border-only — no full-row
 * background tint — so it reads the same on the terminal's own background in
 * light and dark themes.
 */
export function renderOutputBlock(options: OutputBlockOptions, theme: TranscriptTheme): string[] {
  const { style, symbols } = theme;
  const { header, headerMeta, state, sections = [] } = options;
  const box = symbols.box;
  const width = Math.max(0, options.width);
  const cap = box.horizontal.repeat(3);
  const border = options.borderMuted
    ? style.borderMuted
    : state === "error"
      ? style.error
      : state === "warning"
        ? style.warning
        : state === "running" || state === "pending"
          ? style.accent
          : style.dim;
  const paddingLeft = normalizePadding(options.contentPaddingLeft);
  const paddingRight = normalizePadding(options.contentPaddingRight ?? paddingLeft);
  const verticalWidth = visibleWidth(box.vertical);
  const contentWidth = Math.max(0, width - verticalWidth * 2 - paddingLeft - paddingRight);
  const leftPad = " ".repeat(paddingLeft);
  const rightPad = " ".repeat(paddingRight);

  const rows: BlockRow[] = [{ kind: "bar", left: box.topLeft, right: box.topRight, label: header, meta: headerMeta }];
  const normalized = sections.length > 0 ? sections : [{ lines: [] as string[] }];
  normalized.forEach((section, index) => {
    if (section.label) {
      rows.push({ kind: "bar", left: box.teeRight, right: box.teeLeft, label: section.label });
    } else if (section.separator && index > 0) {
      rows.push({ kind: "bar", left: box.teeRight, right: box.teeLeft });
    }
    for (const raw of section.lines) {
      for (const line of raw.split("\n")) {
        for (const wrapped of wrapTextWithAnsi(line.trimEnd(), contentWidth)) {
          rows.push({ kind: "content", inner: `${wrapped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(wrapped)))}` });
        }
      }
    }
  });
  rows.push({ kind: "bottom" });

  const renderBar = (row: Extract<BlockRow, { kind: "bar" }>): string => {
    const leftGlyphs = `${row.left}${cap}`;
    if (width <= 0) return border(leftGlyphs) + border(row.right);
    const labelText = [row.label, row.meta].filter(Boolean).join(symbols.dot);
    const leftWidth = visibleWidth(leftGlyphs);
    const rightWidth = visibleWidth(row.right);
    if (!labelText) {
      return `${border(leftGlyphs)}${border(box.horizontal.repeat(Math.max(0, width - leftWidth - rightWidth)))}${border(row.right)}`;
    }
    const label = truncateToWidth(` ${labelText} `, Math.max(0, width - leftWidth - rightWidth), ELLIPSIS);
    const fill = box.horizontal.repeat(Math.max(0, width - leftWidth - visibleWidth(label) - rightWidth));
    return `${border(leftGlyphs)}${label}${border(fill)}${border(row.right)}`;
  };
  const bottomLeft = `${box.bottomLeft}${cap}`;
  const bottom = `${border(bottomLeft)}${border(box.horizontal.repeat(Math.max(0, width - visibleWidth(bottomLeft) - visibleWidth(box.bottomRight))))}${border(box.bottomRight)}`;

  return rows.map((row) =>
    row.kind === "bar" ? renderBar(row) : row.kind === "bottom" ? bottom : `${border(box.vertical)}${leftPad}${row.inner}${rightPad}${border(box.vertical)}`,
  );
}

/**
 * Memoized `renderOutputBlock`: blocks re-render on every frame but rarely
 * change, so identical inputs return the same (caller-immutable) rows.
 */
export class CachedOutputBlock {
  #key: string | undefined;
  #lines: string[] | undefined;

  render(options: OutputBlockOptions, theme: TranscriptTheme): string[] {
    const key = JSON.stringify([
      options.width,
      options.header,
      options.headerMeta,
      options.state,
      options.borderMuted ?? false,
      options.contentPaddingLeft,
      options.contentPaddingRight,
      options.sections?.map((section) => [section.label, section.separator ?? false, section.lines]),
    ]);
    if (this.#lines && this.#key === key) return this.#lines;
    this.#lines = renderOutputBlock(options, theme);
    this.#key = key;
    return this.#lines;
  }

  invalidate(): void {
    this.#key = undefined;
    this.#lines = undefined;
  }
}

/** The shape Pi mounts for tool call and result renderers. */
export interface TranscriptComponent {
  /** Pi's `Component` contract; callers never mutate the returned rows. */
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

/** A self-framing component whose rows depend only on width until invalidated. */
export function framedComponent(render: (width: number) => string[]): TranscriptComponent {
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  return {
    render(width) {
      if (cachedLines && cachedWidth === width) return cachedLines;
      cachedLines = render(width);
      cachedWidth = width;
      return cachedLines;
    },
    invalidate() {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };
}

const EMPTY_ROWS: string[] = [];

/**
 * Pi renders a tool's call component above its result component for the
 * life of the block. Tools that fold both into one frame draw everything in
 * the result and let the call vanish once `state.hasResult` flips.
 */
export function mergedCallComponent(state: ToolRenderState, render: (width: number) => string[]): TranscriptComponent {
  const framed = framedComponent(render);
  return {
    render: (width) => (state.hasResult ? EMPTY_ROWS : framed.render(width)),
    invalidate: () => framed.invalidate(),
  };
}

// =============================================================================
// Live tool tracking
// =============================================================================

/** Shared per-call state Pi threads through `context.state`. */
export interface ToolRenderState {
  hasResult?: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface LiveToolContext {
  readonly toolCallId: string;
  readonly executionStarted: boolean;
  readonly state: ToolRenderState;
  invalidate(): void;
}

/**
 * Register a running call with the shared ticker and return its spinner
 * frame; undefined while args still stream (a static pending icon) or once
 * the call settled (unregisters and records the end time).
 */
export function liveSpinnerFrame(
  context: LiveToolContext,
  theme: TranscriptTheme,
  settled: boolean,
  now: number = Date.now(),
): number | undefined {
  const state = context.state;
  if (settled) {
    unregisterLiveTool(context.toolCallId);
    if (state.startedAt !== undefined) state.endedAt ??= now;
    return undefined;
  }
  if (!context.executionStarted) return undefined;
  state.startedAt ??= now;
  registerLiveTool(context.toolCallId, context.invalidate);
  return sharedSpinnerFrame(theme.symbols.spinner.length);
}

/** Elapsed label for a running or finished call; undefined before it started. */
export function elapsedLabel(state: ToolRenderState, now: number = Date.now()): string | undefined {
  if (state.startedAt === undefined) return undefined;
  return formatDuration((state.endedAt ?? now) - state.startedAt);
}

// =============================================================================
// JSON tree and inline args
// =============================================================================

export const JSON_TREE_MAX_DEPTH_COLLAPSED = 2;
export const JSON_TREE_MAX_DEPTH_EXPANDED = 6;
export const JSON_TREE_MAX_LINES_COLLAPSED = 6;
export const JSON_TREE_MAX_LINES_EXPANDED = 200;
export const JSON_TREE_SCALAR_LEN_COLLAPSED = 60;
export const JSON_TREE_SCALAR_LEN_EXPANDED = 2000;

const HIDDEN_ARG_KEYS: Record<string, true> = { __partialJson: true };
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function formatScalar(value: unknown, maxLen: number): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    return `"${truncateToWidth(value.replace(/\n/g, "\\n").replace(/\t/g, "\\t"), maxLen, ELLIPSIS)}"`;
  }
  if (Array.isArray(value)) return `[${value.length} ${pluralize("item", value.length)}]`;
  if (typeof value === "object") return `{${Object.keys(value).length} ${pluralize("key", Object.keys(value).length)}}`;
  return String(value);
}

export function renderJsonTreeLines(
  value: unknown,
  theme: TranscriptTheme,
  maxDepth: number,
  maxLines: number,
  maxScalarLen: number,
): { lines: string[]; truncated: boolean } {
  const { style, symbols } = theme;
  const lines: string[] = [];
  let truncated = false;
  const prefixFor = (ancestors: readonly boolean[]) => ancestors.map((hasNext) => (hasNext ? `${symbols.tree.vertical}  ` : "   ")).join("");
  const push = (line: string): boolean => {
    if (lines.length >= maxLines) {
      truncated = true;
      return false;
    }
    lines.push(line);
    return true;
  };
  const renderNode = (node: unknown, key: string | undefined, ancestors: boolean[], isLast: boolean, depth: number): void => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    const prefix = `${prefixFor(ancestors)}${style.dim(isLast ? symbols.tree.last : symbols.tree.branch)} `;
    ancestors.push(!isLast);
    try {
      if (node === null || node === undefined || typeof node !== "object") {
        const label = style.muted(key ?? "value");
        if (typeof node === "string" && node.includes("\n")) {
          const parts = node.split("\n");
          const shown = Math.min(parts.length, Math.max(1, maxLines - lines.length - 1));
          const continuation = prefixFor(ancestors);
          push(`${prefix}${label}: ${style.dim(`"${truncateToWidth(parts[0]!, maxScalarLen, ELLIPSIS)}`)}`);
          for (let i = 1; i < shown; i++) {
            if (!push(`${continuation}   ${style.dim(` ${truncateToWidth(parts[i]!, maxScalarLen, ELLIPSIS)}`)}`)) break;
          }
          if (parts.length > shown) {
            truncated = true;
            push(`${continuation}   ${style.dim(` ${ELLIPSIS}(${parts.length - shown} more lines)"`)}`);
          } else {
            lines[lines.length - 1] = `${lines[lines.length - 1]}${style.dim('"')}`;
          }
          return;
        }
        push(`${prefix}${label}: ${style.dim(formatScalar(node, maxScalarLen))}`);
        return;
      }
      const children = Array.isArray(node) ? node.map((child, i) => [`[${i}]`, child] as const) : Object.entries(node);
      push(`${prefix}${style.muted(key ?? (Array.isArray(node) ? "array" : "object"))}`);
      const leaf = (text: string) => push(`${prefixFor(ancestors)}${style.dim(symbols.tree.last)} ${style.dim(text)}`);
      if (children.length === 0) {
        leaf(Array.isArray(node) ? "[]" : "{}");
        return;
      }
      if (depth >= maxDepth) {
        leaf(ELLIPSIS);
        return;
      }
      for (let i = 0; i < children.length; i++) {
        renderNode(children[i]![1], children[i]![0], ancestors, i === children.length - 1, depth + 1);
        if (lines.length >= maxLines) {
          truncated = true;
          return;
        }
      }
    } finally {
      ancestors.pop();
    }
  };

  if (isRecord(value)) {
    const keys = Object.keys(value).filter((key) => !HIDDEN_ARG_KEYS[key]);
    for (let i = 0; i < keys.length && lines.length < maxLines; i++) {
      renderNode(value[keys[i]!], keys[i], [], i === keys.length - 1, 1);
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length && lines.length < maxLines; i++) {
      renderNode(value[i], `[${i}]`, [], i === value.length - 1, 1);
    }
  } else {
    renderNode(value, undefined, [], true, 0);
  }
  if (lines.length >= maxLines) truncated = true;
  return { lines, truncated };
}
