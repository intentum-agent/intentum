import type { DecisionRequest, ProjectState, WorkerRecord } from "../state/schema.js";
import {
  ACTIVE_WORKER_STATUSES,
  ATTENTION_WORKER_STATUSES,
  deriveHarnessPresentation,
  phaseLabel,
  sortedWorkers,
  summarizeWorkers,
  workerStatusPresentation,
  type WorkerSummary,
} from "./presentation.js";
import { clipSingleLine, clipToCellWidth, singleLine } from "./text-layout.js";

export {
  ACTIVE_WORKER_STATUSES,
  ATTENTION_WORKER_STATUSES,
  phaseLabel,
  sortedWorkers,
  summarizeWorkers,
  workerStatusPresentation,
  type WorkerSummary,
} from "./presentation.js";

export interface StatusWidgetStyle {
  neutral(text: string): string;
  progress(text: string): string;
  review(text: string): string;
  warning(text: string): string;
  error(text: string): string;
}

export interface StatusWidgetOptions {
  /** Apply host-theme styling after all cell-safe clipping is complete. */
  style?: StatusWidgetStyle;
  /** Optional terminal-cell width for every rendered line. */
  width?: number;
}

const PLAIN_STYLE: StatusWidgetStyle = {
  neutral: (text) => text,
  progress: (text) => text,
  review: (text) => text,
  warning: (text) => text,
  error: (text) => text,
};

const MAX_RESULT_LINES = 2;
const MAX_RISK_LINES = 2;
const DETAIL_WIDTH = 96;

/**
 * Above-editor attention surface. Ordering is intentional: a blocking user
 * decision, then failed/blocked work, then results waiting for review.
 */
export function renderStatusWidget(state: ProjectState, options: StatusWidgetOptions = {}): string[] {
  const style = options.style ?? PLAIN_STYLE;
  const model = deriveHarnessPresentation(state);
  const width = options.width === undefined ? undefined : Math.max(1, Math.floor(options.width));
  const styled = (tone: keyof StatusWidgetStyle, text: string): string => {
    const clipped = width === undefined ? text : clipToCellWidth(text, width);
    return style[tone](clipped);
  };

  const lines: string[] = [];
  if (model.blockingDecision) {
    lines.push(styled("warning", `◆ Decision required · ${clipSingleLine(model.blockingDecision.title, DETAIL_WIDTH)}`));
  }

  const attention = [...model.workers.attention]
    .sort((left, right) => attentionRank(left) - attentionRank(right) || right.updatedAt.localeCompare(left.updatedAt));
  for (const worker of attention.slice(0, MAX_RISK_LINES)) {
    const status = workerStatusPresentation(worker.status);
    lines.push(styled(status.tone === "warning" ? "warning" : "error", `${status.glyph} ${worker.id} ${status.label} · ${riskText(worker)}`));
  }

  for (const worker of model.workers.review.slice(0, MAX_RESULT_LINES)) {
    const status = workerStatusPresentation(worker.status);
    lines.push(styled("review", `${status.glyph} ${worker.id} ${status.label} · ${resultText(worker)}`));
  }
  return lines;
}

/** Compact, plain notification copy. RPC and JSON hosts never receive ANSI. */
export function renderStatusBrief(state: ProjectState): string {
  const model = deriveHarnessPresentation(state);
  const lines = [`${singleLine(state.projectName)} · ${model.phase.label} · ${featureLine(state)}`];
  lines.push(...renderStatusWidget(state).slice(0, 3));
  lines.push(summaryLine(model.workers, state, PLAIN_STYLE));
  return lines.join("\n");
}

/** Complete, plain-text state for commands and non-TUI hosts. */
export function renderStatusText(state: ProjectState): string {
  const workers = sortedWorkers(state);
  const workerLines = workers.length
    ? workers.map((worker) => {
      const status = workerStatusPresentation(worker.status).label;
      return `- ${worker.id} ${status}: ${singleLine(worker.blocker ?? worker.progressSummary ?? worker.objective)}`;
    }).join("\n")
    : "- No Worker has been started.";
  const decisions = state.pendingDecisions.length
    ? state.pendingDecisions.map((decision) => `- ${singleLine(decision.id)} ${decision.blocking ? "Blocking" : "Open"}: ${singleLine(decision.title)}`).join("\n")
    : "- No pending decision.";
  return [
    `Project: ${singleLine(state.projectName)}`,
    `Phase: ${phaseLabel(state)}`,
    `Autonomy: ${state.autonomy}`,
    `Scheduler: ${state.schedulerPaused ? "Paused" : "Running"}`,
    `Active feature: ${state.activeFeatureId ? singleLine(state.activeFeatureId) : "none"}`,
    "Workers:",
    workerLines,
    "Decisions:",
    decisions,
  ].join("\n");
}

export function statusWidgetStyleFromTheme(theme: {
  fg(color: "dim" | "accent" | "success" | "warning" | "error", text: string): string;
}): StatusWidgetStyle {
  return {
    neutral: (text) => theme.fg("dim", text),
    progress: (text) => theme.fg("accent", text),
    review: (text) => theme.fg("success", text),
    warning: (text) => theme.fg("warning", text),
    error: (text) => theme.fg("error", text),
  };
}

function featureLine(state: ProjectState): string {
  const feature = state.activeFeatureId ? `Feature: ${singleLine(state.activeFeatureId)}` : "Feature: none yet";
  return `${feature} · autonomy ${state.autonomy}`;
}

function resultText(worker: WorkerRecord): string {
  return clipSingleLine(worker.progressSummary ?? worker.objective, 72);
}

function riskText(worker: WorkerRecord): string {
  return clipSingleLine(worker.blocker ?? worker.progressSummary ?? worker.objective, DETAIL_WIDTH);
}

function summaryLine(summary: WorkerSummary, state: ProjectState, style: StatusWidgetStyle): string {
  const total = Object.keys(state.workers).length;
  if (total === 0) {
    return style.neutral("No Worker yet · describe the outcome you want in chat and the Designer will plan the work");
  }
  const parts = [
    style.progress(`● ${summary.active.length} in progress`),
    style.review(`✓ ${summary.review.length} ready for review`),
    summary.attention.length
      ? style.error(`⚠ ${summary.attention.length} need${summary.attention.length === 1 ? "s" : ""} attention`)
      : "⚠ 0 need attention",
  ];
  if (summary.paused.length) parts.push(style.neutral(`○ ${summary.paused.length} paused`));
  if (summary.queued.length) parts.push(style.neutral(`◌ ${summary.queued.length} queued`));
  parts.push(decisionText(state.pendingDecisions, style));
  return parts.join(" · ");
}

function decisionText(decisions: readonly DecisionRequest[], style: StatusWidgetStyle): string {
  const blocking = decisions.filter((decision) => decision.blocking).length;
  if (blocking > 0) return style.warning(`◆ ${blocking} decision${blocking === 1 ? "" : "s"} required`);
  if (decisions.length > 0) return `◇ ${decisions.length} open decision${decisions.length === 1 ? "" : "s"}`;
  return "no blocking decision";
}

function attentionRank(worker: WorkerRecord): number {
  if (worker.status === "failed") return 0;
  if (worker.status === "blocked") return 1;
  return 2;
}
