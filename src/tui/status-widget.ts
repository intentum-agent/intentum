import { PROJECT_PHASES, type DecisionRequest, type ProjectState, type WorkerRecord } from "../state/schema.js";

export interface StatusWidgetOptions {
  /** Emit ANSI styling. Leave off for RPC/JSON hosts that expect plain lines. */
  color?: boolean;
}

export const ACTIVE_WORKER_STATUSES: readonly WorkerRecord["status"][] = ["starting", "working", "pause_requested", "verifying"];
export const ATTENTION_WORKER_STATUSES: readonly WorkerRecord["status"][] = ["blocked", "failed", "paused", "interrupted"];

const ACTIVE_PHASES = PROJECT_PHASES.filter((phase) => phase !== "paused");
const MAX_RESULT_LINES = 2;
const MAX_RISK_LINES = 2;
const BLOCKER_LIMIT = 96;

interface Palette {
  dim(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  danger(text: string): string;
}

const PLAIN: Palette = {
  dim: (text) => text,
  success: (text) => text,
  warning: (text) => text,
  danger: (text) => text,
};

const ANSI: Palette = {
  dim: (text) => `\u001b[2m${text}\u001b[22m`,
  success: (text) => `\u001b[32m${text}\u001b[39m`,
  warning: (text) => `\u001b[33m${text}\u001b[39m`,
  danger: (text) => `\u001b[31m${text}\u001b[39m`,
};

/**
 * Above-editor widget: only what needs attention right now. Identity, phase,
 * and counts live in the footer, so an idle project renders nothing here.
 */
export function renderStatusWidget(state: ProjectState, options: StatusWidgetOptions = {}): string[] {
  const palette = options.color ? ANSI : PLAIN;
  const summary = summarizeWorkers(sortedWorkers(state));
  const blocking = state.pendingDecisions.find((decision) => decision.blocking);

  const lines: string[] = [];
  for (const worker of summary.results.filter((item) => item.status === "completed").slice(0, MAX_RESULT_LINES)) {
    lines.push(palette.success(`✓ ${worker.id} ${resultText(worker)}`));
  }
  for (const worker of summary.attention.slice(0, MAX_RISK_LINES)) {
    lines.push(palette.danger(`⚠ ${worker.id} ${riskText(worker)}`));
  }
  if (blocking) lines.push(palette.warning(`◆ Decision required: ${singleLine(blocking.title, BLOCKER_LIMIT)}`));
  return lines;
}

/**
 * Compact status for a notification. Pi renders info notifications dim, so
 * this keeps to a few short lines; the full field-by-field text stays in
 * `renderStatusText` for tool results and non-TUI hosts.
 */
export function renderStatusBrief(state: ProjectState): string {
  const summary = summarizeWorkers(sortedWorkers(state));
  const lines = [`${state.projectName} · ${phaseLabel(state)} · ${featureLine(state)}`];
  for (const worker of summary.attention.slice(0, MAX_RISK_LINES)) lines.push(`⚠ ${worker.id} ${riskText(worker)}`);
  const blocking = state.pendingDecisions.find((decision) => decision.blocking);
  if (blocking) lines.push(`◆ Decision required: ${singleLine(blocking.title, BLOCKER_LIMIT)}`);
  lines.push(summaryLine(summary, state, PLAIN));
  return lines.join("\n");
}

export function renderStatusText(state: ProjectState): string {
  const workers = Object.values(state.workers);
  const workerLines = workers.length
    ? workers.map((worker) => `- ${worker.id} ${worker.status}: ${worker.blocker ?? worker.progressSummary ?? worker.objective}`).join("\n")
    : "- No Worker has been started.";
  const decisions = state.pendingDecisions.length
    ? state.pendingDecisions.map((decision) => `- ${decision.id} ${decision.blocking ? "blocking" : "open"}: ${decision.title}`).join("\n")
    : "- No pending decision.";
  return [
    `Project: ${state.projectName}`,
    `Phase: ${phaseLabel(state).toLowerCase()}`,
    `Autonomy: ${state.autonomy}`,
    `Scheduler paused: ${state.schedulerPaused ? "yes" : "no"}`,
    `Active feature: ${state.activeFeatureId ?? "none"}`,
    "Workers:",
    workerLines,
    "Decisions:",
    decisions,
  ].join("\n");
}

/** `BUILD 4/8`, or `PAUSED (build 4/8)` while the scheduler is stopped. */
export function phaseLabel(state: ProjectState): string {
  if (state.phase === "paused") {
    const before = state.phaseBeforePause;
    return before ? `PAUSED (${before} ${phaseIndex(before)})` : "PAUSED";
  }
  return `${state.phase.toUpperCase()} ${phaseIndex(state.phase)}`;
}

function phaseIndex(phase: ProjectState["phase"]): string {
  const index = ACTIVE_PHASES.indexOf(phase as (typeof ACTIVE_PHASES)[number]);
  return `${index + 1}/${ACTIVE_PHASES.length}`;
}

function featureLine(state: ProjectState): string {
  const feature = state.activeFeatureId ? `Feature: ${state.activeFeatureId}` : "Feature: none yet";
  return `${feature} · autonomy ${state.autonomy}`;
}

export interface WorkerSummary {
  active: WorkerRecord[];
  attention: WorkerRecord[];
  results: WorkerRecord[];
  queued: WorkerRecord[];
}

export function summarizeWorkers(workers: readonly WorkerRecord[]): WorkerSummary {
  return {
    active: workers.filter((worker) => ACTIVE_WORKER_STATUSES.includes(worker.status)),
    attention: workers.filter((worker) => ATTENTION_WORKER_STATUSES.includes(worker.status)),
    results: workers.filter((worker) => worker.status === "completed" || worker.status === "integrated"),
    queued: workers.filter((worker) => worker.status === "queued"),
  };
}

/** Newest first, so the widget surfaces the latest change rather than W-001 forever. */
export function sortedWorkers(state: ProjectState): WorkerRecord[] {
  return Object.values(state.workers).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

function resultText(worker: WorkerRecord): string {
  return `${singleLine(worker.objective, 72)} — ready to integrate`;
}

function riskText(worker: WorkerRecord): string {
  const detail = worker.blocker ? singleLine(worker.blocker, BLOCKER_LIMIT) : singleLine(worker.objective, 72);
  return `${worker.status}: ${detail}`;
}

function summaryLine(summary: WorkerSummary, state: ProjectState, palette: Palette): string {
  const total = Object.keys(state.workers).length;
  if (total === 0) {
    return palette.dim("No Worker yet · describe the outcome you want in chat and the Designer will plan the work");
  }
  const parts = [
    `● ${summary.active.length} active`,
    palette.success(`✓ ${summary.results.length} done`),
    summary.attention.length ? palette.danger(`⚠ ${summary.attention.length} need attention`) : "⚠ 0 need attention",
  ];
  if (summary.queued.length) parts.push(`◌ ${summary.queued.length} queued`);
  parts.push(decisionText(state.pendingDecisions, palette));
  return parts.join(" · ");
}

function decisionText(decisions: readonly DecisionRequest[], palette: Palette): string {
  const blocking = decisions.filter((decision) => decision.blocking).length;
  if (blocking > 0) return palette.warning(`◆ ${blocking} decision${blocking === 1 ? "" : "s"} required`);
  if (decisions.length > 0) return `◇ ${decisions.length} open decision${decisions.length === 1 ? "" : "s"}`;
  return "no blocking decision";
}

function singleLine(value: string, limit: number): string {
  const collapsed = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}
