import {
  PROJECT_PHASES,
  type ActiveProjectPhase,
  type DecisionRequest,
  type ProjectState,
  type WorkerRecord,
  type WorkerStatus,
} from "../state/schema.js";
import { singleLine } from "./text-layout.js";

export const ACTIVE_WORKER_STATUSES: readonly WorkerStatus[] = ["starting", "working", "pause_requested", "verifying"];
export const ATTENTION_WORKER_STATUSES: readonly WorkerStatus[] = ["failed", "blocked", "interrupted"];
export const ACTIVE_PROJECT_PHASES = PROJECT_PHASES.filter((phase): phase is ActiveProjectPhase => phase !== "paused");

export type PresentationTone = "neutral" | "progress" | "review" | "warning" | "error" | "success";

export interface WorkerStatusPresentation {
  readonly status: WorkerStatus;
  readonly label: string;
  readonly glyph: string;
  readonly tone: PresentationTone;
  readonly category: "queued" | "active" | "paused" | "attention" | "review" | "integrated";
}

export interface WorkerSummary {
  readonly active: WorkerRecord[];
  /** Failed, blocked, or interrupted work. Paused work is deliberately neutral. */
  readonly attention: WorkerRecord[];
  /** Completed work waiting for review/integration. */
  readonly review: WorkerRecord[];
  /** Compatibility aggregate: completed and integrated records. */
  readonly results: WorkerRecord[];
  readonly paused: WorkerRecord[];
  readonly queued: WorkerRecord[];
}

export interface HarnessPhasePresentation {
  /** Active phase, including the phase a paused project will resume into. */
  readonly current: ActiveProjectPhase;
  readonly paused: boolean;
  readonly index: number;
  readonly total: number;
  readonly label: string;
  readonly previous?: ActiveProjectPhase;
  readonly next?: ActiveProjectPhase;
}

export type HarnessPrimaryAction =
  | { readonly kind: "open-decision"; readonly label: string; readonly decisionId: string }
  | { readonly kind: "review-worker"; readonly label: string; readonly workerId: string }
  | { readonly kind: "open-worker"; readonly label: string; readonly workerId: string }
  | { readonly kind: "resume-project"; readonly label: string }
  | { readonly kind: "continue-in-chat"; readonly label: string };

export interface HarnessWorkerCounts {
  readonly total: number;
  readonly active: number;
  readonly verifying: number;
  readonly review: number;
  readonly integrated: number;
  readonly attention: number;
  readonly failed: number;
  readonly blocked: number;
  readonly interrupted: number;
  readonly paused: number;
  readonly queued: number;
}

/** Canonical, schema-free presentation state shared by every UI surface. */
export interface HarnessPresentationModel {
  readonly phase: HarnessPhasePresentation;
  readonly severity: PresentationTone;
  readonly nextStep: string;
  readonly primaryAction: HarnessPrimaryAction;
  readonly workers: WorkerSummary;
  readonly counts: HarnessWorkerCounts;
  readonly blockingDecision?: DecisionRequest;
}

export function deriveHarnessPresentation(state: ProjectState): HarnessPresentationModel {
  const workers = sortedWorkers(state);
  const summary = summarizeWorkers(workers);
  const blockingDecision = state.pendingDecisions.find((decision) => decision.blocking);
  const failed = workers.find((worker) => worker.status === "failed");
  const blocked = workers.find((worker) => worker.status === "blocked");
  const interrupted = workers.find((worker) => worker.status === "interrupted");
  const stuck = failed ?? blocked ?? interrupted;
  const completed = summary.review[0];
  const verifying = workers.find((worker) => worker.status === "verifying");
  const active = workers.find((worker) => ACTIVE_WORKER_STATUSES.includes(worker.status));
  const pausedWorker = summary.paused[0];

  let nextStep: string;
  let primaryAction: HarnessPrimaryAction;
  if (state.phase === "paused") {
    nextStep = "Project is paused. Resume it when you are ready.";
    primaryAction = { kind: "resume-project", label: "Resume project" };
  } else if (blockingDecision) {
    nextStep = `Answer decision ${singleLine(blockingDecision.id)} so blocked work can continue.`;
    primaryAction = { kind: "open-decision", label: "Answer decision", decisionId: blockingDecision.id };
  } else if (stuck) {
    nextStep = recoveryStep(stuck);
    primaryAction = { kind: "open-worker", label: "Inspect Worker", workerId: stuck.id };
  } else if (completed) {
    nextStep = `Review ${completed.id}'s result and integrate it when the evidence is sufficient.`;
    primaryAction = { kind: "review-worker", label: "Review result", workerId: completed.id };
  } else if (verifying) {
    nextStep = `${verifying.id} is verifying its result. Review the evidence when verification completes.`;
    primaryAction = { kind: "open-worker", label: "View progress", workerId: verifying.id };
  } else if (active) {
    nextStep = `${active.id} is ${workerStatusPresentation(active.status).label.toLowerCase()}. Keep shaping the product or steer it with a targeted instruction.`;
    primaryAction = { kind: "open-worker", label: "View Worker", workerId: active.id };
  } else if (pausedWorker) {
    nextStep = `${pausedWorker.id} is paused. Resume it or give it a targeted instruction.`;
    primaryAction = { kind: "open-worker", label: "Open paused Worker", workerId: pausedWorker.id };
  } else if (state.phase === "discovery") {
    nextStep = "Shape the charter from repository evidence, then confirm only the decisions the code cannot answer.";
    primaryAction = { kind: "continue-in-chat", label: "Continue in chat" };
  } else {
    nextStep = "Describe the next outcome in chat; the Designer will turn it into focused work.";
    primaryAction = { kind: "continue-in-chat", label: "Continue in chat" };
  }

  const counts = workerCounts(workers, summary);
  const severity: PresentationTone = counts.failed || counts.interrupted
    ? "error"
    : blockingDecision || counts.blocked
      ? "warning"
      : counts.review
        ? "review"
        : counts.active
          ? "progress"
          : "neutral";

  return {
    phase: phasePresentation(state),
    severity,
    nextStep,
    primaryAction,
    workers: summary,
    counts,
    ...(blockingDecision ? { blockingDecision } : {}),
  };
}

