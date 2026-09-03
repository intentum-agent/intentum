import { assertSafeId } from "../utils/ids.js";

export const PROJECT_PHASES = [
  "discovery",
  "direction",
  "architecture",
  "build",
  "verify",
  "review",
  "ship",
  "maintain",
  "paused",
] as const;

export type ProjectPhase = (typeof PROJECT_PHASES)[number];
export type ActiveProjectPhase = Exclude<ProjectPhase, "paused">;
export type Autonomy = "guided" | "balanced" | "autopilot";

export interface DecisionOption {
  id: string;
  label: string;
  consequence: string;
}

export interface DecisionRequest {
  id: string;
  title: string;
  question: string;
  options: DecisionOption[];
  recommendation?: {
    optionId: string;
    reason: string;
  };
  blocking: boolean;
  affectedWorkIds: string[];
}

export const WORKER_KINDS = ["feasibility", "implementation", "integration", "fix", "qa"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

export const WORKER_STATUSES = [
  "queued",
  "starting",
  "working",
  "blocked",
  "pause_requested",
  "paused",
  "verifying",
  "completed",
  "failed",
  "interrupted",
  "integrated",
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export interface WorkerRecord {
  id: string;
  kind: WorkerKind;
  status: WorkerStatus;
  featureId?: string;
  objective: string;
  sessionRef?: string;
  worktreePath?: string;
  branch?: string;
  targetBranch?: string;
  baseCommit?: string;
  resultCommit?: string;
  progressSummary?: string;
  blocker?: string;
  pauseRequestedAt?: string;
  pendingInstructions?: string[];
  pendingTerminalStatus?: "paused" | "blocked" | "completed" | "failed";
  attemptId?: string;
  updatedAt: string;
}

export interface ProjectState {
  schemaVersion: 1;
  projectId: string;
  projectName: string;
  phase: ProjectPhase;
  phaseBeforePause?: ActiveProjectPhase;
  autonomy: Autonomy;
  activeFeatureId?: string;
  activeCheckpointId?: string;
  workers: Record<string, WorkerRecord>;
  pendingDecisions: DecisionRequest[];
  schedulerPaused: boolean;
  updatedAt: string;
}

const ACTIVE_STATUSES = new Set<WorkerStatus>(["starting", "working", "pause_requested", "verifying"]);

export function isActiveWorkerStatus(status: WorkerStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isProjectPhase(value: unknown): value is ProjectPhase {
  return typeof value === "string" && (PROJECT_PHASES as readonly string[]).includes(value);
}

export function assertProjectState(value: unknown): asserts value is ProjectState {
  if (!value || typeof value !== "object") throw new Error("intentum state must be a JSON object");

  const state = value as Partial<ProjectState>;
  if (state.schemaVersion !== 1) {
    throw new Error(`unsupported intentum state schema: ${String(state.schemaVersion)}`);
  }
  assertNonEmptyString(state.projectId, "intentum state projectId");
  assertSafeId(state.projectId, "project id");
  assertNonEmptyString(state.projectName, "intentum state projectName");
  if (!isProjectPhase(state.phase)) throw new Error(`invalid intentum project phase: ${String(state.phase)}`);
  if (!(state.autonomy === "guided" || state.autonomy === "balanced" || state.autonomy === "autopilot")) {
    throw new Error(`invalid intentum autonomy: ${String(state.autonomy)}`);
  }
  if (!state.workers || typeof state.workers !== "object" || Array.isArray(state.workers)) {
    throw new Error("intentum state workers must be an object");
  }
  if (!Array.isArray(state.pendingDecisions)) throw new Error("intentum state pendingDecisions must be an array");
  if (typeof state.schedulerPaused !== "boolean") {
    throw new Error("intentum state schedulerPaused must be a boolean");
  }
  assertNonEmptyString(state.updatedAt, "intentum state updatedAt");

  const phaseBeforePause: unknown = state.phaseBeforePause;
  if (phaseBeforePause !== undefined && (phaseBeforePause === "paused" || !isProjectPhase(phaseBeforePause))) {
    throw new Error(`invalid phaseBeforePause: ${String(phaseBeforePause)}`);
  }
  if (state.phase === "paused" && (!state.schedulerPaused || phaseBeforePause === undefined)) {
    throw new Error("paused intentum state requires schedulerPaused and phaseBeforePause");
  }
  if (state.phase !== "paused" && (state.schedulerPaused || phaseBeforePause !== undefined)) {
    throw new Error("non-paused intentum state cannot retain schedulerPaused or phaseBeforePause");
  }

  assertOptionalString(state.activeFeatureId, "intentum state activeFeatureId");
  assertOptionalString(state.activeCheckpointId, "intentum state activeCheckpointId");
  for (const [id, worker] of Object.entries(state.workers)) assertWorkerRecord(id, worker);
  for (const [index, decision] of state.pendingDecisions.entries()) assertDecisionRequest(index, decision);
}

function assertWorkerRecord(id: string, worker: WorkerRecord): void {
  if (!worker || typeof worker !== "object" || worker.id !== id) throw new Error(`invalid Worker record: ${id}`);
  assertSafeId(id, "Worker id");
  assertNonEmptyString(worker.objective, `Worker ${id} objective`);
  assertNonEmptyString(worker.updatedAt, `Worker ${id} updatedAt`);
  if (!(WORKER_KINDS as readonly unknown[]).includes(worker.kind)) {
    throw new Error(`invalid Worker kind for ${id}: ${String(worker.kind)}`);
  }
  if (!(WORKER_STATUSES as readonly unknown[]).includes(worker.status)) {
    throw new Error(`invalid Worker status for ${id}: ${String(worker.status)}`);
  }
  for (const [name, optional] of [
    ["featureId", worker.featureId],
    ["sessionRef", worker.sessionRef],
    ["worktreePath", worker.worktreePath],
    ["branch", worker.branch],
    ["targetBranch", worker.targetBranch],
    ["baseCommit", worker.baseCommit],
    ["resultCommit", worker.resultCommit],
    ["progressSummary", worker.progressSummary],
    ["blocker", worker.blocker],
    ["pauseRequestedAt", worker.pauseRequestedAt],
    ["attemptId", worker.attemptId],
  ] as const) assertOptionalString(optional, `Worker ${id} ${name}`);
  if (worker.featureId !== undefined) assertSafeId(worker.featureId, `Worker ${id} feature id`);
  if (worker.pendingInstructions !== undefined) {
    assertStringArray(worker.pendingInstructions, `Worker ${id} pendingInstructions`, true);
  }
  if (worker.pendingTerminalStatus !== undefined
    && !["paused", "blocked", "completed", "failed"].includes(worker.pendingTerminalStatus)) {
    throw new Error(`invalid Worker ${id} pendingTerminalStatus: ${String(worker.pendingTerminalStatus)}`);
  }
  if (worker.pendingTerminalStatus !== undefined && worker.status !== "verifying") {
    throw new Error(`Worker ${id} pendingTerminalStatus requires verifying status`);
  }
}

function assertDecisionRequest(index: number, decision: DecisionRequest): void {
  if (!decision || typeof decision !== "object") throw new Error(`invalid pending decision at index ${index}`);
  assertNonEmptyString(decision.id, `decision ${index} id`);
  assertNonEmptyString(decision.title, `decision ${decision.id} title`);
  assertNonEmptyString(decision.question, `decision ${decision.id} question`);
  if (typeof decision.blocking !== "boolean") throw new Error(`decision ${decision.id} blocking must be boolean`);
  assertStringArray(decision.affectedWorkIds, `decision ${decision.id} affectedWorkIds`, false);
  if (!Array.isArray(decision.options) || decision.options.length < 2) {
    throw new Error(`decision ${decision.id} must contain at least two options`);
  }
  const optionIds = new Set<string>();
  for (const option of decision.options) {
    if (!option || typeof option !== "object") throw new Error(`invalid option in decision ${decision.id}`);
    assertNonEmptyString(option.id, `decision ${decision.id} option id`);
    assertNonEmptyString(option.label, `decision ${decision.id} option label`);
    assertNonEmptyString(option.consequence, `decision ${decision.id} option consequence`);
    if (optionIds.has(option.id)) throw new Error(`decision ${decision.id} contains duplicate option ${option.id}`);
    optionIds.add(option.id);
  }
  if (decision.recommendation !== undefined) {
    assertNonEmptyString(decision.recommendation.optionId, `decision ${decision.id} recommendation optionId`);
    assertNonEmptyString(decision.recommendation.reason, `decision ${decision.id} recommendation reason`);
    if (!optionIds.has(decision.recommendation.optionId)) {
      throw new Error(`decision ${decision.id} recommends an unknown option`);
    }
  }
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined) assertNonEmptyString(value, label);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function assertStringArray(value: unknown, label: string, requireNonEmpty: boolean): asserts value is string[] {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)
    || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be ${requireNonEmpty ? "a non-empty" : "an"} array of non-empty strings`);
  }
}
