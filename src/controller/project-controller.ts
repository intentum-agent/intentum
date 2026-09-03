import { access } from "node:fs/promises";
import type { ProjectPhase, ProjectState, WorkerRecord } from "../state/schema.js";
import { isActiveWorkerStatus } from "../state/schema.js";
import type { ActivityLog } from "../state/activity-log.js";
import type { ProjectStore } from "../state/project-store.js";
import { pauseProject, resumeProject, transitionProject } from "./lifecycle.js";

export interface RecoveryWorkerSummary {
  workerId: string;
  worktreePresent: boolean;
  sessionPresent: boolean;
}

export interface RecoverySummary {
  interrupted: RecoveryWorkerSummary[];
  abandoned: RecoveryWorkerSummary[];
  needsAttention: RecoveryWorkerSummary[];
}

export class ProjectController {
  constructor(
    readonly store: ProjectStore,
    readonly activity: ActivityLog,
    private readonly onChanged: (state: ProjectState) => void = () => undefined,
    private readonly ensureControllerOwnership: () => Promise<void> = async () => undefined,
  ) {}

  async initialize(projectName?: string): Promise<{ state: ProjectState; created: boolean }> {
    await this.ensureControllerOwnership();
    const result = await this.store.initialize(projectName ? { projectName } : {});
    if (result.created) {
      await this.activity.append({ type: "project_initialized", projectId: result.state.projectId });
    }
    this.emitChange(result.state);
    return result;
  }

  async transition(target: ProjectPhase): Promise<ProjectState> {
    await this.ensureControllerOwnership();
    const state = await this.store.update((current) => transitionProject(current, target));
    await this.activity.append({ type: "phase_changed", phase: state.phase });
    this.emitChange(state);
    return state;
  }

  async pause(): Promise<ProjectState> {
    await this.ensureControllerOwnership();
    const state = await this.store.update(pauseProject);
    await this.activity.append({ type: "project_paused", phaseBeforePause: state.phaseBeforePause });
    this.emitChange(state);
    return state;
  }

  async resume(): Promise<ProjectState> {
    await this.ensureControllerOwnership();
    const state = await this.store.update(resumeProject);
    await this.activity.append({ type: "project_resumed", phase: state.phase });
    this.emitChange(state);
    return state;
  }

  async recoverInterruptedWork(): Promise<RecoverySummary> {
    await this.ensureControllerOwnership();
    if (!(await this.store.exists())) return { interrupted: [], abandoned: [], needsAttention: [] };

    const before = await this.store.read();
    const candidates = Object.values(before.workers).filter(
      (worker) => !["completed", "failed", "integrated"].includes(worker.status),
    );
    if (candidates.length === 0) return { interrupted: [], abandoned: [], needsAttention: [] };

    const inspected: RecoveryWorkerSummary[] = [];
    for (const worker of candidates) {
      inspected.push({
        workerId: worker.id,
        worktreePresent: await pathExists(worker.worktreePath),
        sessionPresent: await pathExists(worker.sessionRef),
      });
    }

    const snapshots = new Map(candidates.map((worker) => [worker.id, {
      status: worker.status,
      attemptId: worker.attemptId,
    }]));
    const presence = new Map(inspected.map((item) => [item.workerId, item]));
    const state = await this.store.update((current) => {
      const workers = { ...current.workers };
      for (const [id, snapshot] of snapshots) {
        const worker = workers[id];
        if (!worker
          || worker.status !== snapshot.status
          || worker.attemptId !== snapshot.attemptId
          || ["completed", "failed", "integrated"].includes(worker.status)) continue;
        const resources = presence.get(id);
        const abandoned = worker.status === "queued" || !resources?.worktreePresent;
        const interrupted = isActiveWorkerStatus(worker.status) && !abandoned;
        if (!abandoned && !interrupted) continue;
        const recovered: WorkerRecord = {
          ...worker,
          status: abandoned ? "failed" : "interrupted",
          ...(abandoned
            ? {
              blocker: worker.status === "queued"
                ? "Controller restarted before the queued Worker acquired recoverable resources. The reservation was abandoned; create a new WorkContract."
                : "Controller restarted but the recorded Worker worktree is missing. The record was abandoned to release the single-Worker slot; inspect preserved Git refs manually.",
            }
            : worker.blocker
              ? { blocker: worker.blocker }
              : {}),
          progressSummary: abandoned
            ? `Startup recovery abandoned an unrecoverable ${worker.status} record. Worktree: ${resources?.worktreePresent ? "present" : "missing"}; Pi session: ${resources?.sessionPresent ? "present" : "missing"}.`
            : `Controller restarted. Worktree: present; Pi session: ${resources?.sessionPresent ? "present" : "missing"}. Review before explicit resume.`,
          updatedAt: new Date().toISOString(),
        };
        delete recovered.pendingTerminalStatus;
        if (recovered.status !== "pause_requested") delete recovered.pauseRequestedAt;
        workers[id] = recovered;
      }
      return { ...current, workers };
    });

    const interrupted = inspected.filter((item) => {
      const original = before.workers[item.workerId];
      return original !== undefined && isActiveWorkerStatus(original.status) && item.worktreePresent;
    });
    const abandoned = inspected.filter((item) => {
      const original = before.workers[item.workerId];
      return original?.status === "queued" || !item.worktreePresent;
    });
    const changedIds = new Set([...interrupted, ...abandoned].map((item) => item.workerId));
    const needsAttention = inspected.filter((item) => !changedIds.has(item.workerId));
    for (const item of interrupted) {
      await this.activity.append({ type: "worker_interrupted", ...item });
    }
    for (const item of abandoned) {
      await this.activity.append({ type: "worker_recovery_abandoned", ...item });
    }
    this.emitChange(state);
    return { interrupted, abandoned, needsAttention };
  }

  async getWorker(workerId: string): Promise<WorkerRecord> {
    await this.ensureControllerOwnership();
    const worker = (await this.store.read()).workers[workerId];
    if (!worker) throw new Error(`unknown intentum worker: ${workerId}`);
    return worker;
  }

  private emitChange(state: ProjectState): void {
    try {
      this.onChanged(state);
    } catch {
      // TUI observers are non-canonical. A rendering error must not interrupt a
      // state transition that has already been durably written.
    }
  }
}

async function pathExists(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
