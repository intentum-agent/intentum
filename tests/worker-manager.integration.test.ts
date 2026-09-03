import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import type { CreateWorkerRuntimeInput, WorkerRuntime } from "../src/runtime/worker-runtime.js";
import { runFile } from "../src/utils/process.js";
import type { NewWorkContract } from "../src/work/worker-manager.js";
import { createTempRepository } from "./helpers/temp-repo.js";
import { ScriptedWorkerFactory, ScriptedWorkerRuntime } from "./helpers/scripted-worker.js";

const CONTRACT: NewWorkContract = {
  featureId: "F-001",
  title: "Deliver a visible fixture outcome",
  objective: "Add the complete greeting vertical slice to the fixture repository.",
  why: "It proves the controller-to-worktree-to-integration path.",
  userVisibleResult: "The repository contains greeting.txt with the expected message.",
  scope: { inScope: ["greeting.txt", "verification"], outOfScope: ["network services"] },
  interfaces: ["greeting.txt text contract"],
  constraints: ["Preserve README.md"],
  acceptanceCriteria: ["greeting.txt contains hello from intentum"],
  dependencies: [],
  touchHints: ["greeting.txt"],
  risk: "low",
  preferredWorkerKind: "implementation",
  contextFiles: ["README.md"],
};

describe("single Worker vertical slice", () => {
  it("uses a real external worktree, verifies the result commit, and merges only explicitly", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize("Fixture Product");
      const worker = await runtime.createWork(CONTRACT);
      expect(worker).toMatchObject({ id: "W-001", status: "working", branch: "intentum/F-001/W-001" });
      expect(worker.worktreePath?.startsWith(fixture.cache)).toBe(true);
      expect(worker.worktreePath?.startsWith(fixture.repo)).toBe(false);
      await expect(access(join(fixture.repo, "greeting.txt"))).rejects.toMatchObject({ code: "ENOENT" });

      const create = factory.creates[0];
      if (!create || !worker.worktreePath) throw new Error("scripted Worker was not created");
      await create.callbacks.progress({ summary: "Implementation finished; committing fixture.", state: "working" });
      await writeFile(join(worker.worktreePath, "greeting.txt"), "hello from intentum\n", "utf8");
      const committed = await create.callbacks.commit({ message: "feat: add greeting" });
      expect(committed.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(committed.files).toEqual(["greeting.txt"]);
      await create.callbacks.complete({
        status: "completed",
        summary: "Greeting outcome implemented and checked.",
        userVisibleChanges: ["Added the requested greeting."],
        filesChanged: ["incorrect-model-claim.txt"],
        testsRun: [{ command: "test $(cat greeting.txt) = 'hello from intentum'", status: "passed", exitCode: 0, summary: "Exact content matched." }],
        architectureConcerns: [],
        remainingRisks: [],
        suggestedFollowUps: [],
      });
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("verifying");
      factory.runtimes.get("W-001")?.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("completed");

      const completed = await runtime.workers.inspect("W-001");
      expect(completed.worker.status).toBe("completed");
      expect(completed.worker.resultCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(completed.result?.filesChanged).toEqual(["greeting.txt"]);
      expect(completed.result?.remainingRisks).toContain(
        "Worker-reported filesChanged differed from the controller's Git diff; Git-derived paths were stored.",
      );
      await expect(access(join(fixture.repo, "greeting.txt"))).rejects.toMatchObject({ code: "ENOENT" });

      const integrated = await runtime.workers.integrateWorker("W-001");
      expect(integrated.status).toBe("integrated");
      expect(await readFile(join(fixture.repo, "greeting.txt"), "utf8")).toBe("hello from intentum\n");
      expect((await runFile("git", ["branch", "--show-current"], fixture.repo)).stdout).toBe("main");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("does not accept a completed result from a dirty Worker worktree", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      const worker = await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      if (!create || !worker.worktreePath) throw new Error("scripted Worker was not created");
      await writeFile(join(worker.worktreePath, "dirty.txt"), "uncommitted\n", "utf8");
      await expect(create.callbacks.complete({
        status: "completed",
        summary: "Incorrect completion claim.",
        userVisibleChanges: [],
        filesChanged: ["dirty.txt"],
        testsRun: [],
        architectureConcerns: [],
        remainingRisks: [],
        suggestedFollowUps: [],
      })).rejects.toThrow("uncommitted changes");
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("working");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("rejects post-completion tool-batch mutations during final settled verification", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      const worker = await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      const scripted = factory.runtimes.get("W-001");
      if (!create || !scripted || !worker.worktreePath) throw new Error("scripted Worker was not created");

      await writeFile(join(worker.worktreePath, "greeting.txt"), "committed result\n", "utf8");
      await runFile("git", ["add", "greeting.txt"], worker.worktreePath);
      await runFile("git", ["commit", "-m", "feat: candidate result"], worker.worktreePath);
      await create.callbacks.complete({
        status: "completed",
        summary: "Candidate result submitted.",
        userVisibleChanges: ["Added greeting.txt."],
        filesChanged: ["greeting.txt"],
        testsRun: [],
        architectureConcerns: [],
        remainingRisks: [],
        suggestedFollowUps: [],
      });
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("verifying");

      // A later tool in the same Pi assistant batch can still run even when the
      // custom result returned terminate=true. Finalization therefore waits for
      // agent_settled and rechecks Git after every tool in that batch is done.
      await writeFile(join(worker.worktreePath, "late-batch-write.txt"), "late mutation\n", "utf8");
      scripted.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("blocked");
      const blocked = await runtime.workers.inspect("W-001");
      expect(blocked.worker.blocker).toContain("Final Git verification failed");
      await expect(runtime.workers.integrateWorker("W-001")).rejects.toThrow("not completed");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("keeps safe pause separate from emergency abort and queues paused steering", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      const scripted = factory.runtimes.get("W-001");
      if (!create || !scripted) throw new Error("scripted Worker was not created");

      const requested = await runtime.workers.requestPause("W-001");
      expect(requested.status).toBe("pause_requested");
      expect(scripted.aborted).toBe(false);
      expect(scripted.steering.at(-1)).toContain("safe pause");
      await create.callbacks.progress({ summary: "Saved at an atomic boundary.", state: "paused" });
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("verifying");
      await expect(create.callbacks.escalate({
        kind: "blocker",
        summary: "A later terminal tool must not override the first disposition.",
      })).rejects.toThrow("cannot escalate while verifying");
      scripted.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("paused");

      await runtime.workers.steer("W-001", "Keep the public filename stable.");
      expect((await runtime.workers.inspect("W-001")).worker.pendingInstructions).toEqual([
        "Keep the public filename stable.",
      ]);
      await runtime.workers.resume("W-001");
      expect(scripted.prompts.at(-1)).toContain("Keep the public filename stable.");
      // Delivery is at-least-once: the durable instruction remains until the
      // resumed Pi turn actually settles, so a crash between prompt dispatch
      // and consumption cannot lose it.
      expect((await runtime.workers.inspect("W-001")).worker.pendingInstructions).toEqual([
        "Keep the public filename stable.",
      ]);

      await runtime.workers.abort("W-001", "Operator requested immediate stop");
      expect(scripted.aborted).toBe(true);
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("interrupted");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("keeps live steering durable when the current turn settles before Pi consumes its queue", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: factory,
      projectTrusted: true,
    });
    try {
      await runtime.initialize();
      await runtime.createWork(CONTRACT);
      const scripted = factory.runtimes.get("W-001");
      if (!scripted) throw new Error("scripted Worker was not created");

      await runtime.workers.steer("W-001", "Preserve this instruction across a queue race.");
      expect(scripted.steering).toContain("Preserve this instruction across a queue race.");
      scripted.emit({ type: "settled" });

      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("blocked");
      expect((await runtime.workers.inspect("W-001")).worker.pendingInstructions).toEqual([
        "Preserve this instruction across a queue race.",
      ]);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("aborts a conflicting merge and preserves both branches and the Worker worktree", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      const worker = await runtime.createWork({ ...CONTRACT, touchHints: ["README.md"] });
      const create = factory.creates[0];
      if (!create || !worker.worktreePath) throw new Error("scripted Worker was not created");

      await writeFile(join(worker.worktreePath, "README.md"), "# Fixture\n\nworker version\n", "utf8");
      await runFile("git", ["add", "README.md"], worker.worktreePath);
      await runFile("git", ["commit", "-m", "worker: edit readme"], worker.worktreePath);
      await create.callbacks.complete({
        status: "completed",
        summary: "Worker version committed.",
        userVisibleChanges: [],
        filesChanged: ["README.md"],
        testsRun: [],
        architectureConcerns: [],
        remainingRisks: [],
        suggestedFollowUps: [],
      });
      factory.runtimes.get("W-001")?.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("completed");

      await writeFile(join(fixture.repo, "README.md"), "# Fixture\n\nmain version\n", "utf8");
      await runFile("git", ["add", "README.md"], fixture.repo);
      await runFile("git", ["commit", "-m", "main: edit readme"], fixture.repo);
      await expect(runtime.workers.integrateWorker("W-001")).rejects.toThrow("merge was aborted");
      const after = (await runtime.workers.inspect("W-001")).worker;
      expect(after.status).toBe("blocked");
      expect(after.worktreePath).toBe(worker.worktreePath);
      expect(await readFile(join(fixture.repo, "README.md"), "utf8")).toContain("main version");
      expect((await runFile("git", ["status", "--porcelain=v1"], fixture.repo)).stdout).not.toContain("UU");
      expect((await runFile("git", ["show-ref", "--verify", "refs/heads/intentum/F-001/W-001"], fixture.repo)).stdout).toContain("refs/heads/intentum/F-001/W-001");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("preserves the real prompt failure when Pi emits settled before prompt rejects", async () => {
    const fixture = await createTempRepository();
    const factory = new SettledThenRejectFactory();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: factory,
      projectTrusted: true,
    });
    try {
      await runtime.initialize();
      await runtime.createWork(CONTRACT);
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("failed");
      const failed = (await runtime.workers.inspect("W-001")).worker;
      expect(failed.blocker).toContain("fixture provider unavailable");
      expect(failed.blocker).not.toContain("without submitting intentum_complete");
      expect(factory.runtimes.get("W-001")?.disposed).toBe(true);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("retires terminal completed and failed sessions across sequential Workers", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: factory,
      projectTrusted: true,
    });
    try {
      await runtime.initialize();
      const first = await runtime.createWork(CONTRACT);
      const firstCreate = factory.creates[0];
      const firstRuntime = factory.runtimes.get("W-001");
      if (!first.worktreePath || !firstCreate || !firstRuntime) throw new Error("first Worker missing");
      await writeFile(join(first.worktreePath, "first.txt"), "first\n", "utf8");
      await firstCreate.callbacks.commit({ message: "feat: first result" });
      await firstCreate.callbacks.complete({
        status: "completed",
        summary: "First result complete.",
        userVisibleChanges: ["Added first.txt"],
        filesChanged: ["first.txt"],
        testsRun: [],
        architectureConcerns: [],
        remainingRisks: [],
        suggestedFollowUps: [],
      });
      firstRuntime.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("completed");
      expect(firstRuntime.disposed).toBe(true);

      await runtime.createWork({ ...CONTRACT, featureId: "F-002" });
      const secondCreate = factory.creates[1];
      const secondRuntime = factory.runtimes.get("W-002");
      if (!secondCreate || !secondRuntime) throw new Error("second Worker missing");
      await secondCreate.callbacks.complete({
        status: "failed",
        summary: "Second Worker stopped factually.",
        userVisibleChanges: [],
        filesChanged: [],
        testsRun: [],
        architectureConcerns: [],
        remainingRisks: ["Fixture failure"],
        suggestedFollowUps: [],
      });
      secondRuntime.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-002")).worker.status).toBe("failed");
      expect(secondRuntime.disposed).toBe(true);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("keeps a verified terminal result when a later mixed-batch provider step rejects", async () => {
    const fixture = await createTempRepository();
    const factory = new TerminalThenRejectFactory();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: factory,
      projectTrusted: true,
    });
    try {
      await runtime.initialize();
      const worker = await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      if (!worker.worktreePath || !create) throw new Error("Worker missing");
      await writeFile(join(worker.worktreePath, "terminal.txt"), "terminal result\n", "utf8");
      await create.callbacks.commit({ message: "feat: terminal result" });
      await create.callbacks.complete({
        status: "completed",
        summary: "Terminal result was submitted before the later provider failure.",
        userVisibleChanges: ["Added terminal.txt"],
        filesChanged: ["terminal.txt"],
        testsRun: [],
        architectureConcerns: [],
        remainingRisks: [],
        suggestedFollowUps: [],
      });
      factory.settleAndReject(new Error("provider failed after terminal tool"));
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("completed");
      const completed = await runtime.workers.inspect("W-001");
      expect(completed.worker.blocker).toBeUndefined();
      expect(completed.result?.summary).toContain("Terminal result was submitted");
      expect(factory.runtimes.get("W-001")?.disposed).toBe(true);
    } finally {
      factory.settleAndReject(new Error("cleanup"));
      await runtime.dispose();
      await fixture.cleanup();
    }
  });
});

class SettledThenRejectFactory extends ScriptedWorkerFactory {
  override async create(input: CreateWorkerRuntimeInput): Promise<WorkerRuntime> {
    const runtime = await super.create(input) as ScriptedWorkerRuntime;
    runtime.prompt = (text: string) => {
      runtime.prompts.push(text);
      return new Promise<void>((_resolve, reject) => {
        queueMicrotask(() => {
          runtime.emit({ type: "settled" });
          reject(new Error("fixture provider unavailable"));
        });
      });
    };
    return runtime;
  }
}

class TerminalThenRejectFactory extends ScriptedWorkerFactory {
  private rejectPrompt: ((error: Error) => void) | undefined;

  override async create(input: CreateWorkerRuntimeInput): Promise<WorkerRuntime> {
    const runtime = await super.create(input) as ScriptedWorkerRuntime;
    runtime.prompt = (text: string) => {
      runtime.prompts.push(text);
      return new Promise<void>((_resolve, reject) => {
        this.rejectPrompt = reject;
      });
    };
    return runtime;
  }

  settleAndReject(error: Error): void {
    const runtime = this.runtimes.get("W-001");
    if (!runtime || !this.rejectPrompt) return;
    runtime.emit({ type: "settled" });
    this.rejectPrompt(error);
    this.rejectPrompt = undefined;
  }
}
