import type { AgentToolResult, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import {
  capPreviewLines,
  ELLIPSIS,
  formatExpandHint,
  framedComponent,
  headPreviewLines,
  JSON_TREE_MAX_DEPTH_COLLAPSED,
  JSON_TREE_MAX_DEPTH_EXPANDED,
  JSON_TREE_MAX_LINES_COLLAPSED,
  JSON_TREE_MAX_LINES_EXPANDED,
  JSON_TREE_SCALAR_LEN_COLLAPSED,
  JSON_TREE_SCALAR_LEN_EXPANDED,
  liveSpinnerFrame,
  mergedCallComponent,
  type OutputBlockSection,
  renderJsonTreeLines,
  renderOutputBlock,
  renderStatusLine,
  replaceTabs,
  shortenPath,
  textOutput,
  type ToolRenderState,
  type ToolStatus,
  type TranscriptComponent,
} from "../../tui/tool-frame.js";
import { hostTranscriptTheme } from "../../tui/transcript-host.js";
import type { FrameState, TranscriptTheme } from "../../tui/transcript-style.js";

/**
 * Transcript frames for the Designer tools. Each tool draws one merged frame:
 * the call component shows the header plus the argument body while the call
 * streams and runs, then the result component takes over the whole frame and
 * appends an `Output` section.
 */

/**
 * Pi's `ToolRenderContext` is not re-exported; derive it from the definition
 * that receives it. `any` mirrors Pi's own `TArgs = any` default so the typed
 * args below intersect cleanly.
 */
type HostRenderContext = Parameters<NonNullable<ToolDefinition<any, unknown, ToolRenderState>["renderCall"]>>[2];
type RenderContext<TArgs> = Omit<HostRenderContext, "args"> & { readonly args: TArgs };

export interface ToolRenderers<TArgs> {
  renderCall(args: TArgs, theme: Theme, context: RenderContext<TArgs>): TranscriptComponent;
  renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: RenderContext<TArgs>): TranscriptComponent;
}

/** Args arrive field by field while the model streams them, so every field is optional here. */
export interface ProjectArgs {
  action?: string | undefined;
  artifact?: string | undefined;
  content?: string | undefined;
  phase?: string | undefined;
}

export interface CreateWorkArgs {
  featureId?: string | undefined;
  title?: string | undefined;
  objective?: string | undefined;
  inScope?: readonly string[] | undefined;
  outOfScope?: readonly string[] | undefined;
  acceptanceCriteria?: readonly string[] | undefined;
  touchHints?: readonly string[] | undefined;
  risk?: string | undefined;
  preferredWorkerKind?: string | undefined;
  contextFiles?: readonly string[] | undefined;
}

export interface WorkerArgs {
  action?: string | undefined;
  workerId?: string | undefined;
  message?: string | undefined;
}

export interface IntegrateArgs {
  workerId?: string | undefined;
}

const TEXT_OUTPUT_MAX_COLLAPSED = 6;
const PROJECT_OUTPUT_MAX_COLLAPSED = 12;
const STARTED_RESULT = /^(\S+) started in (.+) on (.+)\.$/;

// =============================================================================
// Shared frame plumbing
// =============================================================================

interface Phase {
  icon: ToolStatus;
  state: FrameState;
}

/** Live phase before a result settles, then success or error. */
function framePhase(spinnerFrame: number | undefined, settled: boolean, isError: boolean): Phase {
  if (!settled) return spinnerFrame !== undefined ? { icon: "running", state: "running" } : { icon: "pending", state: "pending" };
  return isError ? { icon: "error", state: "error" } : { icon: "success", state: "success" };
}

interface FrameSpec {
  header: string;
  state: FrameState;
  sections: OutputBlockSection[];
}

