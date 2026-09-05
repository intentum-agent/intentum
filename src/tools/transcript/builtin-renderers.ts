import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  generateDiffString,
  getLanguageFromPath,
  highlightCode,
  renderDiff,
  type Theme,
  type ToolDefinition,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  CachedOutputBlock,
  capPreviewLines,
  ELLIPSIS,
  elapsedLabel,
  formatDuration,
  formatExpandHint,
  formatMoreItems,
  framedComponent,
  headPreviewLines,
  isRecord,
  liveSpinnerFrame,
  mergedCallComponent,
  type OutputBlockSection,
  outputBlockContentWidth,
  pluralize,
  renderStatusLine,
  replaceTabs,
  sanitizeTerminalLines,
  shortenPath,
  textOutput,
  type ToolRenderState,
  type ToolStatus,
  type TranscriptComponent,
  wrapBrackets,
} from "../../tui/tool-frame.js";
import { hostTranscriptTheme } from "../../tui/transcript-host.js";
import type { FrameState, TranscriptTheme } from "../../tui/transcript-style.js";

/**
 * Transcript frames for Pi's built-in tools. Each override keeps the
 * built-in `execute`, schema, and prompt text and replaces only the
 * presentation: one merged, state-colored frame per call whose body comes
 * from the arguments while the call runs and gains an `Output` section
 * once the result lands, so the block never jumps.
 */

// Pi's ToolRenderContext is not re-exported; derive it from the definition that receives it.
type HostRenderContext = Parameters<NonNullable<ToolDefinition<any, unknown, ToolRenderState>["renderCall"]>>[2];
type RenderContext<TArgs> = Omit<HostRenderContext, "args"> & { readonly args: TArgs };
type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown };
type ResultOptions = { expanded: boolean; isPartial: boolean };

interface EditState extends ToolRenderState {
  previewKey?: string | undefined;
  preview?: { diff: string } | { error: string } | undefined;
  previewPending?: boolean | undefined;
}

const READ_PREVIEW_LINES = 12;
const LIST_PREVIEW_LINES = 12;
const DIFF_PREVIEW_LINES = 40;
const OUTPUT_PREVIEW_LINES = 10;

// =============================================================================
// Shared pieces
// =============================================================================

interface Phase {
  readonly icon: ToolStatus;
  readonly state: FrameState;
}

function phaseFor(spinnerFrame: number | undefined, settled: boolean, isError: boolean, warning = false): Phase {
  if (!settled) return spinnerFrame === undefined ? { icon: "pending", state: "pending" } : { icon: "running", state: "running" };
  if (isError) return warning ? { icon: "warning", state: "warning" } : { icon: "error", state: "error" };
  return { icon: "success", state: "success" };
}

function stringArg(args: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(args)) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function numberArg(args: unknown, key: string): number | undefined {
  if (!isRecord(args)) return undefined;
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorLines(text: string, theme: TranscriptTheme): string[] {
  const body = text.replace(/^Error:\s*/, "").trimEnd() || "error";
  return sanitizeTerminalLines(body).map((line) => theme.style.error(replaceTabs(line)));
}

function outputSection(lines: string[], theme: TranscriptTheme): OutputBlockSection {
  return { label: theme.style.title("Output"), lines };
}

/** Highlighted code rows with a dim right-aligned line-number gutter. */
function codeLines(code: string, language: string | undefined, startLine: number, theme: TranscriptTheme): string[] {
  const rows = sanitizeTerminalLines(replaceTabs(code));
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  const highlighted = highlightCode(rows.join("\n"), language);
  const gutterWidth = Math.max(2, String(startLine + highlighted.length - 1).length);
  return highlighted.map((line, index) => `${theme.style.dim(`${String(startLine + index).padStart(gutterWidth, " ")} `)}${line}`);
}

function frame(block: CachedOutputBlock, header: string | undefined, phase: Phase, sections: OutputBlockSection[], theme: TranscriptTheme): TranscriptComponent {
  return framedComponent((width) => block.render({ header, state: phase.state, sections, width }, theme));
}

/** Pi appends `[Showing lines …]`-style notes to text results; split them off for a meta line. */
function splitTrailingNote(text: string): { body: string; note?: string | undefined } {
  const match = /\n\n\[([^\]\n]+)\]\s*$/.exec(text);
  if (!match) return { body: text };
  return { body: text.slice(0, match.index), note: match[1] };
}

