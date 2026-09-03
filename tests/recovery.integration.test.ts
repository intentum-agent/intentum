import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import { runFile } from "../src/utils/process.js";
import {
  WorkerSessionUnavailableError,
  type CreateWorkerRuntimeInput,
  type RestoreWorkerRuntimeInput,
  type WorkerRuntime,
} from "../src/runtime/worker-runtime.js";
import type { ProjectState, WorkerRecord } from "../src/state/schema.js";
import type { NewWorkContract } from "../src/work/worker-manager.js";
import { createTempRepository } from "./helpers/temp-repo.js";
import { ScriptedWorkerFactory, ScriptedWorkerRuntime } from "./helpers/scripted-worker.js";

const CONTRACT: NewWorkContract = {
  featureId: "F-001",
  title: "Recoverable work",
  objective: "Preserve and resume one implementation session.",
  why: "Crash recovery is part of the first end-to-end milestone.",
  userVisibleResult: "The same Worker session resumes after controller restart.",
  scope: { inScope: ["session recovery"], outOfScope: ["automatic deletion"] },
  interfaces: [],
  constraints: ["Preserve the worktree"],
  acceptanceCriteria: ["Resume uses the existing sessionRef and worktree"],
  dependencies: [],
  touchHints: [],
  risk: "medium",
  preferredWorkerKind: "implementation",
  contextFiles: [],
};