/** The per-tool part of a renderer: everything but the Pi plumbing around it. */
interface ToolFrame<TArgs> {
  header(args: TArgs, phase: Phase, spinnerFrame: number | undefined, theme: TranscriptTheme): string;
  body(args: TArgs, expanded: boolean, theme: TranscriptTheme, context: RenderContext<TArgs>): OutputBlockSection[];
  /** Successful output section lines; errors are handled uniformly. */
  output(text: string, expanded: boolean, theme: TranscriptTheme, context: RenderContext<TArgs>): string[];
}

function frameRows(spec: FrameSpec, width: number, theme: TranscriptTheme): string[] {
  return renderOutputBlock({ header: spec.header, state: spec.state, sections: spec.sections, width }, theme);
}

function errorLines(text: string, theme: TranscriptTheme): string[] {
  const body = text.replace(/^Error:\s*/, "").trimEnd() || "error";
  return body.split("\n").map((line) => theme.style.error(replaceTabs(line)));
}

function outputSection(lines: readonly string[], theme: TranscriptTheme): OutputBlockSection {
  return { label: theme.style.title("Output"), lines };
}

function mergedRenderers<TArgs>(frame: ToolFrame<TArgs>): ToolRenderers<TArgs> {
  return {
    renderCall(args, theme, context) {
      const transcript = hostTranscriptTheme(theme);
      const spinnerFrame = liveSpinnerFrame(context, transcript, !context.isPartial);
      const phase = framePhase(spinnerFrame, false, false);
      const header = frame.header(args, phase, spinnerFrame, transcript);
      const sections = frame.body(args, context.expanded, transcript, context);
      return mergedCallComponent(context.state, (width) => frameRows({ header, state: phase.state, sections }, width, transcript));
    },
    renderResult(result, options, theme, context) {
      context.state.hasResult = true;
      const transcript = hostTranscriptTheme(theme);
      const spinnerFrame = liveSpinnerFrame(context, transcript, !options.isPartial);
      const phase = framePhase(spinnerFrame, !options.isPartial, context.isError);
      const header = frame.header(context.args, phase, spinnerFrame, transcript);
      const sections = frame.body(context.args, options.expanded, transcript, context);
      const text = textOutput(result);
      const lines = context.isError ? errorLines(text, transcript) : frame.output(text, options.expanded, transcript, context);
      if (lines.length > 0) sections.push(outputSection(lines, transcript));
      return framedComponent((width) => frameRows({ header, state: phase.state, sections }, width, transcript));
    },
  };
}

// =============================================================================
// Body fragments
// =============================================================================

function outputTextLines(text: string, theme: TranscriptTheme): string[] {
  const trimmed = text.trimEnd();
  return trimmed ? trimmed.split("\n").map((line) => theme.style.output(replaceTabs(line))) : [];
}

function treeLines(items: readonly string[], theme: TranscriptTheme): string[] {
  const { style, symbols } = theme;
  return items.map((item, index) => `${style.dim(index === items.length - 1 ? symbols.tree.last : symbols.tree.branch)} ${replaceTabs(item)}`);
}

/** Bounded JSON tree with the expand hint; non-JSON text falls back to a capped preview. */
function jsonOutputLines(text: string, expanded: boolean, theme: TranscriptTheme): string[] {
  const trimmed = text.trimEnd();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const tree = renderJsonTreeLines(
        JSON.parse(trimmed),
        theme,
        expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED,
        expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED,
        expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED,
      );
      if (tree.lines.length > 0) {
        const lines = tree.lines;
        if (!expanded) lines.push(formatExpandHint(theme, expanded, true));
        else if (tree.truncated) lines.push(theme.style.dim(ELLIPSIS));
        return lines;
      }
    } catch {
      // Bracketed non-JSON output renders as plain text below.
    }
  }
  return headPreviewLines(outputTextLines(trimmed, theme), theme, { max: TEXT_OUTPUT_MAX_COLLAPSED, expanded });
}

// =============================================================================
// intentum_project
// =============================================================================

