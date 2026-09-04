import { describe, expect, it } from "vitest";
import type { ProjectState, WorkerRecord, WorkerStatus } from "../src/state/schema.js";
import {
  deriveHarnessPresentation,
  phasePresentation,
  summarizeWorkers,
  workerStatusPresentation,
} from "../src/tui/presentation.js";

describe("HarnessPresentationModel", () => {
  it("derives phase neighbors and the single next action", () => {
    const model = deriveHarnessPresentation(state({
      phase: "build",
      workers: { "W-001": worker("W-001", "completed") },
    }));
    expect(model.phase).toMatchObject({ current: "build", index: 4, total: 8, previous: "architecture", next: "verify" });
    expect(model.nextStep).toBe("Review W-001's result and integrate it when the evidence is sufficient.");
    expect(model.primaryAction).toEqual({ kind: "review-worker", label: "Review result", workerId: "W-001" });
    expect(model.severity).toBe("review");
  });

  it("puts blocking decisions ahead of failures and completed work", () => {
    const project = state({
      workers: {
        "W-001": worker("W-001", "completed"),
        "W-002": worker("W-002", "failed"),
      },
      pendingDecisions: [{
        id: "D-001",
        title: "Authentication",
        question: "Which method?",
        blocking: true,
        affectedWorkIds: ["W-002"],
        options: [
          { id: "a", label: "A", consequence: "A" },
          { id: "b", label: "B", consequence: "B" },
        ],
      }],
    });
    const model = deriveHarnessPresentation(project);
    expect(model.nextStep).toBe("Answer decision D-001 so blocked work can continue.");
    expect(model.primaryAction).toEqual({ kind: "open-decision", label: "Answer decision", decisionId: "D-001" });
    expect(model.severity).toBe("error");
  });

  it("puts failed work ahead of a completed result when no decision blocks", () => {
    const model = deriveHarnessPresentation(state({
      workers: {
        "W-001": worker("W-001", "completed"),
        "W-002": worker("W-002", "failed"),
      },
    }));
    expect(model.nextStep).toBe("W-002 failed. Inspect the evidence before retrying or replacing the work.");
    expect(model.primaryAction).toEqual({ kind: "open-worker", label: "Inspect Worker", workerId: "W-002" });
  });

  it("keeps paused neutral and separates it from attention", () => {
    const paused = worker("W-001", "paused");
    const blocked = worker("W-002", "blocked");
    const summary = summarizeWorkers([paused, blocked]);
    expect(summary.paused).toEqual([paused]);
    expect(summary.attention).toEqual([blocked]);
    expect(workerStatusPresentation("paused")).toMatchObject({ label: "Paused", tone: "neutral" });
    expect(workerStatusPresentation("blocked")).toMatchObject({ label: "Blocked", tone: "warning" });
    expect(workerStatusPresentation("failed")).toMatchObject({ label: "Failed", tone: "error" });
    expect(workerStatusPresentation("verifying")).toMatchObject({ label: "Verifying", tone: "progress" });
    expect(workerStatusPresentation("completed")).toMatchObject({ label: "Ready for review", tone: "review" });
  });

  it("shows the phase a paused project resumes into", () => {
    const project = state({
      phase: "paused",
      phaseBeforePause: "verify",
      schedulerPaused: true,
      workers: { "W-001": worker("W-001", "completed") },
    });
    expect(phasePresentation(project)).toMatchObject({ current: "verify", paused: true, index: 5, label: "PAUSED (verify 5/8)" });
    expect(deriveHarnessPresentation(project).primaryAction).toEqual({ kind: "resume-project", label: "Resume project" });
  });
});

function state(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    schemaVersion: 1,
    projectId: "fixture",
    projectName: "Fixture",
    phase: "discovery",
    autonomy: "guided",
    workers: {},
    pendingDecisions: [],
    schedulerPaused: false,
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

function worker(id: string, status: WorkerStatus): WorkerRecord {
  return { id, kind: "implementation", status, objective: `${id} objective`, updatedAt: "2026-09-04T00:00:00.000Z" };
}
