import { readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import type { CreateWorkerRuntimeInput, WorkerRuntime } from "../src/runtime/worker-runtime.js";
import { runFile } from "../src/utils/process.js";
import type { NewWorkContract } from "../src/work/worker-manager.js";
import { createTempRepository } from "./helpers/temp-repo.js";
import { ScriptedWorkerFactory } from "./helpers/scripted-worker.js";

const CONTRACT: NewWorkContract = {
  featureId: "F-001",
  title: "Safety fixture",
  objective: "Deliver one complete, isolated safety fixture outcome.",
  why: "It validates deterministic controller boundaries.",
  userVisibleResult: "A committed outcome.txt file is available for explicit integration.",
  scope: { inScope: ["outcome.txt"], outOfScope: ["controller state"] },
  interfaces: ["outcome.txt text format"],
  constraints: ["Do not edit .intentum"],
  acceptanceCriteria: ["outcome.txt contains safe outcome"],
  dependencies: ["initial repository commit"],
  touchHints: ["outcome.txt"],
  risk: "medium",
  preferredWorkerKind: "implementation",
  contextFiles: ["README.md"],
};

describe("Worker safety boundaries", () => {
  it("supports tracked orchestration artifacts, protects them from Workers, and keeps integration preconditions retryable", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize("Tracked State Fixture");
      await runtime.writeArtifact("charter", "# Charter\n\nApproved user outcome.\n");
      await runtime.writeArtifact("architecture", "# Architecture\n\nApproved modular direction.\n");
      await runFile("git", ["add", ".intentum"], fixture.repo);
      await runFile("git", ["commit", "-m", "intentum: track project knowledge"], fixture.repo);

      const worker = await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      const scripted = factory.runtimes.get("W-001");
      if (!create || !scripted || !worker.worktreePath) throw new Error("scripted Worker was not created");
      const initialPrompt = scripted.prompts[0] ?? "";
      for (const expected of [
        "DEPENDENCIES:",
        "initial repository commit",
        "TOUCH HINTS",
        "outcome.txt",
        "RISK: medium",
        "PREFERRED WORKER KIND: implementation",
        "Approved user outcome.",
        "Approved modular direction.",
      ]) expect(initialPrompt).toContain(expected);

      await writeFile(join(worker.worktreePath, "outcome.txt"), "safe outcome\n", "utf8");
      await runFile("git", ["add", "outcome.txt"], worker.worktreePath);
      await runFile("git", ["commit", "-m", "feat: safe outcome"], worker.worktreePath);
      await create.callbacks.complete(completedResult(["outcome.txt"]));

      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("verifying");
      await expect(create.callbacks.complete(completedResult(["outcome.txt"]))).rejects.toThrow("cannot complete while verifying");
      scripted.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("completed");
      await expect(runtime.workers.abort("W-001", "late abort")).rejects.toThrow("cannot be aborted while completed");
      expect(scripted.aborted).toBe(false);

      const lateWorkerChange = join(worker.worktreePath, "late-local.txt");
      await writeFile(lateWorkerChange, "not part of the completed result\n", "utf8");
      await expect(runtime.workers.integrateWorker("W-001")).rejects.toThrow("uncommitted changes");
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("completed");
      await rm(lateWorkerChange);

      const unrelatedPath = join(fixture.repo, "local-note.txt");
      await writeFile(unrelatedPath, "uncommitted user work\n", "utf8");
      await expect(runtime.workers.integrateWorker("W-001")).rejects.toThrow("unrelated changes");
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("completed");
      await rm(unrelatedPath);

      await runtime.workers.integrateWorker("W-001");
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("integrated");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("cancels and drains an in-flight integration before releasing the runtime lifecycle", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: factory,
      projectTrusted: true,
    });
    let disposed = false;
    try {
      await runtime.initialize();
      const worker = await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      const scripted = factory.runtimes.get("W-001");
      if (!create || !scripted || !worker.worktreePath) throw new Error("scripted Worker was not created");
      await writeFile(join(worker.worktreePath, "outcome.txt"), "safe outcome\n", "utf8");
      await runFile("git", ["add", "outcome.txt"], worker.worktreePath);
      await runFile("git", ["commit", "-m", "feat: cancellable integration"], worker.worktreePath);
      await create.callbacks.complete(completedResult(["outcome.txt"]));
      scripted.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.store.read()).workers["W-001"]?.status).toBe("completed");

      let entered!: () => void;
      const integrationEntered = new Promise<void>((resolve) => { entered = resolve; });
      let abortObserved = false;
      Object.defineProperty(runtime.workers, "integration", {
        value: {
          integrate: async (_request: unknown, signal?: AbortSignal) => {
            entered();
            await new Promise<never>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                abortObserved = true;
                reject(signal.reason ?? new Error("integration aborted"));
              }, { once: true });
            });
          },
        },
      });

      const integration = runtime.workers.integrateWorker("W-001");
      const rejected = expect(integration).rejects.toThrow();
      await integrationEntered;
      await runtime.dispose();
      disposed = true;
      await rejected;
      expect(abortObserved).toBe(true);
      expect((await runtime.store.read()).workers["W-001"]?.status).toBe("completed");
    } finally {
      if (!disposed) await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("rejects a Worker commit that changes controller-owned .intentum state", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      await runFile("git", ["add", ".intentum"], fixture.repo);
      await runFile("git", ["commit", "-m", "intentum: track state"], fixture.repo);
      const worker = await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      if (!create || !worker.worktreePath) throw new Error("scripted Worker was not created");

      await writeFile(join(worker.worktreePath, ".intentum", "state.json"), "{}\n", "utf8");
      await expect(create.callbacks.commit({ message: "bad: mutate controller state" })).rejects.toThrow(
        "controller-owned .intentum paths",
      );
      await runFile("git", ["add", ".intentum/state.json"], worker.worktreePath);
      await runFile("git", ["commit", "-m", "bad: mutate controller state"], worker.worktreePath);
      await expect(create.callbacks.complete(completedResult([".intentum/state.json"]))).rejects.toThrow(
        "controller-owned .intentum state",
      );
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("working");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("rejects a symlinked result directory without touching the outside target", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: factory,
      projectTrusted: true,
    });
    const outside = join(fixture.root, "outside-results");
    try {
      await runtime.initialize();
      const worker = await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      if (!worker.worktreePath || !create) throw new Error("scripted Worker was not created");
      await writeFile(join(worker.worktreePath, "outcome.txt"), "safe outcome\n", "utf8");
      await create.callbacks.commit({ message: "feat: result symlink boundary" });

      await mkdir(outside);
      await symlink(outside, join(fixture.repo, ".intentum", "runs"));
      await expect(create.callbacks.complete(completedResult(["outcome.txt"]))).rejects.toThrow("symbolic link");
      expect(await readdir(outside)).toEqual([]);
      expect((await runtime.store.read()).workers["W-001"]?.status).toBe("working");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("enforces one unfinished Worker and queues steering while a safe pause is pending", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      const scripted = factory.runtimes.get("W-001");
      if (!create || !scripted) throw new Error("scripted Worker was not created");

      await create.callbacks.escalate({ kind: "blocker", summary: "Needs a product decision." });
      await expect(runtime.createWork({ ...CONTRACT, featureId: "F-002" })).rejects.toThrow("one active Worker");
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("verifying");
      scripted.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("blocked");

      await runtime.workers.resume("W-001");
      await runtime.pauseProject();
      await runtime.workers.steer("W-001", "Apply this only after resume.");
      expect(scripted.steering).toHaveLength(1);
      expect(scripted.steering[0]).toContain("safe pause");
      expect((await runtime.workers.inspect("W-001")).worker.pendingInstructions).toEqual([
        "Apply this only after resume.",
      ]);

      await create.callbacks.progress({ summary: "Stopped at a safe boundary.", state: "paused" });
      scripted.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("paused");
      await expect(runtime.workers.resume("W-001")).rejects.toThrow("resume the project");
      await runtime.resumeProject();
      await runtime.workers.resume("W-001");
      expect(scripted.prompts.at(-1)).toContain("Apply this only after resume.");

      await runtime.workers.abort("W-001", "operator stop");
      await expect(create.callbacks.progress({ summary: "late progress", state: "working" })).rejects.toThrow("stale or disposed");
      await expect(create.callbacks.complete(completedResult(["outcome.txt"]))).rejects.toThrow(
        "stale or disposed",
      );
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("interrupted");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("rejects a cache symlink that would place a worktree inside the repository", async () => {
    const fixture = await createTempRepository();
    const nestedCache = join(fixture.repo, ".nested-cache");
    const cacheLink = join(fixture.root, "cache-link");
    await mkdir(nestedCache);
    await symlink(nestedCache, cacheLink, "dir");
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: cacheLink,
      workerRuntimeFactory: new ScriptedWorkerFactory(), projectTrusted: true,
    });
    try {
      await runtime.initialize();
      await expect(runtime.createWork(CONTRACT)).rejects.toThrow("cache root resolves inside");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("does not launch a newly created Worker when the project pauses during runtime creation", async () => {
    const fixture = await createTempRepository();
    const factory = new DelayedCreateFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      const creating = runtime.createWork(CONTRACT);
      await factory.createEntered;

      await runtime.pauseProject();
      factory.releaseCreate();

      await expect(creating).rejects.toThrow("paused before the Worker could start");
      expect((await runtime.store.read()).phase).toBe("paused");
      expect((await runtime.store.read()).workers["W-001"]?.status).toBe("failed");
      expect(factory.runtimes.get("W-001")?.prompts).toEqual([]);
      expect(factory.runtimes.get("W-001")?.disposed).toBe(true);
    } finally {
      factory.releaseCreate();
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("keeps lifecycle controls effective when TUI observers throw", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      const throwingUi = {
        setWidget() { throw new Error("widget failed"); },
        setStatus() { throw new Error("status failed"); },
      };
      await runtime.onSessionStart({
        cwd: fixture.repo,
        ui: throwingUi,
        isProjectTrusted: () => true,
      } as unknown as ExtensionContext);
      await runtime.initialize();
      await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      const scripted = factory.runtimes.get("W-001");
      if (!create || !scripted) throw new Error("scripted Worker was not created");

      await runtime.pauseProject();
      expect(scripted.steering[0]).toContain("safe pause");
      expect((await runtime.store.read()).workers["W-001"]?.status).toBe("pause_requested");
      await create.callbacks.progress({ summary: "Paused despite TUI failure.", state: "paused" });
      scripted.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("paused");
      await runtime.resumeProject();
      await runtime.workers.resume("W-001");
      await runtime.workers.abort("W-001", "verify UI isolation");
      expect(scripted.aborted).toBe(true);
      expect((await runtime.store.read()).workers["W-001"]?.status).toBe("interrupted");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("keeps safe pause and emergency abort effective when activity logging is broken", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      const scripted = factory.runtimes.get("W-001");
      if (!create || !scripted) throw new Error("scripted Worker was not created");

      await rm(runtime.activity.path, { force: true });
      await mkdir(runtime.activity.path);
      await runtime.pauseProject();
      expect(scripted.steering[0]).toContain("safe pause");
      await create.callbacks.progress({ summary: "Paused with unavailable diagnostics.", state: "paused" });
      scripted.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("paused");
      await runtime.resumeProject();
      await runtime.workers.resume("W-001");
      await runtime.workers.abort("W-001", "diagnostic failure must not gate abort");

      expect(scripted.aborted).toBe(true);
      expect((await runtime.store.read()).workers["W-001"]?.status).toBe("interrupted");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("defaults to untrusted and does not start Worker tools when the host marks the project untrusted", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory });
    try {
      await runtime.initialize();
      await expect(runtime.createWork(CONTRACT)).rejects.toThrow("has not trusted this project");
      await runtime.onSessionStart({
        cwd: fixture.repo,
        ui: { setWidget() {}, setStatus() {} },
        isProjectTrusted: () => false,
      } as unknown as ExtensionContext);
      await expect(runtime.createWork(CONTRACT)).rejects.toThrow("has not trusted this project");
      expect(factory.creates).toHaveLength(0);
      expect(Object.keys((await runtime.store.read()).workers)).toEqual([]);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("blocks a session cwd that differs from the runtime project root", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(), projectTrusted: true,
    });
    try {
      await expect(runtime.onSessionStart({
        cwd: fixture.root,
        ui: { setWidget() {}, setStatus() {} },
        isProjectTrusted: () => true,
      } as unknown as ExtensionContext)).rejects.toThrow("does not match the loaded project root");
      expect(await runtime.store.exists()).toBe(false);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("retries a safe-pause delivery after a transient steering failure", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      await runtime.createWork(CONTRACT);
      const scripted = factory.runtimes.get("W-001");
      if (!scripted) throw new Error("scripted Worker was not created");
      const steer = scripted.steer.bind(scripted);
      let attempts = 0;
      scripted.steer = async (message: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient steer failure");
        await steer(message);
      };

      await expect(runtime.workers.requestPause("W-001")).rejects.toThrow("transient steer failure");
      expect((await runtime.store.read()).workers["W-001"]?.status).toBe("pause_requested");
      await runtime.workers.requestPause("W-001");
      expect(attempts).toBe(2);
      expect(scripted.steering.at(-1)).toContain("safe pause");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("forcibly disposes a runtime whose emergency abort reports an error", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      const scripted = factory.runtimes.get("W-001");
      if (!create || !scripted) throw new Error("scripted Worker was not created");
      scripted.abort = async () => { throw new Error("abort transport failed"); };

      await expect(runtime.workers.abort("W-001", "stop now")).rejects.toThrow("forcibly disposed");
      expect(scripted.disposed).toBe(true);
      expect((await runtime.store.read()).workers["W-001"]?.status).toBe("interrupted");
      await expect(create.callbacks.progress({ summary: "late progress" })).rejects.toThrow("stale or disposed");

      const resumed = await runtime.workers.resume("W-001");
      expect(resumed.status).toBe("working");
      expect(factory.restores).toHaveLength(1);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("keeps resume behind an in-flight emergency abort until the old runtime is detached", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: factory,
      projectTrusted: true,
    });
    let releaseAbort!: () => void;
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    let abortEntered!: () => void;
    const entered = new Promise<void>((resolve) => { abortEntered = resolve; });
    try {
      await runtime.initialize();
      await runtime.createWork(CONTRACT);
      const scripted = factory.runtimes.get("W-001");
      if (!scripted) throw new Error("scripted Worker was not created");
      scripted.abort = async () => {
        abortEntered();
        await abortGate;
        scripted.aborted = true;
      };

      const aborting = runtime.workers.abort("W-001", "preempt the current turn");
      await entered;
      await expect(runtime.workers.resume("W-001")).rejects.toThrow("abort in progress");
      expect(scripted.disposed).toBe(false);
      releaseAbort();
      await aborting;
      expect(scripted.disposed).toBe(true);
      expect((await runtime.store.read()).workers["W-001"]?.status).toBe("interrupted");

      const resumed = await runtime.workers.resume("W-001");
      expect(resumed.status).toBe("working");
      expect(factory.restores).toHaveLength(1);
    } finally {
      releaseAbort();
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("prevents an old in-flight create from disposing or failing a reactivated session", async () => {
    const fixture = await createTempRepository();
    const factory = new FirstCreateOnlyDelayedFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      const oldCreate = runtime.createWork(CONTRACT);
      const oldCreateRejected = expect(oldCreate).rejects.toThrow("Intentum Worker manager disposed");
      await factory.firstCreateEntered;

      await runtime.dispose();
      await runtime.onSessionStart({
        cwd: fixture.repo,
        ui: { setWidget() {}, setStatus() {} },
        isProjectTrusted: () => true,
      } as unknown as ExtensionContext);
      expect((await runtime.store.read()).workers["W-001"]?.status).toBe("interrupted");

      const resumed = await runtime.workers.resume("W-001");
      expect(resumed.status).toBe("working");
      const resumedRuntime = factory.runtimes.get("W-001");
      const resumedCreate = factory.creates[0];
      if (!resumedRuntime || !resumedCreate) throw new Error("reactivated runtime was not created");

      factory.releaseFirstCreate();
      await oldCreateRejected;
      expect(resumedRuntime.disposed).toBe(false);
      await resumedCreate.callbacks.progress({ summary: "new generation remains healthy" });
      expect((await runtime.store.read()).workers["W-001"]).toMatchObject({
        status: "working",
        progressSummary: "new generation remains healthy",
      });
    } finally {
      factory.releaseFirstCreate();
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("coordinates two runtimes so only one can reserve W-001", async () => {
    const fixture = await createTempRepository();
    const firstFactory = new ScriptedWorkerFactory();
    const secondFactory = new ScriptedWorkerFactory();
    const first = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: firstFactory, projectTrusted: true });
    const second = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: secondFactory, projectTrusted: true });
    try {
      await first.initialize();
      const outcomes = await Promise.allSettled([first.createWork(CONTRACT), second.createWork(CONTRACT)]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expect(firstFactory.creates.length + secondFactory.creates.length).toBe(1);
      expect(Object.keys((await first.store.read()).workers)).toEqual(["W-001"]);
      expect((await first.store.read()).workers["W-001"]?.status).toBe("working");
    } finally {
      await first.dispose();
      await second.dispose();
      await fixture.cleanup();
    }
  });

  it("keeps a second live controller from recovering or controlling the owner's Worker", async () => {
    const fixture = await createTempRepository();
    const ownerFactory = new ScriptedWorkerFactory();
    const contenderFactory = new ScriptedWorkerFactory();
    const owner = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: ownerFactory,
      projectTrusted: true,
    });
    const contender = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: contenderFactory,
      projectTrusted: true,
    });
    try {
      await owner.initialize();
      await owner.createWork(CONTRACT);
      const live = ownerFactory.runtimes.get("W-001");
      if (!live) throw new Error("owner Worker was not created");

      await expect(contender.onSessionStart({
        cwd: fixture.repo,
        ui: { setWidget() {}, setStatus() {} },
        isProjectTrusted: () => true,
      } as unknown as ExtensionContext)).rejects.toThrow("another live Intentum controller");
      await expect(contender.workers.abort("W-001", "contender must not interrupt owner"))
        .rejects.toThrow("another live Intentum controller");

      expect(live.aborted).toBe(false);
      expect((await owner.store.read()).workers["W-001"]?.status).toBe("working");
      expect(contenderFactory.creates).toHaveLength(0);
      expect(contenderFactory.restores).toHaveLength(0);
    } finally {
      await contender.dispose();
      await owner.dispose();
      await fixture.cleanup();
    }
  });

  it("releases a controller lease acquired while the waiting runtime is being disposed", async () => {
    const fixture = await createTempRepository();
    const owner = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    const contender = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    let successor: IntentumRuntime | undefined;
    try {
      await owner.initialize();
      const initializing = contender.initialize();
      const rejected = expect(initializing).rejects.toThrow("another live Intentum controller");
      await delay(40);
      const disposing = contender.dispose();
      await owner.dispose();
      await disposing;
      await rejected;

      successor = new IntentumRuntime(fixture.repo, {
        cacheRoot: fixture.cache,
        workerRuntimeFactory: new ScriptedWorkerFactory(),
        projectTrusted: true,
      });
      await expect(successor.initialize()).resolves.toMatchObject({ created: false });
    } finally {
      await successor?.dispose();
      await contender.dispose();
      await owner.dispose();
      await fixture.cleanup();
    }
  });

  it("drains a durable artifact mutation before handing the controller lease to another runtime", async () => {
    const fixture = await createTempRepository();
    const owner = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    const successor = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    try {
      await owner.initialize();
      const originalWrite = owner.store.writeArtifact.bind(owner.store);
      let enteredWrite!: () => void;
      const writeEntered = new Promise<void>((resolve) => { enteredWrite = resolve; });
      Object.defineProperty(owner.store, "writeArtifact", {
        value: async (...args: Parameters<typeof owner.store.writeArtifact>) => {
          enteredWrite();
          await writeGate;
          return originalWrite(...args);
        },
      });

      const staleWrite = owner.writeArtifact("charter", "# Charter\n\nOwner mutation drains first.\n");
      await writeEntered;
      const disposing = owner.dispose();
      let successorStarted = false;
      const startingSuccessor = successor.onSessionStart({
        cwd: fixture.repo,
        ui: { setWidget() {}, setStatus() {} },
        isProjectTrusted: () => true,
      } as unknown as ExtensionContext).then(() => { successorStarted = true; });
      await delay(40);
      expect(successorStarted).toBe(false);

      releaseWrite();
      await Promise.all([staleWrite, disposing, startingSuccessor]);
      await successor.writeArtifact("charter", "# Charter\n\nSuccessor mutation is authoritative.\n");
      expect(await successor.readArtifact("charter")).toContain("Successor mutation is authoritative");
    } finally {
      releaseWrite();
      await successor.dispose();
      await owner.dispose();
      await fixture.cleanup();
    }
  });

  it("rejects a recoverable worktree path swapped to another repository inside the cache", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, { cacheRoot: fixture.cache, workerRuntimeFactory: factory, projectTrusted: true });
    try {
      await runtime.initialize();
      await runtime.createWork(CONTRACT);
      await runtime.workers.abort("W-001", "prepare identity check");

      const other = join(fixture.cache, "other-repository");
      await mkdir(other);
      await runFile("git", ["init", "-b", "main"], other);
      await runFile("git", ["config", "user.name", "intentum tests"], other);
      await runFile("git", ["config", "user.email", "intentum@example.invalid"], other);
      await writeFile(join(other, "file.txt"), "other\n", "utf8");
      await runFile("git", ["add", "file.txt"], other);
      await runFile("git", ["commit", "-m", "other"], other);
      await runtime.store.update((state) => ({
        ...state,
        workers: {
          ...state.workers,
          "W-001": { ...state.workers["W-001"]!, worktreePath: other },
        },
      }));

      await expect(runtime.workers.resume("W-001")).rejects.toThrow("single-Worker slot was released");
      expect(factory.restores).toHaveLength(0);
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("failed");
      const replacement = await runtime.createWork({ ...CONTRACT, featureId: "F-002" });
      expect(replacement.id).toBe("W-002");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("rejects a replaced canonical worktree during completion identity verification", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: factory,
      projectTrusted: true,
    });
    try {
      await runtime.initialize();
      const worker = await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      if (!create || !worker.worktreePath || !worker.branch) throw new Error("scripted Worker was not created");
      await writeFile(join(worker.worktreePath, "outcome.txt"), "safe outcome\n", "utf8");
      await runFile("git", ["add", "outcome.txt"], worker.worktreePath);
      await runFile("git", ["commit", "-m", "feat: candidate"], worker.worktreePath);
      const resultCommit = (await runFile("git", ["rev-parse", "HEAD"], worker.worktreePath)).stdout;
      await replaceRegisteredWorktree(fixture.repo, fixture.root, worker.worktreePath, worker.branch, resultCommit);

      await expect(create.callbacks.complete(completedResult(["outcome.txt"]))).rejects.toThrow("not a registered worktree");
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("working");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("revalidates canonical worktree identity immediately before integration", async () => {
    const fixture = await createTempRepository();
    const factory = new ScriptedWorkerFactory();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: factory,
      projectTrusted: true,
    });
    try {
      await runtime.initialize();
      const worker = await runtime.createWork(CONTRACT);
      const create = factory.creates[0];
      const scripted = factory.runtimes.get("W-001");
      if (!create || !scripted || !worker.worktreePath || !worker.branch) {
        throw new Error("scripted Worker was not created");
      }
      await writeFile(join(worker.worktreePath, "outcome.txt"), "safe outcome\n", "utf8");
      await runFile("git", ["add", "outcome.txt"], worker.worktreePath);
      await runFile("git", ["commit", "-m", "feat: candidate"], worker.worktreePath);
      await create.callbacks.complete(completedResult(["outcome.txt"]));
      scripted.emit({ type: "settled" });
      await expect.poll(async () => (await runtime.workers.inspect("W-001")).worker.status).toBe("completed");
      const resultCommit = (await runtime.workers.inspect("W-001")).worker.resultCommit;
      if (!resultCommit) throw new Error("missing result commit");

      await replaceRegisteredWorktree(fixture.repo, fixture.root, worker.worktreePath, worker.branch, resultCommit);
      await expect(runtime.workers.integrateWorker("W-001")).rejects.toThrow("not a registered worktree");
      expect((await runtime.workers.inspect("W-001")).worker.status).toBe("completed");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });
});

function completedResult(filesChanged: string[]) {
  return {
    status: "completed" as const,
    summary: "The safety fixture is complete.",
    userVisibleChanges: ["Added the outcome."],
    filesChanged,
    testsRun: [],
    architectureConcerns: [],
    remainingRisks: [],
    suggestedFollowUps: [],
  };
}

async function replaceRegisteredWorktree(
  projectRoot: string,
  commandRoot: string,
  worktreePath: string,
  branch: string,
  resultCommit: string,
): Promise<void> {
  await runFile("git", ["worktree", "remove", "--force", worktreePath], projectRoot);
  await runFile("git", ["clone", "--no-checkout", projectRoot, worktreePath], commandRoot);
  await runFile("git", ["checkout", "-b", branch, resultCommit], worktreePath);
}

class DelayedCreateFactory extends ScriptedWorkerFactory {
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private entered!: () => void;
  readonly createEntered = new Promise<void>((resolve) => {
    this.entered = resolve;
  });

  releaseCreate(): void {
    this.release();
  }

  override async create(input: CreateWorkerRuntimeInput): Promise<WorkerRuntime> {
    this.entered();
    await this.gate;
    return super.create(input);
  }
}

class FirstCreateOnlyDelayedFactory extends ScriptedWorkerFactory {
  private calls = 0;
  private release!: () => void;
  private readonly firstGate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private entered!: () => void;
  readonly firstCreateEntered = new Promise<void>((resolve) => {
    this.entered = resolve;
  });

  releaseFirstCreate(): void {
    this.release();
  }

  override async create(input: CreateWorkerRuntimeInput): Promise<WorkerRuntime> {
    this.calls += 1;
    if (this.calls === 1) {
      this.entered();
      await this.firstGate;
    }
    return super.create(input);
  }
}