export const projectRenderers: ToolRenderers<ProjectArgs> = mergedRenderers({
  header(args, phase, spinnerFrame, theme) {
    const description = [args.action, args.artifact, args.phase].filter((part): part is string => !!part).join(theme.symbols.dot);
    return renderStatusLine({ icon: phase.icon, spinnerFrame, title: "intentum project", description: description || undefined }, theme);
  },
  body(args, expanded, theme, context) {
    if (context.state.hasResult || args.action !== "write_artifact" || !args.content) return [];
    return [{ lines: capPreviewLines(outputTextLines(args.content, theme), theme, { expanded }) }];
  },
  output(text, expanded, theme) {
    return headPreviewLines(outputTextLines(text, theme), theme, { max: PROJECT_OUTPUT_MAX_COLLAPSED, expanded });
  },
});

// =============================================================================
// intentum_create_work
// =============================================================================

function scopeLines(args: CreateWorkArgs, theme: TranscriptTheme): string[] {
  const lines: string[] = [];
  if (args.inScope?.length) lines.push(theme.style.muted("in scope"), ...treeLines(args.inScope, theme));
  if (args.outOfScope?.length) lines.push(theme.style.muted("out of scope"), ...treeLines(args.outOfScope, theme));
  return lines;
}

export const createWorkRenderers: ToolRenderers<CreateWorkArgs> = mergedRenderers({
  header(args, phase, spinnerFrame, theme) {
    const description = [args.featureId, args.title].filter((part): part is string => !!part).join(theme.symbols.dot);
    const meta = [args.risk ? `risk ${args.risk}` : "", args.preferredWorkerKind ?? ""];
    return renderStatusLine({ icon: phase.icon, spinnerFrame, title: "Create work", description: description || undefined, meta }, theme);
  },
  body(args, expanded, theme) {
    const { style } = theme;
    const sections: OutputBlockSection[] = [];
    if (args.objective) sections.push({ label: style.title("Objective"), lines: outputTextLines(args.objective, theme) });
    if (args.acceptanceCriteria?.length) sections.push({ label: style.title("Acceptance"), lines: treeLines(args.acceptanceCriteria, theme) });
    if (!expanded) return sections;
    const scope = scopeLines(args, theme);
    if (scope.length > 0) sections.push({ label: style.title("Scope"), lines: scope });
    if (args.touchHints?.length) sections.push({ label: style.title("Touch"), lines: treeLines(args.touchHints, theme) });
    if (args.contextFiles?.length) sections.push({ label: style.title("Context"), lines: treeLines(args.contextFiles, theme) });
    return sections;
  },
  output(text, expanded, theme, context) {
    const match = STARTED_RESULT.exec(text.trim());
    if (!match) return headPreviewLines(outputTextLines(text, theme), theme, { max: TEXT_OUTPUT_MAX_COLLAPSED, expanded });
    const [, id, worktree, branch] = match;
    return [renderStatusLine({ icon: "success", title: `${id} started`, meta: [branch ?? "", shortenPath(worktree ?? "", context.cwd)] }, theme)];
  },
});

// =============================================================================
// intentum_worker / intentum_integrate
// =============================================================================

export const workerRenderers: ToolRenderers<WorkerArgs> = mergedRenderers({
  header(args, phase, spinnerFrame, theme) {
    const description = [args.action, args.workerId].filter((part): part is string => !!part).join(" ");
    return renderStatusLine({ icon: phase.icon, spinnerFrame, title: "Worker", description: description || undefined }, theme);
  },
  body(args, _expanded, theme) {
    return args.message ? [{ lines: args.message.trimEnd().split("\n").map((line) => theme.style.muted(replaceTabs(line))) }] : [];
  },
  output: jsonOutputLines,
});

export const integrateRenderers: ToolRenderers<IntegrateArgs> = mergedRenderers({
  header(args, phase, spinnerFrame, theme) {
    return renderStatusLine({ icon: phase.icon, spinnerFrame, title: "Integrate", description: args.workerId }, theme);
  },
  body: () => [],
  output: jsonOutputLines,
});