export function phasePresentation(state: ProjectState): HarnessPhasePresentation {
  const paused = state.phase === "paused";
  const current: ActiveProjectPhase = state.phase === "paused" ? (state.phaseBeforePause ?? "discovery") : state.phase;
  const zeroBased = Math.max(0, ACTIVE_PROJECT_PHASES.indexOf(current));
  const label = paused
    ? `PAUSED (${current} ${zeroBased + 1}/${ACTIVE_PROJECT_PHASES.length})`
    : `${current.toUpperCase()} ${zeroBased + 1}/${ACTIVE_PROJECT_PHASES.length}`;
  const previous = ACTIVE_PROJECT_PHASES[zeroBased - 1];
  const next = ACTIVE_PROJECT_PHASES[zeroBased + 1];
  return {
    current,
    paused,
    index: zeroBased + 1,
    total: ACTIVE_PROJECT_PHASES.length,
    label,
    ...(previous ? { previous } : {}),
    ...(next ? { next } : {}),
  };
}

export function phaseLabel(state: ProjectState): string {
  return phasePresentation(state).label;
}

export function workerStatusPresentation(status: WorkerStatus): WorkerStatusPresentation {
  switch (status) {
    case "queued": return { status, label: "Queued", glyph: "◌", tone: "neutral", category: "queued" };
    case "starting": return { status, label: "Starting", glyph: "◔", tone: "progress", category: "active" };
    case "working": return { status, label: "Working", glyph: "●", tone: "progress", category: "active" };
    case "pause_requested": return { status, label: "Pausing", glyph: "◑", tone: "neutral", category: "active" };
    case "verifying": return { status, label: "Verifying", glyph: "◐", tone: "progress", category: "active" };
    case "paused": return { status, label: "Paused", glyph: "○", tone: "neutral", category: "paused" };
    case "blocked": return { status, label: "Blocked", glyph: "⚠", tone: "warning", category: "attention" };
    case "failed": return { status, label: "Failed", glyph: "✕", tone: "error", category: "attention" };
    case "interrupted": return { status, label: "Interrupted", glyph: "!", tone: "error", category: "attention" };
    case "completed": return { status, label: "Ready for review", glyph: "✓", tone: "review", category: "review" };
    case "integrated": return { status, label: "Integrated", glyph: "✓", tone: "success", category: "integrated" };
  }
}

export function summarizeWorkers(workers: readonly WorkerRecord[]): WorkerSummary {
  const active = workers.filter((worker) => ACTIVE_WORKER_STATUSES.includes(worker.status));
  const attention = workers.filter((worker) => ATTENTION_WORKER_STATUSES.includes(worker.status));
  const review = workers.filter((worker) => worker.status === "completed");
  return {
    active,
    attention,
    review,
    results: workers.filter((worker) => worker.status === "completed" || worker.status === "integrated"),
    paused: workers.filter((worker) => worker.status === "paused"),
    queued: workers.filter((worker) => worker.status === "queued"),
  };
}

/** Newest first, so attention follows the most recent state change. */
export function sortedWorkers(state: ProjectState): WorkerRecord[] {
  return Object.values(state.workers).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

function workerCounts(workers: readonly WorkerRecord[], summary: WorkerSummary): HarnessWorkerCounts {
  const count = (status: WorkerStatus): number => workers.filter((worker) => worker.status === status).length;
  return {
    total: workers.length,
    active: summary.active.length,
    verifying: count("verifying"),
    review: summary.review.length,
    integrated: count("integrated"),
    attention: summary.attention.length,
    failed: count("failed"),
    blocked: count("blocked"),
    interrupted: count("interrupted"),
    paused: summary.paused.length,
    queued: summary.queued.length,
  };
}

function recoveryStep(worker: WorkerRecord): string {
  if (worker.status === "failed") return `${worker.id} failed. Inspect the evidence before retrying or replacing the work.`;
  if (worker.status === "blocked") return `${worker.id} is blocked. Resolve the blocker or give it a targeted instruction.`;
  return `${worker.id} was interrupted. Inspect preserved work before resuming it.`;
}
