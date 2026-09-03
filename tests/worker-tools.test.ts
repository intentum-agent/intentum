import { describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import { createWorkerTools } from "../src/runtime/worker-tools.js";
import { assertWorkerResultInput } from "../src/work/result.js";

describe("Worker tool termination semantics", () => {
  it("terminates safe-pause acknowledgement, escalation, and completion", async () => {
    const callbacks = {
      commit: vi.fn(async () => ({ commit: "a".repeat(40), files: ["src/change.ts"] })),
      progress: vi.fn(async () => undefined),
      escalate: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
    };
    const tools = createWorkerTools(callbacks);
    const commit = requireTool(tools, "intentum_commit");
    const progress = requireTool(tools, "intentum_progress");
    const escalate = requireTool(tools, "intentum_escalate");
    const complete = requireTool(tools, "intentum_complete");
    const signal = new AbortController().signal;

    expect((await commit.execute("commit", { message: "feat: finish work" }, signal, () => undefined, {} as never)).terminate).toBe(false);
    expect((await progress.execute("working", { summary: "milestone", state: "working" }, signal, () => undefined, {} as never)).terminate).toBe(false);
    expect((await progress.execute("paused", { summary: "safe boundary", state: "paused" }, signal, () => undefined, {} as never)).terminate).toBe(true);
    expect((await escalate.execute("escalate", { kind: "blocker", summary: "blocked" }, signal, () => undefined, {} as never)).terminate).toBe(true);
    expect((await complete.execute("complete", {
      status: "failed",
      summary: "failed factually",
      userVisibleChanges: [],
      filesChanged: [],
      testsRun: [],
      architectureConcerns: [],
      remainingRisks: [],
      suggestedFollowUps: [],
    }, signal, () => undefined, {} as never)).terminate).toBe(true);
  });

  it("rejects undeclared tool fields and forged result metadata", () => {
    const tools = createWorkerTools({
      commit: vi.fn(async () => ({ commit: "a".repeat(40), files: [] })),
      progress: vi.fn(async () => undefined),
      escalate: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
    });
    const complete = requireTool(tools, "intentum_complete");
    const forged = {
      status: "blocked",
      summary: "blocked factually",
      userVisibleChanges: [],
      filesChanged: [],
      testsRun: [],
      architectureConcerns: [],
      remainingRisks: [],
      suggestedFollowUps: [],
      resultCommit: "forged",
    };
    expect(Check(complete.parameters, forged)).toBe(false);
    expect(() => assertWorkerResultInput(forged)).toThrow("unexpected field(s): resultCommit");
  });
});

function requireTool(tools: ReturnType<typeof createWorkerTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}
