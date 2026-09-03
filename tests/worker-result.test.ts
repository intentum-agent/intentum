import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import { assertWorkerResult, type WorkerResult } from "../src/work/result.js";
import type { NewWorkContract } from "../src/work/worker-manager.js";
import { createTempRepository } from "./helpers/temp-repo.js";
import { ScriptedWorkerFactory } from "./helpers/scripted-worker.js";

const RESULT: WorkerResult = {
  workId: "W-001",
  attemptId: "11111111-1111-4111-8111-111111111111",
  status: "completed",
  summary: "Validated result",
  userVisibleChanges: [],
  filesChanged: ["outcome.txt"],
  testsRun: [],
  architectureConcerns: [],
  remainingRisks: [],
  suggestedFollowUps: [],
  resultCommit: "a".repeat(40),
  recordedAt: "2026-09-03T00:00:00.000Z",
};

const CONTRACT: NewWorkContract = {
  featureId: "F-001",
  title: "Result validation fixture",
  objective: "Validate persisted Worker result invariants.",
  why: "Durable artifacts are an untrusted recovery boundary.",
  userVisibleResult: "Polluted result JSON is rejected.",
  scope: { inScope: ["result validation"], outOfScope: [] },
  interfaces: [],
  constraints: [],
  acceptanceCriteria: ["reject invalid result metadata"],
  dependencies: [],
  touchHints: [],
  risk: "low",
  preferredWorkerKind: "implementation",
  contextFiles: [],
};

describe("Worker result validation", () => {
  it("enforces exact Git OIDs, canonical timestamps, and status/commit invariants", () => {
    expect(() => assertWorkerResult(RESULT)).not.toThrow();
    expect(() => assertWorkerResult({ ...RESULT, resultCommit: "a".repeat(41) })).toThrow("Git object id");
    expect(() => assertWorkerResult({ ...RESULT, resultCommit: undefined })).toThrow("requires resultCommit");
    expect(() => assertWorkerResult({ ...RESULT, status: "blocked" })).toThrow("cannot contain resultCommit");
    expect(() => assertWorkerResult({ ...RESULT, recordedAt: "yesterday" })).toThrow("canonical ISO timestamp");
  });

  it("revalidates result.json during inspect instead of trusting durable metadata", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    try {
      await runtime.initialize();
      await runtime.createWork(CONTRACT);
      const runDir = join(fixture.repo, ".intentum", "runs", "W-001");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "result.json"), `${JSON.stringify({
        ...RESULT,
        status: "failed",
        resultCommit: "forged-extra-commit",
      })}\n`, "utf8");
      await expect(runtime.workers.inspect("W-001")).rejects.toThrow("Git object id");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });
});