// =============================================================================
// read
// =============================================================================

function readTitle(args: unknown, cwd: string): { title: string; description: string } {
  const path = stringArg(args, "path", "file_path") ?? ELLIPSIS;
  const offset = numberArg(args, "offset");
  const limit = numberArg(args, "limit");
  let description = shortenPath(path, cwd);
  if (offset !== undefined || limit !== undefined) {
    const start = offset ?? 1;
    description += `:${start}${limit !== undefined ? `-${start + limit - 1}` : ""}`;
  }
  return { title: "Read", description };
}

function readRenderers(cwd: string) {
  return {
    renderCall(args: unknown, theme: Theme, context: RenderContext<unknown>): TranscriptComponent {
      const transcript = hostTranscriptTheme(theme);
      const spinnerFrame = liveSpinnerFrame(context, transcript, !context.isPartial);
      const phase = phaseFor(spinnerFrame, false, false);
      const header = renderStatusLine({ icon: phase.icon, spinnerFrame, ...readTitle(args, cwd) }, transcript);
      const block = new CachedOutputBlock();
      return mergedCallComponent(context.state, (width) => block.render({ header, state: phase.state, width }, transcript));
    },
    renderResult(result: ToolResult, options: ResultOptions, theme: Theme, context: RenderContext<unknown>): TranscriptComponent {
      context.state.hasResult = true;
      const transcript = hostTranscriptTheme(theme);
      const spinnerFrame = liveSpinnerFrame(context, transcript, !options.isPartial);
      const phase = phaseFor(spinnerFrame, !options.isPartial, context.isError);
      const header = renderStatusLine({ icon: phase.icon, spinnerFrame, ...readTitle(context.args, cwd) }, transcript);
      const block = new CachedOutputBlock();
      const sections: OutputBlockSection[] = [];
      const text = textOutput(result);
      if (context.isError) {
        sections.push({ lines: errorLines(text, transcript) });
      } else if (result.content.some((c) => c.type === "image")) {
        sections.push({ lines: [transcript.style.dim("(image)")] });
      } else {
        const { body, note } = splitTrailingNote(text);
        const path = stringArg(context.args, "path", "file_path") ?? "";
        const lines = body.trim()
          ? headPreviewLines(codeLines(body, getLanguageFromPath(path), numberArg(context.args, "offset") ?? 1, transcript), transcript, {
              max: READ_PREVIEW_LINES,
              expanded: options.expanded,
            })
          : [transcript.style.dim("(empty)")];
        if (note) lines.push(transcript.style.dim(wrapBrackets(note, transcript)));
        sections.push({ lines });
      }
      return frame(block, header, phase, sections, transcript);
    },
  };
}

// =============================================================================
// bash
// =============================================================================

const BASH_STATUS_RE = /\n\n(Command exited with code (\d+)|Command aborted|Command timed out after (\d+) seconds)\s*$/;
const BASH_TRUNCATION_RE = /\n\n\[(Full output: [^\]]+|Truncated: [^\]]+)\]\s*$/;

interface BashOutcome {
  body: string;
  exitCode?: number;
  aborted?: boolean;
  timedOutAfter?: number;
  notes: string[];
}