describe("restart recovery", () => {
  it("marks active work interrupted and restores the same session and worktree on explicit resume", async () => {
    const fixture = await createTempRepository();
    const firstFactory = new ScriptedWorkerFactory();
    const first = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: firstFactory, projectTrusted: true });
    let second: IntentumRuntime | undefined;
    try {
      await first.initialize();
      const started = await first.createWork(CONTRACT);
      await first.dispose();

      const secondFactory = new ScriptedWorkerFactory();
      second = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: secondFactory, projectTrusted: true });
      const recovery = await second.controller.recoverInterruptedWork();
      expect(recovery.interrupted).toEqual([
        { workerId: "W-001", worktreePresent: true, sessionPresent: true },
      ]);
      const interrupted = (await second.workers.inspect("W-001")).worker;
      expect(interrupted).toMatchObject({
        status: "interrupted",
        sessionRef: started.sessionRef,
        worktreePath: started.worktreePath,
        branch: started.branch,
        baseCommit: started.baseCommit,
      });
      const repeatedRecovery = await second.controller.recoverInterruptedWork();
      expect(repeatedRecovery.needsAttention).toEqual([
        { workerId: "W-001", worktreePresent: true, sessionPresent: true },
      ]);

      await second.workers.steer("W-001", "Resume from the preserved state only.");
      const resumed = await second.workers.resume("W-001");
      expect(resumed.status).toBe("working");
      expect(secondFactory.restores).toHaveLength(1);
      expect(secondFactory.restores[0]).toMatchObject({
        workerId: "W-001",
        sessionRef: started.sessionRef,
        worktreePath: started.worktreePath,
      });
      expect(secondFactory.runtimes.get("W-001")?.prompts.at(-1)).toContain(
        "Resume from the preserved state only.",
      );
      expect(secondFactory.runtimes.get("W-001")?.prompts.at(-1)).toContain("ACCEPTANCE CRITERIA:");
      expect(secondFactory.runtimes.get("W-001")?.prompts.at(-1)).toContain(
        "Resume uses the existing sessionRef and worktree",
      );
      await expect(firstFactory.creates[0]?.callbacks.progress({
        summary: "late callback from the disposed runtime",
        state: "working",
      })).rejects.toThrow("stale or disposed");
      expect((await second.workers.inspect("W-001")).worker.status).toBe("working");
    } finally {
      await first.dispose();
      await second?.dispose();
      await fixture.cleanup();
    }
  });

  it("creates an explicit recovery session when the recorded Pi session file is missing", async () => {
    const fixture = await createTempRepository();
    const firstFactory = new ScriptedWorkerFactory();
    const first = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: firstFactory, projectTrusted: true });
    let second: IntentumRuntime | undefined;
    try {
      await first.initialize();
      const started = await first.createWork(CONTRACT);
      await first.dispose();
      if (!started.sessionRef) throw new Error("missing scripted session ref");
      await rm(started.sessionRef);

      const secondFactory = new ScriptedWorkerFactory();
      second = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: secondFactory, projectTrusted: true });
      const recovery = await second.controller.recoverInterruptedWork();
      expect(recovery.interrupted).toEqual([
        { workerId: "W-001", worktreePresent: true, sessionPresent: false },
      ]);
      await second.workers.steer("W-001", "Honor every acceptance criterion during recovery.");
      const resumed = await second.workers.resume("W-001");
      expect(resumed.status).toBe("working");
      expect(resumed.progressSummary).toContain("new recovery session");
      expect(secondFactory.restores).toHaveLength(0);
      expect(secondFactory.creates).toHaveLength(1);
      const recoveryPrompt = secondFactory.runtimes.get("W-001")?.prompts.at(-1) ?? "";
      for (const expected of [
        "new Pi recovery session",
        "ACCEPTANCE CRITERIA:",
        "Resume uses the existing sessionRef and worktree",
        "CONSTRAINTS:",
        "Preserve the worktree",
        "QUEUED DESIGNER INSTRUCTIONS:",
        "Honor every acceptance criterion during recovery.",
      ]) expect(recoveryPrompt).toContain(expected);
    } finally {
      await first.dispose();
      await second?.dispose();
      await fixture.cleanup();
    }
  });

  it("preserves an unreadable recorded session and starts a full recovery session", async () => {
    const fixture = await createTempRepository();
    const first = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(), projectTrusted: true,
    });
    let second: IntentumRuntime | undefined;
    try {
      await first.initialize();
      const started = await first.createWork(CONTRACT);
      await first.dispose();
      if (!started.sessionRef) throw new Error("missing scripted session ref");

      const factory = new BrokenRestoreFactory();
      second = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
      await second.controller.recoverInterruptedWork();
      const resumed = await second.workers.resume("W-001", "Recover without discarding repository work.");

      expect(factory.restores).toHaveLength(1);
      expect(factory.creates).toHaveLength(1);
      expect(resumed.status).toBe("working");
      expect(resumed.sessionRef).not.toBe(started.sessionRef);
      const prompt = factory.runtimes.get("W-001")?.prompts.at(-1) ?? "";
      expect(prompt).toContain("new Pi recovery session");
      expect(prompt).toContain("Recover without discarding repository work.");
      expect(await readFile(started.sessionRef, "utf8")).toContain("session");
    } finally {
      await first.dispose();
      await second?.dispose();
      await fixture.cleanup();
    }
  });

  it("abandons a missing worktree record and releases the single-Worker slot", async () => {
    const fixture = await createTempRepository();
    const first = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(), projectTrusted: true,
    });
    let second: IntentumRuntime | undefined;
    try {
      await first.initialize();
      const started = await first.createWork(CONTRACT);
      await first.dispose();
      if (!started.worktreePath) throw new Error("missing scripted worktree path");

      second = new IntentumRuntime(fixture.repo, {
        cacheRoot: fixture.cache,
        workerRuntimeFactory: new ScriptedWorkerFactory(), projectTrusted: true,
      });
      const firstRecovery = await second.controller.recoverInterruptedWork();
      expect(firstRecovery.interrupted[0]).toMatchObject({ workerId: "W-001", worktreePresent: true });

      await rm(started.worktreePath, { recursive: true, force: true });
      const secondRecovery = await second.controller.recoverInterruptedWork();
      expect(secondRecovery.interrupted).toEqual([]);
      expect(secondRecovery.abandoned[0]).toMatchObject({ workerId: "W-001", worktreePresent: false });
      await expect(second.workers.resume("W-001")).rejects.toThrow("cannot resume while failed");
      expect((await second.workers.inspect("W-001")).worker.status).toBe("failed");

      const replacement = await second.createWork({ ...CONTRACT, featureId: "F-002" });
      expect(replacement.id).toBe("W-002");
      expect(replacement.status).toBe("working");
    } finally {
      await first.dispose();
      await second?.dispose();
      await fixture.cleanup();
    }
  });

  it("converges a queued crash reservation to failed without reusing its id", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(), projectTrusted: true,
    });
    try {
      await runtime.initialize();
      await runtime.store.update((state) => ({
        ...state,
        activeFeatureId: "F-001",
        workers: {
          ...state.workers,
          "W-001": queuedWorker("W-001"),
        },
      }));

      const recovery = await runtime.controller.recoverInterruptedWork();
      expect(recovery.interrupted).toEqual([]);
      expect(recovery.abandoned).toEqual([
        { workerId: "W-001", worktreePresent: false, sessionPresent: false },
      ]);
      expect((await runtime.store.read()).workers["W-001"]?.status).toBe("failed");
      const abandoned = await runtime.workers.inspect("W-001");
      expect(abandoned.worker.status).toBe("failed");
      expect(abandoned.contract).toBeUndefined();
      expect(abandoned.diagnostic).toContain("no persisted WorkContract");

      const replacement = await runtime.createWork({ ...CONTRACT, featureId: "F-002" });
      expect(replacement.id).toBe("W-002");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("serializes concurrent resume attempts and restores one runtime generation", async () => {
    const fixture = await createTempRepository();
    const first = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(), projectTrusted: true,
    });
    let second: IntentumRuntime | undefined;
    try {
      await first.initialize();
      await first.createWork(CONTRACT);
      await first.dispose();

      const factory = new DelayedRestoreFactory();
      second = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
      await second.controller.recoverInterruptedWork();

      const firstResume = second.workers.resume("W-001");
      await factory.restoreEntered;
      const secondResume = second.workers.resume("W-001");
      factory.releaseRestore();
      const outcomes = await Promise.allSettled([firstResume, secondResume]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      expect(String(rejected?.reason)).toContain("cannot resume while working");
      expect(factory.restores).toHaveLength(1);
      expect(factory.runtimes.get("W-001")?.disposed).toBe(false);
      expect((await second.store.read()).workers["W-001"]?.status).toBe("working");
    } finally {
      await first.dispose();
      await second?.dispose();
      await fixture.cleanup();
    }
  });

  it("lets emergency abort preempt a delayed restore while preserving queued steering", async () => {
    const fixture = await createTempRepository();
    const first = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(), projectTrusted: true,
    });
    let second: IntentumRuntime | undefined;
    try {
      await first.initialize();
      await first.createWork(CONTRACT);
      await first.dispose();

      const factory = new DelayedRestoreFactory();
      second = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
      await second.controller.recoverInterruptedWork();

      const resume = second.workers.resume("W-001");
      await factory.restoreEntered;
      const steer = second.workers.steer("W-001", "Instruction arriving during restore.");
      const abort = second.workers.abort("W-001", "operator stop during recovery");
      factory.releaseRestore();
      await expect(resume).rejects.toThrow("superseded by an emergency abort");
      await Promise.all([steer, abort]);

      const restored = factory.runtimes.get("W-001");
      expect(factory.restores).toHaveLength(1);
      expect(restored?.prompts).toEqual([]);
      expect(restored?.disposed).toBe(true);
      expect((await second.store.read()).workers["W-001"]).toMatchObject({
        status: "interrupted",
        blocker: "Emergency abort before session startup: operator stop during recovery",
        pendingInstructions: ["Instruction arriving during restore."],
      });
    } finally {
      await first.dispose();
      await second?.dispose();
      await fixture.cleanup();
    }
  });

  it("does not launch a restored Worker when the project pauses during restore", async () => {
    const fixture = await createTempRepository();
    const first = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(), projectTrusted: true,
    });
    let second: IntentumRuntime | undefined;
    try {
      await first.initialize();
      await first.createWork(CONTRACT);
      await first.dispose();

      const factory = new DelayedRestoreFactory();
      second = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
      await second.controller.recoverInterruptedWork();

      const resume = second.workers.resume("W-001");
      await factory.restoreEntered;
      await second.pauseProject();
      factory.releaseRestore();

      await expect(resume).rejects.toThrow("paused before the Worker could start");
      expect((await second.store.read()).phase).toBe("paused");
      expect((await second.store.read()).workers["W-001"]?.status).toBe("interrupted");
      expect(factory.runtimes.get("W-001")?.prompts).toEqual([]);
      expect(factory.runtimes.get("W-001")?.disposed).toBe(true);
    } finally {
      await first.dispose();
      await second?.dispose();
      await fixture.cleanup();
    }
  });

  it("does not let a recovery snapshot from a disposed controller overwrite a new attempt", async () => {
    const fixture = await createTempRepository();
    const first = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    let stale: IntentumRuntime | undefined;
    let fresh: IntentumRuntime | undefined;
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    try {
      await first.initialize();
      await first.createWork(CONTRACT);
      await first.dispose();

      stale = new IntentumRuntime(fixture.repo, {
        cacheRoot: fixture.cache,
        workerRuntimeFactory: new ScriptedWorkerFactory(),
        projectTrusted: true,
      });
      const originalUpdate = stale.store.update.bind(stale.store);
      let enteredUpdate!: () => void;
      const updateEntered = new Promise<void>((resolve) => { enteredUpdate = resolve; });
      Object.defineProperty(stale.store, "update", {
        value: async (updater: (state: ProjectState) => ProjectState | Promise<ProjectState>) => {
          enteredUpdate();
          await updateGate;
          return originalUpdate(updater);
        },
      });
      const staleRecovery = stale.controller.recoverInterruptedWork();
      await updateEntered;
      await stale.dispose();

      fresh = new IntentumRuntime(fixture.repo, {
        cacheRoot: fixture.cache,
        workerRuntimeFactory: new ScriptedWorkerFactory(),
        projectTrusted: true,
      });
      await fresh.onSessionStart(extensionContext(fixture.repo));
      const resumed = await fresh.workers.resume("W-001");
      const freshAttemptId = resumed.attemptId;
      expect(freshAttemptId).toBeTruthy();

      releaseUpdate();
      await staleRecovery;
      expect((await fresh.store.read()).workers["W-001"]).toMatchObject({
        status: "working",
        attemptId: freshAttemptId,
      });
    } finally {
      releaseUpdate();
      await stale?.dispose();
      await fresh?.dispose();
      await first.dispose();
      await fixture.cleanup();
    }
  });

  it("reconciles completed result evidence across both durable completion crash windows", async () => {
    for (const crashWindow of ["verifying", "result_before_state"] as const) {
      const fixture = await createTempRepository();
      const firstFactory = new ScriptedWorkerFactory();
      const first = new IntentumRuntime(fixture.repo, {
        cacheRoot: fixture.cache,
        workerRuntimeFactory: firstFactory,
        projectTrusted: true,
      });
      let second: IntentumRuntime | undefined;
      try {
        await first.initialize();
        const worker = await first.createWork(CONTRACT);
        const create = firstFactory.creates[0];
        if (!worker.worktreePath || !create) throw new Error("scripted Worker was not created");
        await writeFile(join(worker.worktreePath, "recovered.txt"), `${crashWindow}\n`, "utf8");
        const committed = await create.callbacks.commit({ message: `test: ${crashWindow}` });
        await create.callbacks.complete({
          status: "completed",
          summary: `Candidate from ${crashWindow}.`,
          userVisibleChanges: ["Added recovered.txt"],
          filesChanged: ["recovered.txt"],
          testsRun: [],
          architectureConcerns: [],
          remainingRisks: [],
          suggestedFollowUps: [],
        });
        if (crashWindow === "result_before_state") {
          // Fault-injection snapshot: result.json rename succeeded, but the
          // canonical state CAS did not survive.
          await first.store.update((state) => {
            const current = state.workers["W-001"]!;
            const reset = { ...current, status: "working" as const };
            delete reset.pendingTerminalStatus;
            delete reset.resultCommit;
            return { ...state, workers: { ...state.workers, "W-001": reset } };
          });
        }
        await first.dispose();

        second = new IntentumRuntime(fixture.repo, {
          cacheRoot: fixture.cache,
          workerRuntimeFactory: new ScriptedWorkerFactory(),
          projectTrusted: true,
        });
        const recovery = await second.onSessionStart(extensionContext(fixture.repo));
        expect(recovery.interrupted).toEqual([]);
        expect(recovery.reconciled).toEqual(["W-001"]);
        const recovered = await second.workers.inspect("W-001");
        expect(recovered.worker.status).toBe("completed");
        expect(recovered.worker.resultCommit).toBe(committed.commit);
        expect(recovered.result?.resultCommit).toBe(committed.commit);
      } finally {
        await first.dispose();
        await second?.dispose();
        await fixture.cleanup();
      }
    }
  });

  it("does not reuse a blocked result after resume starts a fresh attempt", async () => {
    const fixture = await createTempRepository();
    const firstFactory = new ScriptedWorkerFactory();
    const first = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: firstFactory,
      projectTrusted: true,
    });
    let second: IntentumRuntime | undefined;
    try {
      await first.initialize();
      await first.createWork(CONTRACT);
      const create = firstFactory.creates[0];
      const scripted = firstFactory.runtimes.get("W-001");
      if (!create || !scripted) throw new Error("scripted Worker was not created");
      await create.callbacks.complete({
        status: "blocked",
        summary: "Old attempt blocker.",
        userVisibleChanges: [],
        filesChanged: [],
        testsRun: [],
        architectureConcerns: [],
        remainingRisks: ["Needs another attempt"],
        suggestedFollowUps: [],
      });
      scripted.emit({ type: "settled" });
      await expect.poll(async () => (await first.workers.inspect("W-001")).worker.status).toBe("blocked");
      await first.workers.resume("W-001");
      expect((await first.workers.inspect("W-001")).result).toBeUndefined();
      await first.dispose();

      second = new IntentumRuntime(fixture.repo, {
        cacheRoot: fixture.cache,
        workerRuntimeFactory: new ScriptedWorkerFactory(),
        projectTrusted: true,
      });
      const recovery = await second.onSessionStart(extensionContext(fixture.repo));
      expect(recovery.interrupted.map((item) => item.workerId)).toEqual(["W-001"]);
      const recovered = await second.workers.inspect("W-001");
      expect(recovered.worker.status).toBe("interrupted");
      expect(recovered.result).toBeUndefined();
      expect(recovered.worker.blocker).not.toBe("Old attempt blocker.");
    } finally {
      await first.dispose();
      await second?.dispose();
      await fixture.cleanup();
    }
  });
});

