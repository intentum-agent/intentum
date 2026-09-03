import { randomUUID } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IntegrationConflictError, type IntegrationManager } from "../git/integration-manager.js";
import type { WorktreeManager } from "../git/worktree-manager.js";
import type { WorkerRecord, ProjectState } from "../state/schema.js";
import { isActiveWorkerStatus } from "../state/schema.js";
import type { ActivityLog } from "../state/activity-log.js";
import type { ProjectStore } from "../state/project-store.js";
import { assertSafeId, nextSequentialId } from "../utils/ids.js";
import { assertRepositoryOwnedPath, ensureRepositoryOwnedDirectory } from "../utils/safe-path.js";
import { withFileLock } from "../utils/file-lock.js";
import type { WorkContract } from "./contract.js";
import { assertWorkContract, WorkContractStore } from "./contract.js";
import type { WorkerResult, WorkerResultInput } from "./result.js";
import { assertWorkerResult, assertWorkerResultInput } from "./result.js";
import {
  WorkerSessionUnavailableError,
  type WorkerCallbacks,
  type WorkerCommitInput,
  type WorkerCommitResult,
  type WorkerEscalationInput,
  type WorkerProgressInput,
  type WorkerRuntime,
  type WorkerRuntimeFactory,
} from "../runtime/worker-runtime.js";

const SAFE_PAUSE_PROMPT = `A safe pause was requested. Finish only the current atomic tool operation, preserve every file and the worktree, optionally create a clearly labelled WIP commit, then call intentum_progress with state "paused" and a factual summary. Do not begin new work.`;

interface ManagedRuntime {
  runtime: WorkerRuntime;
  unsubscribe: () => void;
  generation: number;
  turn: number;
  promptOutcome?: {
    turn: number;
    promise: Promise<{ ok: true } | { ok: false; error: unknown }>;
  };
  turnFailure?: {
    turn: number;
    error: string;
  };
  promptDelivery?: {
    turn: number;
    attemptId: string;
    instructions: string[];
  };
}

interface ManagedIntegration {
  controller: AbortController;
  promise: Promise<WorkerRecord>;
}

export type NewWorkContract = Omit<WorkContract, "id">;

export class WorkerManager {
  private readonly contracts: WorkContractStore;
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly runtimeGenerations = new Map<string, number>();
  private readonly controlRevisions = new Map<string, number>();
  private readonly abortOperations = new Map<string, Promise<WorkerRecord>>();
  private readonly integrationOperations = new Set<ManagedIntegration>();
  private readonly createOperations = new Set<Promise<WorkerRecord>>();
  private readonly workerOperationTails = new Map<string, Promise<void>>();
  private createTail: Promise<void> = Promise.resolve();
  private lifecycleAbortController = new AbortController();
  private disposed = false;
  private lifecycleEpoch = 0;
  private projectTrusted = false;

  constructor(
    private readonly store: ProjectStore,
    private readonly activity: ActivityLog,
    private readonly worktrees: WorktreeManager,
    private readonly integration: IntegrationManager,
    private readonly runtimeFactory: WorkerRuntimeFactory,
    private readonly onChanged: (state: ProjectState) => void = () => undefined,
    private readonly ensureControllerOwnership: () => Promise<void> = async () => undefined,
  ) {
    this.contracts = new WorkContractStore(store.projectRoot);
  }

  setSessionDefaults: NonNullable<WorkerRuntimeFactory["setSessionDefaults"]> = (defaults) => {
    if (defaults.projectTrusted !== undefined) this.projectTrusted = defaults.projectTrusted;
    this.runtimeFactory.setSessionDefaults?.(defaults);
  };

  /** Reactivate this manager when the owning Pi extension session starts again. */
  activate(): void {
    if (this.disposed) this.lifecycleAbortController = new AbortController();
    this.disposed = false;
  }

  async createAndStart(input: NewWorkContract): Promise<WorkerRecord> {
    await this.ensureControllerOwnership();
    const lifecycleEpoch = this.captureLifecycleEpoch();
    const signal = this.lifecycleAbortController.signal;
    const operation = this.createTail.then(() => this.createAndStartUnlocked(input, lifecycleEpoch, signal));
    this.createOperations.add(operation);
    this.createTail = operation.then(() => undefined, () => undefined);
    try {
      return await operation;
    } finally {
      this.createOperations.delete(operation);
    }
  }