/** Separate Pi's trailing exit/abort/timeout and truncation notices from the command output. */
function bashOutcome(text: string): BashOutcome {
  const notes: string[] = [];
  let body = text;
  for (;;) {
    const truncation = BASH_TRUNCATION_RE.exec(body);
    if (!truncation) break;
    notes.unshift(truncation[1]!);
    body = body.slice(0, truncation.index);
  }
  const status = BASH_STATUS_RE.exec(body);
  const outcome: BashOutcome = { body, notes };
  if (!status) return outcome;
  outcome.body = body.slice(0, status.index);
  if (status[2] !== undefined) outcome.exitCode = Number.parseInt(status[2], 10);
  else if (status[3] !== undefined) outcome.timedOutAfter = Number.parseInt(status[3], 10);
  else outcome.aborted = true;
  return outcome;
}

function commandLines(args: unknown, theme: TranscriptTheme): string[] {
  const command = replaceTabs(stringArg(args, "command") ?? ELLIPSIS);
  const prefix = theme.style.dim("$ ");
  const highlighted = highlightCode(command, "bash");
  if (highlighted.length === 0) return [prefix.trimEnd()];
  return highlighted.map((line, index) => (index === 0 ? `${prefix}${line}` : line));
}

function bashRenderers() {
  return {
    renderCall(args: unknown, theme: Theme, context: RenderContext<unknown>): TranscriptComponent {
      const transcript = hostTranscriptTheme(theme);
      const spinnerFrame = liveSpinnerFrame(context, transcript, !context.isPartial);
      const phase = phaseFor(spinnerFrame, false, false);
      const command = commandLines(args, transcript);
      const block = new CachedOutputBlock();
      return mergedCallComponent(context.state, (width) =>
        block.render({ state: phase.state, sections: [{ lines: capPreviewLines(command, transcript, { expanded: context.expanded }) }], width }, transcript),
      );
    },
    renderResult(result: ToolResult, options: ResultOptions, theme: Theme, context: RenderContext<unknown>): TranscriptComponent {
      context.state.hasResult = true;
      const transcript = hostTranscriptTheme(theme);
      const { style, symbols } = transcript;
      const spinnerFrame = liveSpinnerFrame(context, transcript, !options.isPartial);
      const outcome = bashOutcome(textOutput(result));
      const phase = phaseFor(spinnerFrame, !options.isPartial, context.isError, outcome.aborted === true || outcome.timedOutAfter !== undefined);
      const command = capPreviewLines(commandLines(context.args, transcript), transcript, { expanded: options.expanded });
      const stats: string[] = [];
      if (outcome.exitCode !== undefined) stats.push(`Exit: ${outcome.exitCode}`);
      if (outcome.aborted) stats.push("Aborted");
      if (outcome.timedOutAfter !== undefined) stats.push(`Timed out: ${outcome.timedOutAfter}s`);
      const timeout = numberArg(context.args, "timeout");
      if (timeout !== undefined) stats.push(`Timeout: ${timeout}s`);
      const elapsed = elapsedLabel(context.state);
      if (elapsed && !options.isPartial) stats.push(`Took: ${elapsed}`);
      const statsLine = stats.length > 0 ? style.dim(wrapBrackets(stats.join(" | "), transcript)) : undefined;
      const notes = outcome.notes.map((note) => style.warning(wrapBrackets(note, transcript)));
      const body = outcome.body.trimEnd();
      const styledOutput = body.trim() ? sanitizeTerminalLines(body).map((line) => style.output(replaceTabs(line))) : [];
      const block = new CachedOutputBlock();
      return framedComponent((width) => {
        const lines: string[] = [];
        if (options.isPartial) {
          const glyph = spinnerFrame === undefined ? symbols.status.pending : (symbols.spinner[spinnerFrame % symbols.spinner.length] ?? symbols.status.running);
          lines.push(style.muted(`${style.accent(glyph)} running${elapsed ? `${symbols.dot}${elapsed}` : ""}`));
        }
        if (styledOutput.length > 0) {
          if (options.expanded) {
            lines.push(...styledOutput);
          } else {
            const tail = truncateToVisualLines(styledOutput.join("\n"), OUTPUT_PREVIEW_LINES, outputBlockContentWidth(width));
            if (tail.skippedCount > 0) {
              lines.push(
                style.dim(
                  `${ELLIPSIS} (${tail.skippedCount} earlier ${pluralize("line", tail.skippedCount)}, showing ${tail.visualLines.length} of ${tail.skippedCount + tail.visualLines.length}) ${formatExpandHint(transcript, false, true)}`,
                ),
              );
            }
            lines.push(...tail.visualLines);
          }
        } else if (!options.isPartial) {
          lines.push(style.dim("(no output)"));
        }
        if (statsLine) lines.push(statsLine);
        lines.push(...notes);
        return block.render({ state: phase.state, sections: [{ lines: command }, outputSection(lines, transcript)], width }, transcript);
      });
    },
  };
}