function extensionContext(cwd: string): ExtensionContext {
  return {
    cwd,
    ui: { setWidget() {}, setStatus() {} },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

function queuedWorker(id: string): WorkerRecord {
  return {
    id,
    kind: "implementation",
    status: "queued",
    featureId: "F-001",
    objective: CONTRACT.objective,
    updatedAt: new Date().toISOString(),
  };
}

class DelayedRestoreFactory extends ScriptedWorkerFactory {
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private entered!: () => void;
  readonly restoreEntered = new Promise<void>((resolve) => {
    this.entered = resolve;
  });

  releaseRestore(): void {
    this.release();
  }

  override async restore(input: RestoreWorkerRuntimeInput): Promise<WorkerRuntime> {
    this.entered();
    await this.gate;
    return super.restore(input);
  }
}

class BrokenRestoreFactory extends ScriptedWorkerFactory {
  override async restore(input: RestoreWorkerRuntimeInput): Promise<WorkerRuntime> {
    this.restores.push(input);
    throw new WorkerSessionUnavailableError("recorded session is corrupt");
  }

  override async create(input: CreateWorkerRuntimeInput): Promise<WorkerRuntime> {
    this.creates.push(input);
    const sessionRef = join(input.worktreePath, "..", `${input.workerId}.recovery-session.jsonl`);
    await writeFile(sessionRef, `${JSON.stringify({ type: "session", id: `${input.workerId}-recovery` })}\n`, "utf8");
    const runtime = new ScriptedWorkerRuntime(input.workerId, sessionRef);
    this.runtimes.set(input.workerId, runtime);
    return runtime;
  }
}