  private async createAndStartUnlocked(
    input: NewWorkContract,
    lifecycleEpoch: number,
    signal: AbortSignal,
  ): Promise<WorkerRecord> {
    signal.throwIfAborted();
    this.assertLifecycleEpoch(lifecycleEpoch);
    this.assertProjectTrusted();
    const state = await this.store.read();
    this.assertLifecycleEpoch(lifecycleEpoch);
    if (state.schedulerPaused || state.phase === "paused") {
      throw new Error("intentum is paused; resume the project before starting work");
    }
    const existingActive = Object.values(state.workers).find((worker) => isUnfinishedWorker(worker.status));
    if (existingActive) {
      throw new Error(`Phase 2 supports one active Worker; ${existingActive.id} is ${existingActive.status}`);
    }

    const workerId = nextSequentialId("W", Object.keys(state.workers));
    const contract: WorkContract = { ...structuredClone(input), id: workerId };
    assertWorkContract(contract);
    const [charter, architecture] = await Promise.all([
      this.store.readArtifact("charter"),
      this.store.readArtifact("architecture"),
    ]);
    this.assertLifecycleEpoch(lifecycleEpoch);

    let worker: WorkerRecord = {
      id: workerId,
      kind: contract.preferredWorkerKind,
      status: "queued",
      featureId: contract.featureId,
      objective: contract.objective,
      attemptId: randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    let reserved = false;
    let createdRuntime: WorkerRuntime | undefined;
    let runtimeGeneration: number | undefined;

    try {
      // Reserve the identifier in canonical state before writing the contract. If
      // the process exits between these operations, startup recovery marks this
      // queued reservation failed, so the id cannot be reused or deadlock the
      // single-Worker slot.
      worker = await this.updateWorker(workerId, (_current, currentState) => {
        this.assertLifecycleEpoch(lifecycleEpoch);
        assertProjectCanStartWorker(currentState);
        return worker;
      }, contract.featureId);
      reserved = true;
      await this.contracts.save(contract);
      this.assertLifecycleEpoch(lifecycleEpoch);
      await this.activity.append({ type: "work_created", workerId, featureId: contract.featureId });
      this.assertLifecycleEpoch(lifecycleEpoch);
      worker = await this.updateWorker(workerId, (current, currentState) => {
        this.assertLifecycleEpoch(lifecycleEpoch);
        assertProjectCanStartWorker(currentState);
        if (current.status !== "queued") throw new Error(`Worker ${workerId} cannot start while ${current.status}`);
        return { ...current, status: "starting" };
      });
      const worktree = await this.worktrees.create(
        state.projectId,
        contract.featureId,
        workerId,
        async (planned) => {
          worker = await this.updateWorker(workerId, (current) => {
            this.assertLifecycleEpoch(lifecycleEpoch);
            if (current.status !== "starting") {
              throw new Error(`Worker ${workerId} cannot reserve a worktree while ${current.status}`);
            }
            return {
              ...current,
              worktreePath: planned.path,
              branch: planned.branch,
              targetBranch: planned.targetBranch,
              baseCommit: planned.baseCommit,
            };
          });
        },
        signal,
      );
      signal.throwIfAborted();
      this.assertLifecycleEpoch(lifecycleEpoch);

      const generation = this.nextRuntimeGeneration(workerId);
      runtimeGeneration = generation;
      const runtime = await awaitAbortableRuntime(this.runtimeFactory.create({
          workerId,
          worktreePath: worktree.path,
          contract,
          callbacks: this.callbacksFor(workerId, generation),
        }), signal);
      createdRuntime = runtime;
      this.assertLifecycleEpoch(lifecycleEpoch);
      await this.attachRuntime(workerId, runtime, generation, lifecycleEpoch);
      worker = await this.updateWorker(workerId, (current, currentState) => {
        this.assertLifecycleEpoch(lifecycleEpoch);
        assertProjectCanStartWorker(currentState);
        if (current.status !== "starting") {
          throw new Error(`Worker ${workerId} cannot finish starting while ${current.status}`);
        }
        return {
          ...current,
          status: "working",
          ...(runtime.sessionRef ? { sessionRef: runtime.sessionRef } : {}),
          progressSummary: "Worker session started with an outcome-based contract.",
        };
      });
      // Do not yield between the final state CAS and starting the prompt. A
      // pause queued earlier wins the CAS; a pause queued later sees this live
      // runtime and sends the safe-pause steering instruction.
      this.assertLifecycleEpoch(lifecycleEpoch);
      this.launchPrompt(
        workerId,
        runtime,
        renderContractPrompt(contract, worktree.baseCommit, charter, architecture),
        generation,
        worker.attemptId!,
        [],
      );
      await this.activity.append({
        type: "worker_started",
        workerId,
        sessionRef: runtime.sessionRef,
        branch: worktree.branch,
      });
      return worker;
    } catch (error) {
      if (reserved && this.isLifecycleEpochCurrent(lifecycleEpoch)) {
        await this.markFailed(workerId, error, runtimeGeneration);
      }
      if (runtimeGeneration !== undefined) this.invalidateRuntimeGeneration(workerId, runtimeGeneration);
      const attached = this.runtimes.get(workerId);
      if (runtimeGeneration !== undefined && attached?.generation === runtimeGeneration && attached.runtime === createdRuntime) {
        await this.disposeRuntime(workerId, runtimeGeneration).catch(() => undefined);
      } else if (createdRuntime) {
        await Promise.resolve(createdRuntime.dispose()).catch(() => undefined);
      }
      throw error;
    }
  }

  async inspect(workerId: string): Promise<{
    worker: WorkerRecord;
    contract?: WorkContract;
    result?: WorkerResult;
    diagnostic?: string;
  }> {
    await this.ensureControllerOwnership();
    const worker = this.requireWorker(await this.store.read(), workerId);
    let contract: WorkContract | undefined;
    let diagnostic: string | undefined;
    try {
      contract = await this.contracts.get(worker.featureId ?? "", workerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (worker.status !== "failed" || !message.includes("unknown WorkContract")) throw error;
      diagnostic = `The failed startup reservation has no persisted WorkContract: ${message}`;
    }
    const storedResult = await this.readStoredResult(workerId);
    const result = storedResult?.attemptId === worker.attemptId ? storedResult : undefined;
    if (storedResult && !result) {
      diagnostic = [
        diagnostic,
        `A durable result from prior attempt ${storedResult.attemptId} is preserved but is not the current attempt ${worker.attemptId ?? "unknown"}.`,
      ].filter(Boolean).join(" ");
    }
    return {
      worker,
      ...(contract ? { contract } : {}),
      ...(result ? { result } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
  }

  /**
   * Reconcile the narrow crash window between durable result.json publication
   * and the canonical Worker state transition. This runs only at host session
   * startup, after the previous Pi process/turn has stopped.
   */
  async reconcilePendingResults(): Promise<string[]> {
    await this.ensureControllerOwnership();
    const lifecycleEpoch = this.captureLifecycleEpoch();
    const state = await this.store.read();
    const reconciled: string[] = [];
    for (const snapshot of Object.values(state.workers)) {
      if (!["working", "pause_requested", "verifying"].includes(snapshot.status)) continue;
      try {
        const storedResult = await this.readStoredResult(snapshot.id);
        const result = storedResult?.attemptId === snapshot.attemptId ? storedResult : undefined;
        if (snapshot.status === "verifying" && snapshot.pendingTerminalStatus === "paused") {
          await this.updateWorker(snapshot.id, (current) => {
            this.assertLifecycleEpoch(lifecycleEpoch);
            if (current.attemptId !== snapshot.attemptId
              || current.status !== "verifying"
              || current.pendingTerminalStatus !== "paused") return current;
            const next = {
              ...current,
              status: "paused" as const,
              progressSummary: current.progressSummary ?? "Recovered a safe pause that settled before controller restart.",
            };
            delete next.pendingTerminalStatus;
            delete next.pauseRequestedAt;
            delete next.blocker;
            return next;
          });
          reconciled.push(snapshot.id);
          continue;
        }
        if (snapshot.status === "verifying" && snapshot.pendingTerminalStatus === "blocked" && !result) {
          await this.publishRecoveredTerminal(
            snapshot.id,
            "blocked",
            snapshot.blocker ?? "Worker escalation recovered after restart.",
            lifecycleEpoch,
            snapshot.attemptId,
          );
          reconciled.push(snapshot.id);
          continue;
        }
        if (snapshot.status === "verifying" && !result) {
          throw new Error(
            snapshot.pendingTerminalStatus
              ? `pending ${snapshot.pendingTerminalStatus} disposition has no durable result`
              : "verifying Worker has neither a pending terminal disposition nor a durable result",
          );
        }
        if (!result) continue;
        if (snapshot.pendingTerminalStatus && snapshot.pendingTerminalStatus !== result.status) {
          throw new Error(
            `pending terminal status ${snapshot.pendingTerminalStatus} does not match stored result status ${result.status}`,
          );
        }
        if (result.status === "completed") {
          if (!snapshot.worktreePath || !snapshot.branch || !snapshot.baseCommit || !result.resultCommit) {
            throw new Error(`Worker ${snapshot.id} lacks metadata for completed-result recovery`);
          }
          const managedPath = await this.worktrees.assertRecoverableWorktree(
            state.projectId,
            snapshot.id,
            snapshot.worktreePath,
            snapshot.branch,
            snapshot.baseCommit,
          );
          const verified = await this.worktrees.assertCompletedWorktree(
            managedPath,
            snapshot.baseCommit,
            snapshot.branch,
          );
          if (verified.head !== result.resultCommit) {
            throw new Error(`stored result commit ${result.resultCommit} no longer matches Worker HEAD ${verified.head}`);
          }
        }
        await this.updateWorker(snapshot.id, (current) => {
          this.assertLifecycleEpoch(lifecycleEpoch);
          if (current.attemptId !== snapshot.attemptId
            || !["working", "pause_requested", "verifying"].includes(current.status)) return current;
          const next = {
            ...current,
            status: result.status,
            progressSummary: `Recovered the durable ${result.status} Worker result after controller restart.`,
            ...(result.resultCommit ? { resultCommit: result.resultCommit } : {}),
          };
          delete next.pendingTerminalStatus;
          delete next.pauseRequestedAt;
          if (result.status === "completed") delete next.blocker;
          else next.blocker = result.summary;
          return next;
        });
        reconciled.push(snapshot.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.updateWorker(snapshot.id, (current) => {
          this.assertLifecycleEpoch(lifecycleEpoch);
          if (current.attemptId !== snapshot.attemptId
            || !["working", "pause_requested", "verifying"].includes(current.status)) return current;
          const next = {
            ...current,
            status: "blocked" as const,
            blocker: `Pending Worker result recovery requires review: ${message}`,
            progressSummary: "Controller restart found a pending result that did not pass durable Git/schema reconciliation.",
          };
          delete next.pendingTerminalStatus;
          delete next.pauseRequestedAt;
          return next;
        });
        reconciled.push(snapshot.id);
      }
    }
    for (const workerId of reconciled) {
      await this.activity.append({ type: "worker_pending_result_reconciled", workerId });
    }
    return reconciled;
  }

  async requestPause(workerId: string): Promise<WorkerRecord> {
    await this.ensureControllerOwnership();
    const lifecycleEpoch = this.captureLifecycleEpoch();
    return this.runWorkerOperation(workerId, () => this.requestPauseUnlocked(workerId, lifecycleEpoch));
  }

  private async requestPauseUnlocked(workerId: string, lifecycleEpoch: number): Promise<WorkerRecord> {
    this.assertLifecycleEpoch(lifecycleEpoch);
    const state = await this.store.read();
    this.assertLifecycleEpoch(lifecycleEpoch);
    const worker = this.requireWorker(state, workerId);
    if (worker.status === "paused") return worker;
    // Completion finalization is already a bounded, read-only verification
    // phase. Let agent_settled finish it; steering a safe-pause message here
    // could leave pause_requested after the session has already gone idle.
    if (worker.status === "verifying") return worker;
    const managed = this.runtimes.get(workerId);
    if (worker.status === "pause_requested") {
      if (!managed) return worker;
      this.assertLifecycleEpoch(lifecycleEpoch);
      await managed.runtime.steer(SAFE_PAUSE_PROMPT);
      this.assertLifecycleEpoch(lifecycleEpoch);
      await this.activity.append({ type: "worker_pause_request_retried", workerId });
      return this.requireWorker(await this.store.read(), workerId);
    }
    if ((worker.status === "queued" || worker.status === "starting") && !managed) {
      const updated = await this.updateWorker(workerId, (current) => {
        this.assertLifecycleEpoch(lifecycleEpoch);
        if (current.status !== "queued" && current.status !== "starting") {
          throw new Error(`Worker ${workerId} cannot be safely paused while ${current.status}`);
        }
        return {
          ...current,
          status: "pause_requested",
          pauseRequestedAt: new Date().toISOString(),
          progressSummary: "Safe pause requested before the Worker session became runnable; startup will not launch it.",
        };
      });
      await this.activity.append({ type: "worker_pause_requested_before_session", workerId });
      return updated;
    }
    if (!isActiveWorkerStatus(worker.status)) throw new Error(`Worker ${workerId} is not active`);
    if (!managed) throw new Error(`Worker ${workerId} has no live runtime; retry after startup recovery`);

    const updated = await this.updateWorker(workerId, (current) => {
      this.assertLifecycleEpoch(lifecycleEpoch);
      return {
        ...assertPauseRequestableWorker(current, workerId),
        status: "pause_requested",
        pauseRequestedAt: new Date().toISOString(),
        progressSummary: "Safe pause requested; waiting for the Worker to reach a safe boundary.",
      };
    });
    this.assertLifecycleEpoch(lifecycleEpoch);
    await managed.runtime.steer(SAFE_PAUSE_PROMPT);
    this.assertLifecycleEpoch(lifecycleEpoch);
    await this.activity.append({ type: "worker_pause_requested", workerId });
    return updated;
  }

  async steer(workerId: string, message: string): Promise<WorkerRecord> {
    await this.ensureControllerOwnership();
    const lifecycleEpoch = this.captureLifecycleEpoch();
    return this.runWorkerOperation(workerId, () => this.steerUnlocked(workerId, message, lifecycleEpoch));
  }

  private async steerUnlocked(workerId: string, message: string, lifecycleEpoch: number): Promise<WorkerRecord> {
    this.assertLifecycleEpoch(lifecycleEpoch);
    if (!message.trim()) throw new Error("steering message must not be empty");
    const worker = this.requireWorker(await this.store.read(), workerId);
    this.assertLifecycleEpoch(lifecycleEpoch);
    if (["pause_requested", "paused", "interrupted", "blocked", "verifying"].includes(worker.status)) {
      const updated = await this.updateWorker(workerId, (current) => {
        this.assertLifecycleEpoch(lifecycleEpoch);
        if (!["pause_requested", "paused", "interrupted", "blocked", "verifying"].includes(current.status)) {
          throw new Error(`Worker ${workerId} cannot queue steering while ${current.status}`);
        }
        return {
          ...current,
          pendingInstructions: [...(current.pendingInstructions ?? []), message.trim()],
        };
      });
      await this.activity.append({ type: "worker_instruction_queued", workerId });
      return updated;
    }
    if (!isActiveWorkerStatus(worker.status)) throw new Error(`Worker ${workerId} cannot be steered while ${worker.status}`);
    const managed = this.requireRuntime(workerId);
    const instruction = message.trim();
    const queued = await this.updateWorker(workerId, (current) => {
      this.assertLifecycleEpoch(lifecycleEpoch);
      if (!isActiveWorkerStatus(current.status)) {
        throw new Error(`Worker ${workerId} cannot be steered while ${current.status}`);
      }
      return {
        ...current,
        pendingInstructions: [...(current.pendingInstructions ?? []), instruction],
      };
    });
    this.assertLifecycleEpoch(lifecycleEpoch);
    await managed.runtime.steer(instruction);
    this.assertLifecycleEpoch(lifecycleEpoch);
    // A late Pi steer may be accepted after the agent loop has already
    // decided that its queue is empty. Keep it in the durable outbox rather
    // than claiming consumption from this turn's eventual settled event.
    // It is therefore at-least-once: recovery may redeliver it, but a crash or
    // terminal mixed batch cannot silently discard it.
    await this.activity.append({ type: "worker_steered", workerId });
    return this.requireWorker(await this.store.read(), workerId);
  }

  async resume(workerId: string, message?: string): Promise<WorkerRecord> {
    await this.ensureControllerOwnership();
    if (this.abortOperations.has(workerId)) {
      throw new Error(`Worker ${workerId} has an emergency abort in progress; wait for it to finish before resuming`);
    }
    const lifecycleEpoch = this.captureLifecycleEpoch();
    const controlRevision = this.currentControlRevision(workerId);
    return this.runWorkerOperation(
      workerId,
      () => this.resumeUnlocked(workerId, message, lifecycleEpoch, controlRevision),
    );
  }

  private async resumeUnlocked(
    workerId: string,
    message: string | undefined,
    lifecycleEpoch: number,
    controlRevision: number,
  ): Promise<WorkerRecord> {
    this.assertLifecycleEpoch(lifecycleEpoch);
    this.assertControlRevision(workerId, controlRevision);
    if (this.abortOperations.has(workerId)) {
      throw new Error(`Worker ${workerId} has an emergency abort in progress; wait for it to finish before resuming`);
    }
    this.assertProjectTrusted();
    const state = await this.store.read();
    this.assertLifecycleEpoch(lifecycleEpoch);
    this.assertControlRevision(workerId, controlRevision);
    if (state.schedulerPaused || state.phase === "paused") {
      throw new Error("intentum is paused; resume the project before resuming a Worker");
    }
    const worker = this.requireWorker(state, workerId);
    if (!["paused", "interrupted", "blocked"].includes(worker.status)) {
      throw new Error(`Worker ${workerId} cannot resume while ${worker.status}`);
    }
    const otherUnfinished = Object.values(state.workers).find(
      (candidate) => candidate.id !== workerId && isUnfinishedWorker(candidate.status),
    );
    if (otherUnfinished) {
      throw new Error(`Phase 2 supports one unfinished Worker; ${otherUnfinished.id} is ${otherUnfinished.status}`);
    }
    let worktreePath: string;
    try {
      if (!worker.worktreePath || !worker.featureId || !worker.branch || !worker.baseCommit) {
        throw new Error(`Worker ${workerId} is missing its preserved worktree, branch, base commit, or feature reference`);
      }
      await assertPathExists(worker.worktreePath, `Worker ${workerId} worktree is missing; inspect preserved Git refs before recovery`);
      worktreePath = await this.worktrees.assertRecoverableWorktree(
        state.projectId,
        workerId,
        worker.worktreePath,
        worker.branch,
        worker.baseCommit,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failUnrecoverableWorker(workerId, message, lifecycleEpoch);
      throw new Error(
        `Worker ${workerId} recovery resources failed identity validation and the single-Worker slot was released: ${message}`,
        { cause: error },
      );
    }
    this.assertLifecycleEpoch(lifecycleEpoch);
    this.assertControlRevision(workerId, controlRevision);
    const contract = await this.contracts.get(worker.featureId, workerId);
    this.assertLifecycleEpoch(lifecycleEpoch);
    const [charter, architecture, currentHead] = await Promise.all([
      this.store.readArtifact("charter"),
      this.store.readArtifact("architecture"),
      this.worktrees.head(worktreePath),
    ]);
    this.assertLifecycleEpoch(lifecycleEpoch);
    let instructions = [...(worker.pendingInstructions ?? [])];
    if (message?.trim()) instructions.push(message.trim());
    const existingManaged = this.runtimes.get(workerId);
    let runtime = existingManaged?.runtime;
    let generation = existingManaged?.generation;
    let recoverySessionCreated = false;
    let prompt: string | undefined;
    let createdRuntime: WorkerRuntime | undefined;
    try {
      if (!runtime) {
        generation = this.nextRuntimeGeneration(workerId);
        const callbacks = this.callbacksFor(workerId, generation);
        const sessionPresent = worker.sessionRef ? await pathExists(worker.sessionRef) : false;
        if (!sessionPresent) {
          recoverySessionCreated = true;
          // The full immutable contract/context packet was read before runtime
          // construction. The final prompt is rendered from the latest durable
          // instruction queue immediately before the state transition.
        }
        if (sessionPresent && worker.sessionRef) {
          try {
            runtime = await this.runtimeFactory.restore({
              workerId,
              worktreePath,
              sessionRef: worker.sessionRef,
              contract,
              callbacks,
            });
          } catch (error) {
            if (!(error instanceof WorkerSessionUnavailableError)) throw error;
            const errorMessage = error instanceof Error ? error.message : String(error);
            await this.activity.append({
              type: "worker_session_restore_failed",
              workerId,
              preservedSessionRef: worker.sessionRef,
              error: errorMessage,
            });
            recoverySessionCreated = true;
            runtime = await this.runtimeFactory.create({
              workerId,
              worktreePath,
              contract,
              callbacks,
            });
          }
        } else {
          runtime = await this.runtimeFactory.create({
            workerId,
            worktreePath,
            contract,
            callbacks,
          });
        }
        createdRuntime = runtime;
        this.assertLifecycleEpoch(lifecycleEpoch);
        this.assertControlRevision(workerId, controlRevision);
        await this.attachRuntime(workerId, runtime, generation, lifecycleEpoch);
        if (recoverySessionCreated) {
          await this.activity.append({
            type: "worker_recovery_session_created",
            workerId,
            priorSessionRef: worker.sessionRef,
            newSessionRef: runtime.sessionRef,
          });
        }
      }
      if (generation === undefined) throw new Error(`Worker ${workerId} runtime generation is missing`);

      // Terminal Worker tools publish their resumable state only from the
      // serialized agent_settled handler. Therefore a paused/blocked record is
      // already idle here; the turn token makes any delayed old event harmless.
      this.assertCurrentGeneration(workerId, generation);
      const latestState = await this.store.read();
      this.assertLifecycleEpoch(lifecycleEpoch);
      this.assertControlRevision(workerId, controlRevision);
      assertProjectCanStartWorker(latestState);
      const latestWorker = this.requireWorker(latestState, workerId);
      assertResumableWorker(latestWorker, workerId);
      const otherLatestUnfinished = Object.values(latestState.workers).find(
        (candidate) => candidate.id !== workerId && isUnfinishedWorker(candidate.status),
      );
      if (otherLatestUnfinished) {
        throw new Error(`Phase 2 supports one unfinished Worker; ${otherLatestUnfinished.id} is ${otherLatestUnfinished.status}`);
      }
      instructions = [...(latestWorker.pendingInstructions ?? [])];
      if (message?.trim()) instructions.push(message.trim());

      const updated = await this.updateWorker(workerId, (current, currentState) => {
        this.assertLifecycleEpoch(lifecycleEpoch);
        this.assertControlRevision(workerId, controlRevision);
        assertProjectCanStartWorker(currentState);
        assertResumableWorker(current, workerId);
        const next = {
          ...current,
          status: "working" as const,
          attemptId: randomUUID(),
          ...(runtime?.sessionRef ? { sessionRef: runtime.sessionRef } : {}),
          progressSummary:
            recoverySessionCreated
              ? "Resuming in a new recovery session because the prior Pi session was missing or unreadable."
              : "Resuming the preserved Pi Worker session.",
          ...(instructions.length > 0 ? { pendingInstructions: [...instructions] } : {}),
        };
        delete next.blocker;
        delete next.pauseRequestedAt;
        if (instructions.length === 0) delete next.pendingInstructions;
        delete next.resultCommit;
        return next;
      });
      this.assertLifecycleEpoch(lifecycleEpoch);
      this.assertControlRevision(workerId, controlRevision);
      prompt = renderResumePrompt(
        contract,
        latestWorker.baseCommit ?? worker.baseCommit!,
        currentHead,
        charter,
        architecture,
        instructions,
        recoverySessionCreated,
      );
      this.launchPrompt(workerId, runtime, prompt, generation, updated.attemptId!, instructions);
      await this.activity.append({ type: "worker_resumed", workerId, sessionRef: runtime.sessionRef });
      return updated;
    } catch (error) {
      if (!existingManaged && generation !== undefined) {
        this.invalidateRuntimeGeneration(workerId, generation);
        const attached = this.runtimes.get(workerId);
        if (attached?.generation === generation) {
          await this.disposeRuntime(workerId, generation).catch(() => undefined);
        } else if (createdRuntime) {
          await Promise.resolve(createdRuntime.dispose()).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  async abort(workerId: string, reason: string): Promise<WorkerRecord> {
    await this.ensureControllerOwnership();
    if (!reason.trim()) throw new Error("abort reason must not be empty");
    const inFlight = this.abortOperations.get(workerId);
    if (inFlight) return inFlight;
    const lifecycleEpoch = this.captureLifecycleEpoch();
    // Emergency abort is deliberately out-of-band from the normal per-Worker
    // control queue. It must preempt a resume waiting for a streaming Pi turn
    // to become idle, rather than waiting behind that resume indefinitely.
    this.bumpControlRevision(workerId);
    const operation = this.abortUnlocked(workerId, reason, lifecycleEpoch);
    this.abortOperations.set(workerId, operation);
    void operation.finally(() => {
      if (this.abortOperations.get(workerId) === operation) this.abortOperations.delete(workerId);
    }).catch(() => undefined);
    return operation;
  }

  private async abortUnlocked(workerId: string, reason: string, lifecycleEpoch: number): Promise<WorkerRecord> {
    this.assertLifecycleEpoch(lifecycleEpoch);
    if (!reason.trim()) throw new Error("abort reason must not be empty");
    const before = this.requireWorker(await this.store.read(), workerId);
    this.assertLifecycleEpoch(lifecycleEpoch);
    assertAbortableWorker(before, workerId);
    const managed = this.runtimes.get(workerId);
    if (!managed && isUnfinishedWorker(before.status)) {
      const interrupted = await this.updateWorker(workerId, (current) => {
        this.assertLifecycleEpoch(lifecycleEpoch);
        if (!isUnfinishedWorker(current.status)) {
          throw new Error(`Worker ${workerId} cannot be aborted before session startup while ${current.status}`);
        }
        const next = {
          ...current,
          status: "interrupted" as const,
          blocker: `Emergency abort before session startup: ${reason.trim()}`,
          progressSummary: "Emergency abort stopped Worker startup before a live session was available; existing artifacts remain preserved.",
        };
        delete next.pendingTerminalStatus;
        delete next.pauseRequestedAt;
        return next;
      });
      await this.activity.append({ type: "worker_aborted_before_session", workerId, reason: reason.trim() });
      return interrupted;
    }
    if (!managed) throw new Error(`Worker ${workerId} has no live runtime; use resume to restore its Pi session`);
    const worker = await this.updateWorker(workerId, (current) => {
      this.assertLifecycleEpoch(lifecycleEpoch);
      const next = {
        ...assertAbortableWorker(current, workerId),
        status: "interrupted" as const,
        blocker: `Emergency abort: ${reason.trim()}`,
        progressSummary: "Emergency abort requested; the session, worktree, branch, and files remain preserved.",
      };
      delete next.pendingTerminalStatus;
      delete next.pauseRequestedAt;
      return next;
    });
    this.assertLifecycleEpoch(lifecycleEpoch);
    // Revoke all tool callbacks immediately after the interrupted state is
    // durable. session.abort() can wait for a currently executing tool, so
    // deferring generation invalidation would let completion race past the
    // operator's emergency stop.
    this.invalidateRuntimeGeneration(workerId, managed.generation);
    try {
      await managed.runtime.abort();
      this.assertLifecycleEpoch(lifecycleEpoch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.disposeRuntime(workerId, managed.generation).catch(() => undefined);
      await this.activity.append({ type: "worker_abort_runtime_error", workerId, error: message });
      throw new Error(`Worker ${workerId} was marked interrupted and its runtime was forcibly disposed after Pi reported an abort error: ${message}`, { cause: error });
    }
    await this.disposeRuntime(workerId, managed.generation).catch(() => undefined);
    await this.activity.append({ type: "worker_aborted", workerId, reason: reason.trim() });
    return worker;
  }

  async integrateWorker(workerId: string): Promise<WorkerRecord> {
    await this.ensureControllerOwnership();
    const lifecycleEpoch = this.captureLifecycleEpoch();
    const controller = new AbortController();
    const promise = this.integrateWorkerUnlocked(workerId, lifecycleEpoch, controller.signal);
    const managed: ManagedIntegration = { controller, promise };
    this.integrationOperations.add(managed);
    try {
      return await promise;
    } finally {
      this.integrationOperations.delete(managed);
    }
  }

  private async integrateWorkerUnlocked(
    workerId: string,
    lifecycleEpoch: number,
    signal: AbortSignal,
  ): Promise<WorkerRecord> {
    signal.throwIfAborted();
    this.assertLifecycleEpoch(lifecycleEpoch);
    const state = await this.store.read();
    signal.throwIfAborted();
    this.assertLifecycleEpoch(lifecycleEpoch);
    const worker = this.requireWorker(state, workerId);
    if (worker.status !== "completed") throw new Error(`Worker ${workerId} is not completed`);
    if (!worker.featureId || !worker.resultCommit || !worker.branch || !worker.targetBranch || !worker.baseCommit) {
      throw new Error(`Worker ${workerId} is missing integration metadata`);
    }
    const expectedAttemptId = worker.attemptId;
    const expectedResultCommit = worker.resultCommit;
    const expectedBranch = `intentum/${worker.featureId}/${worker.id}`;
    if (worker.branch !== expectedBranch) throw new Error(`Worker ${workerId} has unexpected branch metadata: ${worker.branch}`);
    try {
      if (!worker.worktreePath) throw new Error(`Worker ${workerId} is missing its preserved worktree`);
      const worktreePath = await this.worktrees.assertRecoverableWorktree(
        state.projectId,
        workerId,
        worker.worktreePath,
        worker.branch,
        worker.baseCommit,
        signal,
      );
      const verified = await this.worktrees.assertCompletedWorktree(
        worktreePath,
        worker.baseCommit,
        worker.branch,
        signal,
      );
      if (verified.head !== worker.resultCommit) {
        throw new Error(`Worker ${workerId} worktree HEAD moved after completion; integration stopped`);
      }
      await this.integration.integrate({
        workerId,
        resultCommit: worker.resultCommit,
        workerBranch: worker.branch,
        targetBranch: worker.targetBranch,
        expectedBaseCommit: worker.baseCommit,
      }, signal);
      signal.throwIfAborted();
      this.assertLifecycleEpoch(lifecycleEpoch);
    } catch (error) {
      if (signal.aborted || !this.isLifecycleEpochCurrent(lifecycleEpoch)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const conflict = error instanceof IntegrationConflictError;
      await this.updateWorker(workerId, (current) => {
        this.assertLifecycleEpoch(lifecycleEpoch);
        if (current.status !== "completed"
          || current.attemptId !== expectedAttemptId
          || current.resultCommit !== expectedResultCommit) return current;
        return {
          ...current,
          status: conflict ? "blocked" : current.status,
          blocker: message,
          progressSummary: conflict
            ? "Integration conflict stopped the merge without discarding the Worker result or worktree."
            : "Integration precondition was not met; the completed result remains retryable.",
        };
      });
      await this.activity.append({
        type: conflict ? "worker_integration_blocked" : "worker_integration_deferred",
        workerId,
        error: message,
      });
      throw error;
    }
    const updated = await this.updateWorker(workerId, (current) => {
      this.assertLifecycleEpoch(lifecycleEpoch);
      if (current.status === "integrated"
        && current.attemptId === expectedAttemptId
        && current.resultCommit === expectedResultCommit) return current;
      if (current.status !== "completed"
        || current.attemptId !== expectedAttemptId
        || current.resultCommit !== expectedResultCommit) {
        throw new Error(`Worker ${workerId} left completed state before integration could be recorded`);
      }
      const next = {
        ...current,
        status: "integrated" as const,
        progressSummary: "Worker result merged into the recorded target branch.",
      };
      delete next.pauseRequestedAt;
      delete next.blocker;
      return next;
    });
    await this.activity.append({ type: "worker_integrated", workerId, resultCommit: worker.resultCommit });
    return updated;
  }

  async pauseActive(): Promise<void> {
    await this.ensureControllerOwnership();
    const state = await this.store.read();
    for (const worker of Object.values(state.workers)) {
      if (isActiveWorkerStatus(worker.status) && this.runtimes.has(worker.id)) {
        await this.requestPause(worker.id);
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifecycleEpoch += 1;
    this.lifecycleAbortController.abort(new Error("Intentum Worker manager disposed"));
    const creates = [...this.createOperations];
    const integrations = [...this.integrationOperations];
    for (const operation of integrations) operation.controller.abort();
    this.createTail = Promise.resolve();
    this.workerOperationTails.clear();
    this.abortOperations.clear();
    for (const [workerId, generation] of this.runtimeGenerations) {
      this.runtimeGenerations.set(workerId, generation + 1);
      this.bumpControlRevision(workerId);
    }
    await Promise.allSettled(creates);
    await Promise.allSettled(integrations.map((operation) => operation.promise));
    const workerIds = [...this.runtimes.keys()];
    await Promise.all(workerIds.map((workerId) => this.disposeRuntime(workerId)));
  }

  private callbacksFor(workerId: string, generation: number): WorkerCallbacks {
    return {
      commit: (input, signal) => this.onCommit(workerId, generation, input, signal),
      progress: (input) => this.onProgress(workerId, generation, input),
      escalate: (input) => this.onEscalation(workerId, generation, input),
      complete: (input, signal) => this.onComplete(workerId, generation, input, signal),
    };
  }

  private async onCommit(
    workerId: string,
    generation: number,
    input: WorkerCommitInput,
    signal?: AbortSignal,
  ): Promise<WorkerCommitResult> {
    signal?.throwIfAborted();
    this.assertCurrentGeneration(workerId, generation);
    if (!input.message.trim() || input.message.length > 200) {
      throw new Error("Worker commit message must contain 1 to 200 characters");
    }
    const state = await this.store.read();
    const worker = this.requireWorker(state, workerId);
    if (!["working", "pause_requested"].includes(worker.status)) {
      throw new Error(`Worker ${workerId} cannot commit while ${worker.status}`);
    }
    if (!worker.worktreePath || !worker.branch || !worker.baseCommit) {
      throw new Error(`Worker ${workerId} has no worktree metadata for a commit`);
    }
    const result = await this.worktrees.commitChanges(
      state.projectId,
      workerId,
      worker.worktreePath,
      worker.branch,
      worker.baseCommit,
      input.message,
      signal,
    );
    signal?.throwIfAborted();
    this.assertCurrentGeneration(workerId, generation);
    await this.updateWorker(workerId, (current) => {
      this.assertCurrentGeneration(workerId, generation);
      if (!["working", "pause_requested"].includes(current.status)) {
        throw new Error(`Worker ${workerId} left an active state while its commit was being created`);
      }
      return {
        ...current,
        progressSummary: `Worker commit ${result.commit.slice(0, 12)} created with ${result.files.length} changed file(s).`,
      };
    });
    await this.activity.append({ type: "worker_commit_created", workerId, commit: result.commit, files: result.files });
    return result;
  }

  private async onProgress(workerId: string, generation: number, input: WorkerProgressInput): Promise<void> {
    this.assertCurrentGeneration(workerId, generation);
    if (!input.summary.trim()) throw new Error("progress summary must not be empty");
    if (input.summary.length > 2_000) throw new Error("progress summary must be 2,000 characters or fewer");
    const worker = await this.updateWorker(workerId, (current) => {
      this.assertCurrentGeneration(workerId, generation);
      if (!["working", "pause_requested"].includes(current.status)) {
        throw new Error(`Worker ${workerId} cannot report progress while ${current.status}`);
      }
      if (input.state === "paused" && current.status !== "pause_requested") {
        throw new Error(`Worker ${workerId} can acknowledge paused only after a safe-pause request`);
      }
      const next: WorkerRecord = input.state === "paused"
        ? {
          ...current,
          status: "verifying",
          pendingTerminalStatus: "paused",
          progressSummary: input.summary.trim(),
        }
        : {
          ...current,
          status: current.status === "pause_requested" ? "pause_requested" : "working",
          progressSummary: input.summary.trim(),
        };
      return next;
    });
    await this.activity.append({ type: "worker_progress", workerId, status: worker.status, summary: input.summary.trim() });
  }

  private async onEscalation(workerId: string, generation: number, input: WorkerEscalationInput): Promise<void> {
    this.assertCurrentGeneration(workerId, generation);
    if (!input.summary.trim()) throw new Error("escalation summary must not be empty");
    if (input.summary.length > 2_000) throw new Error("escalation summary must be 2,000 characters or fewer");
    await this.updateWorker(workerId, (current) => {
      this.assertCurrentGeneration(workerId, generation);
      assertCallbackActive(current, workerId, "escalate");
      return {
        ...current,
        status: "verifying",
        pendingTerminalStatus: "blocked",
        blocker: `${input.kind}: ${input.summary.trim()}`,
        progressSummary: "Worker escalation received; waiting for the Pi session to settle at the safe boundary.",
      };
    });
    await this.activity.append({ type: "worker_escalated", workerId, kind: input.kind, summary: input.summary.trim() });
  }

  private async onComplete(
    workerId: string,
    generation: number,
    input: WorkerResultInput,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.assertCurrentGeneration(workerId, generation);
    assertWorkerResultInput(input);
    const state = await this.store.read();
    const worker = this.requireWorker(state, workerId);
    assertCompletionActive(worker, workerId);
    let resultCommit: string | undefined;
    let actualFiles = input.filesChanged;
    const remainingRisks = [...input.remainingRisks];

    if (input.status === "completed") {
      if (!worker.worktreePath || !worker.baseCommit || !worker.branch) {
        throw new Error(`Worker ${workerId} has no worktree metadata`);
      }
      const worktreePath = await this.worktrees.assertRecoverableWorktree(
        state.projectId,
        workerId,
        worker.worktreePath,
        worker.branch,
        worker.baseCommit,
        signal,
      );
      const verified = await this.worktrees.assertCompletedWorktree(
        worktreePath,
        worker.baseCommit,
        worker.branch,
        signal,
      );
      resultCommit = verified.head;
      actualFiles = verified.files;
      if (JSON.stringify([...input.filesChanged].sort()) !== JSON.stringify([...verified.files].sort())) {
        remainingRisks.push("Worker-reported filesChanged differed from the controller's Git diff; Git-derived paths were stored.");
      }
    }

    const result: WorkerResult = {
      workId: workerId,
      attemptId: worker.attemptId ?? (() => { throw new Error(`Worker ${workerId} has no attempt identity`); })(),
      status: input.status,
      summary: input.summary,
      userVisibleChanges: structuredClone(input.userVisibleChanges),
      filesChanged: actualFiles,
      testsRun: structuredClone(input.testsRun),
      architectureConcerns: structuredClone(input.architectureConcerns),
      remainingRisks: structuredClone(remainingRisks),
      suggestedFollowUps: structuredClone(input.suggestedFollowUps),
      ...(resultCommit ? { resultCommit } : {}),
      recordedAt: new Date().toISOString(),
    };
    assertWorkerResult(result);
    signal?.throwIfAborted();
    this.assertCurrentGeneration(workerId, generation);
    await this.writeStoredResult(result);
    try {
      signal?.throwIfAborted();
      await this.updateWorker(workerId, (current) => {
        this.assertCurrentGeneration(workerId, generation);
        const next = {
          ...assertCompletionActive(current, workerId),
          status: "verifying" as const,
          pendingTerminalStatus: input.status,
          progressSummary: "Structured result received; waiting for the Pi session to settle before publishing its terminal state.",
          ...(resultCommit ? { resultCommit } : {}),
        };
        if (input.status === "blocked" || input.status === "failed") next.blocker = input.summary.trim();
        else delete next.blocker;
        delete next.pauseRequestedAt;
        return next;
      });
    } catch (error) {
      const stored = await this.readStoredResult(workerId).catch(() => undefined);
      if (stored?.attemptId === result.attemptId) {
        await this.removeStoredResultIfAttempt(workerId, result.attemptId).catch(() => undefined);
      }
      throw error;
    }
    await this.activity.append({
      type: input.status === "completed" ? "worker_completion_received" : "worker_completed",
      workerId,
      status: input.status,
      resultCommit,
    });
  }

  private async attachRuntime(
    workerId: string,
    runtime: WorkerRuntime,
    generation: number,
    lifecycleEpoch: number,
  ): Promise<void> {
    if (!this.isLifecycleEpochCurrent(lifecycleEpoch) || !this.isCurrentGeneration(workerId, generation)) {
      await runtime.dispose();
      throw new Error("Intentum Worker manager lifecycle changed before the session could attach");
    }
    const previous = this.runtimes.get(workerId);
    previous?.unsubscribe();
    if (previous && previous.runtime !== runtime) await previous.runtime.dispose();
    const managed: ManagedRuntime = { runtime, unsubscribe: () => undefined, generation, turn: 0 };
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === "session_ref_changed" && event.sessionRef && this.isCurrentGeneration(workerId, generation)) {
        void this.updateWorker(workerId, (current) => {
          this.assertCurrentGeneration(workerId, generation);
          return { ...current, sessionRef: event.sessionRef };
        }).catch(() => undefined);
      }
      if (event.type === "turn_failed" && this.isCurrentGeneration(workerId, generation)) {
        managed.turnFailure = { turn: managed.turn, error: event.error };
      }
      if (event.type === "settled") {
        const settledTurn = managed.turn;
        void this.runWorkerOperation(
          workerId,
          async () => {
            await this.acknowledgeDeliveredInstructions(workerId, generation, settledTurn).catch(() => undefined);
            const tracked = managed.promptOutcome;
            const outcome = tracked?.turn === settledTurn ? await tracked.promise : { ok: true as const };
            const runtimeFailure = managed.turnFailure?.turn === settledTurn
              ? managed.turnFailure.error
              : undefined;
            if (runtimeFailure) {
              await this.handlePromptRejected(workerId, new Error(runtimeFailure), generation, settledTurn);
              return;
            }
            if (!outcome.ok) {
              await this.handlePromptRejected(workerId, outcome.error, generation, settledTurn);
              return;
            }
            await this.onSettled(workerId, generation, settledTurn);
          },
        ).catch(() => undefined);
      }
    });
    managed.unsubscribe = unsubscribe;
    this.runtimes.set(workerId, managed);
  }

  private launchPrompt(
    workerId: string,
    runtime: WorkerRuntime,
    prompt: string,
    generation: number,
    attemptId: string,
    instructions: string[],
  ): void {
    const managed = this.runtimes.get(workerId);
    if (!managed || managed.runtime !== runtime || managed.generation !== generation) {
      throw new Error(`Worker ${workerId} runtime changed before its prompt could start`);
    }
    const turn = ++managed.turn;
    delete managed.turnFailure;
    managed.promptDelivery = { turn, attemptId, instructions: [...instructions] };
    const outcome = runtime.prompt(prompt).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    managed.promptOutcome = { turn, promise: outcome };
    // Pi normally emits agent_settled before prompt() rejects. The settled
    // handler above waits for this outcome so the provider/tool-loop failure
    // wins over the generic "settled without completion" diagnosis. This
    // fallback also covers runtimes that reject without emitting settled.
    void outcome.then((result) => {
      if (!result.ok) {
        void this.runWorkerOperation(
          workerId,
          () => this.handlePromptRejected(workerId, result.error, generation, turn),
        ).catch(() => undefined);
      }
    });
  }

  private async acknowledgeDeliveredInstructions(
    workerId: string,
    generation: number,
    turn: number,
  ): Promise<void> {
    const managed = this.runtimes.get(workerId);
    const delivery = managed?.promptDelivery;
    if (!delivery || delivery.turn !== turn || delivery.instructions.length === 0) return;
    await this.updateWorker(workerId, (current) => {
      this.assertCurrentRuntimeTurn(workerId, generation, turn);
      if (current.attemptId !== delivery.attemptId || !current.pendingInstructions) return current;
      const isExactPrefix = delivery.instructions.every(
        (instruction, index) => current.pendingInstructions?.[index] === instruction,
      );
      if (!isExactPrefix) return current;
      const remaining = current.pendingInstructions.slice(delivery.instructions.length);
      const next = { ...current };
      if (remaining.length > 0) next.pendingInstructions = remaining;
      else delete next.pendingInstructions;
      return next;
    });
  }

  private async onSettled(workerId: string, generation: number, turn: number): Promise<void> {
    if (!this.isCurrentRuntimeTurn(workerId, generation, turn)) return;
    const worker = this.requireWorker(await this.store.read(), workerId);
    if (worker.status === "verifying") {
      const pendingStatus = worker.pendingTerminalStatus;
      if (!pendingStatus) {
        await this.updateWorker(workerId, (current) => ({
          ...current,
          status: "blocked",
          blocker: "Worker entered final verification without a pending terminal disposition.",
        }));
        return;
      }
      if (pendingStatus !== "completed") {
        await this.updateWorker(workerId, (current) => {
          this.assertCurrentRuntimeTurn(workerId, generation, turn);
          if (current.status !== "verifying" || current.pendingTerminalStatus !== pendingStatus) {
            throw new Error(`Worker ${workerId} changed while its terminal state was settling`);
          }
          const next = {
            ...current,
            status: pendingStatus,
            progressSummary: pendingStatus === "paused"
              ? current.progressSummary ?? "Worker paused at a safe boundary."
              : current.progressSummary ?? `Worker reported ${pendingStatus}.`,
          };
          delete next.pendingTerminalStatus;
          if (pendingStatus === "paused") {
            delete next.pauseRequestedAt;
            delete next.blocker;
          }
          return next;
        });
        await this.activity.append({ type: "worker_terminal_state_published", workerId, status: pendingStatus });
        if (pendingStatus === "failed") await this.retireRuntime(workerId, generation);
        return;
      }
      try {
        if (!worker.worktreePath || !worker.baseCommit || !worker.branch || !worker.resultCommit) {
          throw new Error(`Worker ${workerId} is missing final verification metadata`);
        }
        const state = await this.store.read();
        const worktreePath = await this.worktrees.assertRecoverableWorktree(
          state.projectId,
          workerId,
          worker.worktreePath,
          worker.branch,
          worker.baseCommit,
        );
        const verified = await this.worktrees.assertCompletedWorktree(
          worktreePath,
          worker.baseCommit,
          worker.branch,
        );
        if (verified.head !== worker.resultCommit) {
          throw new Error(`Worker ${workerId} worktree HEAD moved after intentum_complete`);
        }
        await this.updateWorker(workerId, (current) => {
          this.assertCurrentRuntimeTurn(workerId, generation, turn);
          if (current.status !== "verifying" || current.resultCommit !== worker.resultCommit) {
            throw new Error(`Worker ${workerId} changed while final verification was running`);
          }
          const next = {
            ...current,
            status: "completed" as const,
            progressSummary: "Worker result passed final Git verification after the Pi session settled.",
          };
          delete next.pendingTerminalStatus;
          delete next.blocker;
          return next;
        });
        await this.activity.append({
          type: "worker_final_verification_completed",
          workerId,
          resultCommit: worker.resultCommit,
        });
        await this.retireRuntime(workerId, generation);
      } catch (error) {
        if (!this.isCurrentRuntimeTurn(workerId, generation, turn)) return;
        const message = error instanceof Error ? error.message : String(error);
        await this.updateWorker(workerId, (current) => {
          this.assertCurrentRuntimeTurn(workerId, generation, turn);
          if (current.status !== "verifying") return current;
          const next = {
            ...current,
            status: "blocked" as const,
            blocker: `Final Git verification failed after the Pi session settled: ${message}`,
            progressSummary: "Completion was not accepted because the settled worktree no longer matched the verified result.",
          };
          delete next.pendingTerminalStatus;
          return next;
        });
        await this.activity.append({ type: "worker_final_verification_failed", workerId, error: message });
      }
      return;
    }
    if (worker.status === "working" || worker.status === "pause_requested") {
      await this.updateWorker(workerId, (current) => {
        this.assertCurrentRuntimeTurn(workerId, generation, turn);
        if (current.status !== "working" && current.status !== "pause_requested") {
          throw new Error(`Worker ${workerId} settled after leaving an active state`);
        }
        return {
          ...current,
          status: "blocked" as const,
          blocker:
            current.status === "pause_requested"
              ? "Worker session settled without acknowledging the safe pause via intentum_progress."
              : "Worker session settled without submitting intentum_complete.",
        };
      });
    }
  }

  private async handlePromptRejected(
    workerId: string,
    error: unknown,
    generation: number,
    turn: number,
  ): Promise<void> {
    if (!this.isCurrentRuntimeTurn(workerId, generation, turn)) return;
    const worker = this.requireWorker(await this.store.read(), workerId);
    if (worker.status === "verifying") {
      // A terminal tool is first-wins. Pi can continue a mixed tool batch and
      // then fail a later provider request; the settled Git/result evidence is
      // still authoritative for the already-recorded terminal disposition.
      await this.activity.append({
        type: "worker_post_terminal_prompt_failed",
        workerId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.onSettled(workerId, generation, turn);
      return;
    }
    if (["paused", "blocked", "completed", "failed", "interrupted", "integrated"].includes(worker.status)) return;
    await this.markFailed(workerId, error, generation, turn);
  }

  private async markFailed(workerId: string, error: unknown, generation?: number, turn?: number): Promise<void> {
    if (generation !== undefined && !this.isCurrentGeneration(workerId, generation)) return;
    if (generation !== undefined && turn !== undefined && !this.isCurrentRuntimeTurn(workerId, generation, turn)) return;
    const message = error instanceof Error ? error.message : String(error);
    const updated = await this.updateWorker(workerId, (current) => {
      if (generation !== undefined) this.assertCurrentGeneration(workerId, generation);
      if (generation !== undefined && turn !== undefined) this.assertCurrentRuntimeTurn(workerId, generation, turn);
      if (!["queued", "starting", "working", "pause_requested", "verifying"].includes(current.status)) {
        throw new Error(`Worker ${workerId} runtime failed after leaving an active state`);
      }
      const next = {
        ...current,
        status: "failed" as const,
        blocker: message,
        progressSummary: "Worker runtime failed; preserved artifacts require inspection.",
      };
      delete next.pendingTerminalStatus;
      return next;
    }).catch(() => undefined);
    if (updated?.status === "failed" && updated.blocker === message) {
      await this.activity.append({ type: "worker_failed", workerId, error: message }).catch(() => undefined);
      if (generation !== undefined && turn !== undefined) {
        await this.retireRuntime(workerId, generation).catch(() => undefined);
      }
    }
  }

  private async failUnrecoverableWorker(workerId: string, reason: string, lifecycleEpoch: number): Promise<void> {
    await this.updateWorker(workerId, (current) => {
      this.assertLifecycleEpoch(lifecycleEpoch);
      assertResumableWorker(current, workerId);
      return {
        ...current,
        status: "failed",
        blocker: `Recovery resource validation failed: ${reason}`,
        progressSummary: "Recovery stopped because the preserved worktree identity was invalid; the single-Worker slot was released.",
      };
    });
    await this.activity.append({ type: "worker_recovery_failed", workerId, error: reason });
  }

  private requireRuntime(workerId: string): ManagedRuntime {
    const runtime = this.runtimes.get(workerId);
    if (!runtime) throw new Error(`Worker ${workerId} has no live runtime; use resume to restore its Pi session`);
    return runtime;
  }

  private nextRuntimeGeneration(workerId: string): number {
    const generation = (this.runtimeGenerations.get(workerId) ?? 0) + 1;
    this.runtimeGenerations.set(workerId, generation);
    return generation;
  }

  private isCurrentGeneration(workerId: string, generation: number): boolean {
    return !this.disposed && this.runtimeGenerations.get(workerId) === generation;
  }

  private assertCurrentGeneration(workerId: string, generation: number): void {
    if (!this.isCurrentGeneration(workerId, generation)) {
      throw new Error(`stale or disposed Pi session callback ignored for Worker ${workerId}`);
    }
  }

  private currentControlRevision(workerId: string): number {
    return this.controlRevisions.get(workerId) ?? 0;
  }

  private bumpControlRevision(workerId: string): number {
    const revision = this.currentControlRevision(workerId) + 1;
    this.controlRevisions.set(workerId, revision);
    return revision;
  }

  private assertControlRevision(workerId: string, expected: number): void {
    if (this.currentControlRevision(workerId) !== expected) {
      throw new Error(`Worker ${workerId} resume was superseded by an emergency abort`);
    }
  }

  private isCurrentRuntimeTurn(workerId: string, generation: number, turn: number): boolean {
    const managed = this.runtimes.get(workerId);
    return this.isCurrentGeneration(workerId, generation)
      && managed?.generation === generation
      && managed.turn === turn;
  }

  private assertCurrentRuntimeTurn(workerId: string, generation: number, turn: number): void {
    if (!this.isCurrentRuntimeTurn(workerId, generation, turn)) {
      throw new Error(`stale Pi session turn callback ignored for Worker ${workerId}`);
    }
  }

  private invalidateRuntimeGeneration(workerId: string, expectedGeneration: number): void {
    if (this.runtimeGenerations.get(workerId) === expectedGeneration) {
      this.runtimeGenerations.set(workerId, expectedGeneration + 1);
    }
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("Intentum Worker manager is disposed");
  }

  private assertProjectTrusted(): void {
    if (!this.projectTrusted) {
      throw new Error("Pi has not trusted this project; Worker bash/write execution was not started");
    }
  }

  private captureLifecycleEpoch(): number {
    this.assertAvailable();
    return this.lifecycleEpoch;
  }

  private isLifecycleEpochCurrent(epoch: number): boolean {
    return !this.disposed && this.lifecycleEpoch === epoch;
  }

  private assertLifecycleEpoch(epoch: number): void {
    if (!this.isLifecycleEpochCurrent(epoch)) {
      throw new Error("Intentum Worker manager lifecycle changed while an operation was in flight");
    }
  }

  private async disposeRuntime(workerId: string, expectedGeneration?: number): Promise<void> {
    const managed = this.runtimes.get(workerId);
    if (!managed) return;
    if (expectedGeneration !== undefined && managed.generation !== expectedGeneration) return;
    this.runtimes.delete(workerId);
    managed.unsubscribe();
    await managed.runtime.dispose();
  }

  private async retireRuntime(workerId: string, generation: number): Promise<void> {
    this.invalidateRuntimeGeneration(workerId, generation);
    await this.disposeRuntime(workerId, generation);
  }

  private runWorkerOperation<T>(workerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workerOperationTails.get(workerId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.workerOperationTails.set(workerId, tail);
    void tail.then(() => {
      if (this.workerOperationTails.get(workerId) === tail) this.workerOperationTails.delete(workerId);
    });
    return result;
  }

  private requireWorker(state: ProjectState, workerId: string): WorkerRecord {
    const worker = state.workers[workerId];
    if (!worker) throw new Error(`unknown intentum worker: ${workerId}`);
    return structuredClone(worker);
  }

  private async updateWorker(
    workerId: string,
    updater: (worker: WorkerRecord, state: ProjectState) => WorkerRecord,
    activeFeatureId?: string,
  ): Promise<WorkerRecord> {
    const state = await this.store.update((current) => {
      const existing = current.workers[workerId];
      if (!existing && !activeFeatureId) throw new Error(`unknown intentum worker: ${workerId}`);
      if (existing && activeFeatureId) throw new Error(`Worker record already exists: ${workerId}`);
      const updated = updater(existing ?? ({ id: workerId } as WorkerRecord), current);
      updated.updatedAt = new Date().toISOString();
      return {
        ...current,
        ...(activeFeatureId ? { activeFeatureId } : {}),
        workers: { ...current.workers, [workerId]: updated },
      };
    });
    try {
      this.onChanged(state);
    } catch {
      // UI/observer updates are non-canonical and must never gate Worker
      // lifecycle actions after state has already been persisted.
    }
    return this.requireWorker(state, workerId);
  }

  private resultPath(workerId: string): string {
    assertSafeId(workerId, "Worker id");
    return join(this.store.projectRoot, ".intentum", "runs", workerId, "result.json");
  }

  private async readStoredResult(workerId: string): Promise<WorkerResult | undefined> {
    try {
      const resultPath = await assertRepositoryOwnedPath(this.store.projectRoot, this.resultPath(workerId));
      const parsed: unknown = JSON.parse(await readFile(resultPath, "utf8"));
      assertWorkerResult(parsed);
      if (parsed.workId !== workerId) {
        throw new Error(`stored Worker result belongs to ${parsed.workId}, expected ${workerId}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeStoredResult(result: WorkerResult): Promise<void> {
    const workerDir = join(this.store.projectRoot, ".intentum", "runs", result.workId);
    await ensureRepositoryOwnedDirectory(this.store.projectRoot, workerDir);
    const resultPath = await assertRepositoryOwnedPath(this.store.projectRoot, join(workerDir, "result.json"));
    const lockPath = await assertRepositoryOwnedPath(this.store.projectRoot, `${resultPath}.lock`);
    await withFileLock(lockPath, () => writeJsonAtomic(resultPath, result));
  }

  private async removeStoredResultIfAttempt(workerId: string, attemptId: string): Promise<void> {
    const resultPath = await assertRepositoryOwnedPath(this.store.projectRoot, this.resultPath(workerId));
    const lockPath = await assertRepositoryOwnedPath(this.store.projectRoot, `${resultPath}.lock`);
    await withFileLock(lockPath, async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(resultPath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      assertWorkerResult(parsed);
      if (parsed.workId === workerId && parsed.attemptId === attemptId) {
        await rm(resultPath, { force: true });
      }
    });
  }

  private async publishRecoveredTerminal(
    workerId: string,
    status: "blocked" | "failed",
    summary: string,
    lifecycleEpoch: number,
    expectedAttemptId: string | undefined,
  ): Promise<void> {
    await this.updateWorker(workerId, (current) => {
      this.assertLifecycleEpoch(lifecycleEpoch);
      if (current.attemptId !== expectedAttemptId || current.status !== "verifying") return current;
      const next = {
        ...current,
        status,
        blocker: summary,
        progressSummary: `Recovered the Worker ${status} disposition after controller restart.`,
      };
      delete next.pendingTerminalStatus;
      delete next.pauseRequestedAt;
      return next;
    });
  }
}

function renderContractPrompt(
  contract: WorkContract,
  baseCommit: string,
  charter: string,
  architecture: string,
): string {
  return `Implement this outcome-based WorkContract autonomously.

WORK ID: ${contract.id}
FEATURE: ${contract.featureId}
TITLE: ${contract.title}
OBJECTIVE: ${contract.objective}
WHY: ${contract.why}
USER-VISIBLE RESULT: ${contract.userVisibleResult}

IN SCOPE:
${asBullets(contract.scope.inScope)}

OUT OF SCOPE:
${asBullets(contract.scope.outOfScope)}

INTERFACES:
${asBullets(contract.interfaces)}

CONSTRAINTS:
${asBullets(contract.constraints)}

ACCEPTANCE CRITERIA:
${asBullets(contract.acceptanceCriteria)}

CONTEXT FILES:
${asBullets(contract.contextFiles)}

DEPENDENCIES:
${asBullets(contract.dependencies)}

TOUCH HINTS (non-exclusive; own the outcome):
${asBullets(contract.touchHints)}

RISK: ${contract.risk}
PREFERRED WORKER KIND: ${contract.preferredWorkerKind}

BASE COMMIT: ${baseCommit}

APPROVED CHARTER SNAPSHOT (read-only context):
${contextExcerpt(charter)}

APPROVED ARCHITECTURE SNAPSHOT (read-only context):
${contextExcerpt(architecture)}

Inspect the repository, implement the complete result, run relevant checks, use intentum_commit to create the controller-validated commit, and submit intentum_complete with facts and remaining risks.`;
}

function renderResumePrompt(
  contract: WorkContract,
  baseCommit: string,
  currentHead: string,
  charter: string,
  architecture: string,
  instructions: string[],
  recoverySessionCreated: boolean,
): string {
  return `${recoverySessionCreated
    ? "This is a new Pi recovery session because the previously recorded session file is unavailable or unreadable."
    : `Resume WorkContract ${contract.id} in this preserved Pi session and worktree.`}

Preserve all existing files and commits. Re-inspect the Git state before editing.
CURRENT HEAD: ${currentHead}

${renderContractPrompt(contract, baseCommit, charter, architecture)}

QUEUED DESIGNER INSTRUCTIONS:
${asBullets(instructions.length > 0 ? instructions : ["Continue from the last safe boundary and finish the complete contract."])}

Treat the contract and approved snapshots above as immutable context for this attempt. Use intentum_git_snapshot, preserve existing work, use intentum_commit, verify, and call intentum_complete.`;
}

function asBullets(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function contextExcerpt(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 1_500
    ? normalized
    : `${normalized.slice(0, 1_500).trimEnd()}\n[…truncated by Controller]`;
}

function isUnfinishedWorker(status: WorkerRecord["status"]): boolean {
  return !["completed", "failed", "integrated"].includes(status);
}

function assertProjectCanStartWorker(state: ProjectState): void {
  if (state.schedulerPaused || state.phase === "paused") {
    throw new Error("intentum was paused before the Worker could start; preserved resources were not executed");
  }
}

function assertCallbackActive(worker: WorkerRecord, workerId: string, action: string): WorkerRecord {
  if (!["working", "pause_requested"].includes(worker.status)) {
    throw new Error(`Worker ${workerId} cannot ${action} while ${worker.status}`);
  }
  return worker;
}

function assertCompletionActive(worker: WorkerRecord, workerId: string): WorkerRecord {
  if (!["working", "pause_requested"].includes(worker.status)) {
    throw new Error(`Worker ${workerId} cannot complete while ${worker.status}`);
  }
  return worker;
}

function assertAbortableWorker(worker: WorkerRecord, workerId: string): WorkerRecord {
  if (!["starting", "working", "pause_requested", "paused", "blocked", "verifying", "interrupted"].includes(worker.status)) {
    throw new Error(`Worker ${workerId} cannot be aborted while ${worker.status}`);
  }
  return worker;
}

function assertPauseRequestableWorker(worker: WorkerRecord, workerId: string): WorkerRecord {
  if (!["starting", "working"].includes(worker.status)) {
    throw new Error(`Worker ${workerId} cannot be safely paused while ${worker.status}`);
  }
  return worker;
}

function assertResumableWorker(worker: WorkerRecord, workerId: string): WorkerRecord {
  if (!["paused", "interrupted", "blocked"].includes(worker.status)) {
    throw new Error(`Worker ${workerId} cannot resume while ${worker.status}`);
  }
  return worker;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertPathExists(path: string, message: string): Promise<void> {
  if (!(await pathExists(path))) throw new Error(message);
}

function awaitAbortableRuntime(
  factoryPromise: Promise<WorkerRuntime>,
  signal: AbortSignal,
): Promise<WorkerRuntime> {
  return new Promise<WorkerRuntime>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new DOMException("Worker runtime creation aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void factoryPromise.then(
      (runtime) => {
        if (settled) {
          void Promise.resolve(runtime.dispose()).catch(() => undefined);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(runtime);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  // The caller creates and validates the repository-owned parent directory;
  // this helper only performs the same-directory atomic replacement.
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
