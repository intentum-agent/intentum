import type { ProjectState, WorkerRecord } from "../state/schema.js";

export function renderStatusWidget(state: ProjectState): string[] {
  const workers = Object.values(state.workers);
  const active = workers.filter((worker) =>
    ["starting", "working", "pause_requested", "verifying"].includes(worker.status),
  );
  const attention = workers.filter((worker) =>
    ["blocked", "failed", "paused", "interrupted"].includes(worker.status),
  );
  const completed = workers.filter((worker) => worker.status === "completed" || worker.status === "integrated");
  const decisionText = state.pendingDecisions.some((decision) => decision.blocking)
    ? "decision required"
    : "no blocking decision";

  const lines = [
    `intentum · ${state.projectName}    ${state.phase.toUpperCase()}`,
    `Feature: ${state.activeFeatureId ?? "discovery"}`,
    `${completed.length} completed · ${active.length} active · ${attention.length} need attention · ${decisionText}`,
  ];
  const risk = mostRelevantRisk(workers);
  if (risk) lines.push(`⚠ ${risk}`);
  lines.push(relevantActions(state));
  return lines;
}

export function renderStatusText(state: ProjectState): string {
  const workers = Object.values(state.workers);
  const workerLines = workers.length
    ? workers.map((worker) => `- ${worker.id} ${worker.status}: ${worker.progressSummary ?? worker.objective}`).join("\n")
    : "- No Worker has been started.";
  return [
    `Project: ${state.projectName}`,
    `Phase: ${state.phase}`,
    `Autonomy: ${state.autonomy}`,
    `Scheduler paused: ${state.schedulerPaused ? "yes" : "no"}`,
    `Active feature: ${state.activeFeatureId ?? "none"}`,
    "Workers:",
    workerLines,
  ].join("\n");
}

function mostRelevantRisk(workers: WorkerRecord[]): string | undefined {
  const worker = workers.find((item) => item.blocker);
  if (!worker?.blocker) return undefined;
  const singleLine = worker.blocker.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const bounded = singleLine.length <= 160 ? singleLine : `${singleLine.slice(0, 159)}…`;
  return `${worker.id}: ${bounded}`;
}

function relevantActions(state: ProjectState): string {
  if (state.phase === "paused") return "[status] [resume] [workers]";
  if (state.pendingDecisions.some((decision) => decision.blocking)) {
    return "[status] [decisions] [workers] [pause]";
  }
  if (Object.values(state.workers).some((worker) => worker.status === "completed")) {
    return "[status] [workers] [integrate] [pause]";
  }
  if (Object.values(state.workers).some((worker) => worker.status === "paused" || worker.status === "interrupted")) {
    return "[status] [workers] [worker-resume] [pause]";
  }
  return "[status] [workers] [pause] [help]";
}