// =============================================================================
// edit
// =============================================================================

interface EditPreviewInput {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

function editPreviewInput(args: unknown): EditPreviewInput | undefined {
  const path = stringArg(args, "path", "file_path");
  if (!path || !isRecord(args)) return undefined;
  const edits = args.edits;
  if (Array.isArray(edits) && edits.length > 0 && edits.every((edit) => isRecord(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string")) {
    return { path, edits: edits as EditPreviewInput["edits"] };
  }
  return undefined;
}

/** Diff the requested edits against the file on disk without applying them; mirrors Pi's own preview. */
async function previewEditDiff(input: EditPreviewInput, cwd: string): Promise<{ diff: string } | { error: string }> {
  try {
    const absolute = isAbsolute(input.path) ? input.path : resolve(cwd, input.path);
    const original = (await readFile(absolute, "utf-8")).replace(/\r\n/g, "\n");
    let updated = original;
    for (const edit of input.edits) {
      const oldText = edit.oldText.replace(/\r\n/g, "\n");
      const index = updated.indexOf(oldText);
      if (index < 0) return { error: `Could not find the text to replace in ${input.path}` };
      updated = `${updated.slice(0, index)}${edit.newText.replace(/\r\n/g, "\n")}${updated.slice(index + oldText.length)}`;
    }
    return { diff: generateDiffString(original, updated).diff };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function diffLines(diff: string, expanded: boolean, theme: TranscriptTheme): string[] {
  return headPreviewLines(renderDiff(diff).split("\n"), theme, { max: DIFF_PREVIEW_LINES, expanded });
}

function editRenderers(cwd: string) {
  const header = (args: unknown, phase: Phase, spinnerFrame: number | undefined, theme: TranscriptTheme) =>
    renderStatusLine(
      { icon: phase.icon, spinnerFrame, title: "Edit", description: shortenPath(stringArg(args, "path", "file_path") ?? ELLIPSIS, cwd) },
      theme,
    );
  return {
    renderCall(args: unknown, theme: Theme, context: RenderContext<unknown>): TranscriptComponent {
      const transcript = hostTranscriptTheme(theme);
      const state = context.state as EditState;
      const spinnerFrame = liveSpinnerFrame(context, transcript, !context.isPartial);
      const input = editPreviewInput(args);
      const key = input ? JSON.stringify(input) : undefined;
      if (state.previewKey !== key) {
        state.previewKey = key;
        state.preview = undefined;
        state.previewPending = false;
      }
      if (context.argsComplete && input && !state.preview && !state.previewPending) {
        state.previewPending = true;
        void previewEditDiff(input, cwd).then((preview) => {
          if (state.previewKey !== key) return;
          state.preview = preview;
          state.previewPending = false;
          context.invalidate();
        });
      }
      const preview = state.preview;
      const phase = phaseFor(spinnerFrame, false, false);
      const lines = preview
        ? "error" in preview
          ? [transcript.style.error(preview.error)]
          : diffLines(preview.diff, context.expanded, transcript)
        : [transcript.style.dim(ELLIPSIS)];
      const block = new CachedOutputBlock();
      const title = header(args, phase, spinnerFrame, transcript);
      return mergedCallComponent(context.state, (width) => block.render({ header: title, state: phase.state, sections: [{ lines }], width }, transcript));
    },
    renderResult(result: ToolResult, options: ResultOptions, theme: Theme, context: RenderContext<unknown>): TranscriptComponent {
      context.state.hasResult = true;
      const transcript = hostTranscriptTheme(theme);
      const spinnerFrame = liveSpinnerFrame(context, transcript, !options.isPartial);
      const phase = phaseFor(spinnerFrame, !options.isPartial, context.isError);
      const details = isRecord(result.details) ? result.details : undefined;
      const diff = typeof details?.diff === "string" ? details.diff : undefined;
      const lines = context.isError
        ? errorLines(textOutput(result), transcript)
        : diff
          ? diffLines(diff, options.expanded, transcript)
          : [transcript.style.dim("(no changes)")];
      return frame(new CachedOutputBlock(), header(context.args, phase, spinnerFrame, transcript), phase, [{ lines }], transcript);
    },
  };
}

// =============================================================================
// write
// =============================================================================

function writeRenderers(cwd: string) {
  const build = (args: unknown, phase: Phase, spinnerFrame: number | undefined, expanded: boolean, theme: TranscriptTheme) => {
    const path = stringArg(args, "path", "file_path") ?? ELLIPSIS;
    const content = stringArg(args, "content") ?? "";
    const rows = content ? codeLines(content, getLanguageFromPath(path), 1, theme) : [];
    const header = renderStatusLine(
      { icon: phase.icon, spinnerFrame, title: "Write", description: shortenPath(path, cwd), meta: rows.length > 0 ? [`${rows.length} ${pluralize("line", rows.length)}`] : [] },
      theme,
    );
    return { header, lines: rows.length > 0 ? capPreviewLines(rows, theme, { expanded }) : [theme.style.dim("(empty file)")] };
  };
  return {
    renderCall(args: unknown, theme: Theme, context: RenderContext<unknown>): TranscriptComponent {
      const transcript = hostTranscriptTheme(theme);
      const spinnerFrame = liveSpinnerFrame(context, transcript, !context.isPartial);
      const phase = phaseFor(spinnerFrame, false, false);
      const { header, lines } = build(args, phase, spinnerFrame, context.expanded, transcript);
      const block = new CachedOutputBlock();
      return mergedCallComponent(context.state, (width) => block.render({ header, state: phase.state, sections: [{ lines }], width }, transcript));
    },
    renderResult(result: ToolResult, options: ResultOptions, theme: Theme, context: RenderContext<unknown>): TranscriptComponent {
      context.state.hasResult = true;
      const transcript = hostTranscriptTheme(theme);
      const spinnerFrame = liveSpinnerFrame(context, transcript, !options.isPartial);
      const phase = phaseFor(spinnerFrame, !options.isPartial, context.isError);
      const { header, lines } = build(context.args, phase, spinnerFrame, options.expanded, transcript);
      const sections: OutputBlockSection[] = [{ lines }];
      if (context.isError) sections.push(outputSection(errorLines(textOutput(result), transcript), transcript));
      return frame(new CachedOutputBlock(), header, phase, sections, transcript);
    },
  };
}

// =============================================================================
// grep / find / ls
// =============================================================================

interface ListingSpec {
  title: string;
  noun: string;
  empty: string;
  describe(args: unknown, cwd: string): string;
  limitKey: string;
}

const LISTINGS: Record<"grep" | "find" | "ls", ListingSpec> = {
  grep: {
    title: "Grep",
    noun: "match",
    empty: "(no matches)",
    limitKey: "matchLimitReached",
    describe(args, cwd) {
      const pattern = stringArg(args, "pattern") ?? ELLIPSIS;
      const glob = stringArg(args, "glob");
      return `/${pattern}/ in ${shortenPath(stringArg(args, "path") || ".", cwd)}${glob ? ` (${glob})` : ""}`;
    },
  },
  find: {
    title: "Find",
    noun: "file",
    empty: "(no files)",
    limitKey: "resultLimitReached",
    describe(args, cwd) {
      return `${stringArg(args, "pattern") ?? ELLIPSIS} in ${shortenPath(stringArg(args, "path") || ".", cwd)}`;
    },
  },
  ls: {
    title: "List",
    noun: "entry",
    empty: "(empty)",
    limitKey: "entryLimitReached",
    describe(args, cwd) {
      return shortenPath(stringArg(args, "path") || ".", cwd);
    },
  },
};

function listingRenderers(spec: ListingSpec, cwd: string) {
  return {
    renderCall(args: unknown, theme: Theme, context: RenderContext<unknown>): TranscriptComponent {
      const transcript = hostTranscriptTheme(theme);
      const spinnerFrame = liveSpinnerFrame(context, transcript, !context.isPartial);
      const phase = phaseFor(spinnerFrame, false, false);
      const header = renderStatusLine({ icon: phase.icon, spinnerFrame, title: spec.title, description: spec.describe(args, cwd) }, transcript);
      const block = new CachedOutputBlock();
      return mergedCallComponent(context.state, (width) => block.render({ header, state: phase.state, width }, transcript));
    },
    renderResult(result: ToolResult, options: ResultOptions, theme: Theme, context: RenderContext<unknown>): TranscriptComponent {
      context.state.hasResult = true;
      const transcript = hostTranscriptTheme(theme);
      const { style } = transcript;
      const spinnerFrame = liveSpinnerFrame(context, transcript, !options.isPartial);
      const phase = phaseFor(spinnerFrame, !options.isPartial, context.isError);
      const text = textOutput(result).trim();
      const details = isRecord(result.details) ? result.details : undefined;
      const meta: string[] = [];
      let lines: string[];
      if (context.isError) {
        lines = errorLines(text, transcript);
      } else {
        const rows = text ? text.split("\n") : [];
        if (rows.length > 0) meta.push(`${rows.length} ${pluralize(spec.noun, rows.length)}`);
        const limit = details?.[spec.limitKey];
        if (typeof limit === "number") meta.push(`limit ${limit} reached`);
        const truncation = details?.truncation;
        if (isRecord(truncation) && truncation.truncated === true) meta.push("truncated");
        lines = rows.length > 0
          ? headPreviewLines(rows.map((row) => style.output(replaceTabs(row))), transcript, { max: LIST_PREVIEW_LINES, expanded: options.expanded, noun: spec.noun })
          : [style.dim(spec.empty)];
      }
      const header = renderStatusLine({ icon: phase.icon, spinnerFrame, title: spec.title, description: spec.describe(context.args, cwd), meta }, transcript);
      return frame(new CachedOutputBlock(), header, phase, [{ lines }], transcript);
    },
  };
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Re-register Pi's built-in tools with transcript frames. Extension tools win
 * by name, so each override replaces only how the tool is drawn.
 */
export function registerBuiltinToolRenderers(pi: ExtensionAPI, cwd: string): void {
  const overrides = [
    [createReadToolDefinition(cwd), readRenderers(cwd)],
    [createBashToolDefinition(cwd), bashRenderers()],
    [createEditToolDefinition(cwd), editRenderers(cwd)],
    [createWriteToolDefinition(cwd), writeRenderers(cwd)],
    [createGrepToolDefinition(cwd), listingRenderers(LISTINGS.grep, cwd)],
    [createFindToolDefinition(cwd), listingRenderers(LISTINGS.find, cwd)],
    [createLsToolDefinition(cwd), listingRenderers(LISTINGS.ls, cwd)],
  ] as const;
  for (const [base, renderers] of overrides) {
    const definition: ToolDefinition<typeof base.parameters, unknown, ToolRenderState> = {
      ...(base as unknown as ToolDefinition<typeof base.parameters, unknown, ToolRenderState>),
      renderShell: "self",
      renderCall: renderers.renderCall,
      renderResult: (result, options, theme, context) => renderers.renderResult(result, options, theme, context),
    };
    pi.registerTool(definition);
  }
}
