import { describe, expect, it } from "vitest";
import type { ProjectState, WorkerRecord } from "../src/state/schema.js";
import { renderStatusBrief, renderStatusText, renderStatusWidget } from "../src/tui/status-widget.js";

describe("intentum attention widget", () => {
  it("renders nothing for an idle project, leaving the editor uncluttered", () => {
    expect(renderStatusWidget(projectState())).toEqual([]);
    const integrated = projectState();
    integrated.workers["W-001"] = worker({ id: "W-001", status: "integrated", objective: "Account creation" });
    expect(renderStatusWidget(integrated)).toEqual([]);
  });

  it("surfaces only results, risks, and the blocking decision", () => {
    const lines = renderStatusWidget(busyState());
    expect(lines).toEqual([
      "✓ W-001 Account creation — ready to integrate",
      "⚠ W-004 blocked: Needs decision D-004 before layout work continues.",
      "◆ Decision required: Authentication method",
    ]);
    expect(lines.join("\n")).not.toMatch(/#{4}|@{2}|o{2}|intentum|\/intentum/);
  });

  it("collapses multi-line blockers into one bounded line", () => {
    const state = busyState();
    const blocked = state.workers["W-004"];
    if (!blocked) throw new Error("fixture missing W-004");
    blocked.blocker = `first line\n\tsecond\r\n${"x".repeat(200)}`;
    const risk = renderStatusWidget(state).find((line) => line.startsWith("⚠ W-004"));
    expect(risk).toBeDefined();
    expect(risk).not.toMatch(/[\r\n\t]/);
    expect(risk?.length).toBeLessThanOrEqual("⚠ W-004 blocked: ".length + 96);
    expect(risk?.endsWith("…")).toBe(true);
  });

  it("shows the paused phase with the phase it will resume into", () => {
    const state = busyState();
    state.phase = "paused";
    state.phaseBeforePause = "build";
    state.schedulerPaused = true;
    expect(renderStatusBrief(state).split("\n")[0]).toBe(
      "Fixture Product · PAUSED (build 4/8) · Feature: F-002 · autonomy balanced",
    );
  });

  it("only styles lines when color is requested", () => {
    const plain = renderStatusWidget(busyState());
    const colored = renderStatusWidget(busyState(), { color: true });
    expect(plain.join("\n")).not.toContain("\u001b[");
    expect(colored.join("\n")).toContain("\u001b[32m✓ W-001");
    expect(colored.join("\n")).toContain("\u001b[31m⚠ W-004");
    expect(colored.join("\n")).toContain("\u001b[33m◆ Decision required");
    expect(colored.map(stripAnsi)).toEqual(plain);
  });

  it("keeps the notification status to a few plain lines", () => {
    const empty = renderStatusBrief(projectState()).split("\n");
    expect(empty[0]).toBe("Fixture Product · DISCOVERY 1/8 · Feature: none yet · autonomy guided");
    expect(empty).toHaveLength(2);

    const busy = renderStatusBrief(busyState());
    expect(busy).toContain("⚠ W-004 blocked:");
    expect(busy).toContain("◆ Decision required: Authentication method");
    expect(busy).not.toContain("\u001b[");
    expect(busy).not.toContain("/intentum");
    expect(busy.split("\n").length).toBeLessThanOrEqual(5);
  });

  it("keeps the textual status complete for non-TUI hosts", () => {
    const text = renderStatusText(busyState());
    expect(text).toContain("Phase: build 4/8");
    expect(text).toContain("- W-004 blocked: Needs decision D-004 before layout work continues.");
    expect(text).toContain("- D-004 blocking: Authentication method");
  });
});

function stripAnsi(value: string): string {
  return value.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function projectState(): ProjectState {
  return {
    schemaVersion: 1,
    projectId: "fixture",
    projectName: "Fixture Product",
    phase: "discovery",
    autonomy: "guided",
    workers: {},
    pendingDecisions: [],
    schedulerPaused: false,
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function worker(record: Pick<WorkerRecord, "id" | "status" | "objective"> & Partial<WorkerRecord>): WorkerRecord {
  return { kind: "implementation", updatedAt: "2026-09-03T00:00:00.000Z", ...record };
}

function busyState(): ProjectState {
  return {
    ...projectState(),
    phase: "build",
    autonomy: "balanced",
    activeFeatureId: "F-002",
    workers: {
      "W-001": worker({ id: "W-001", status: "completed", objective: "Account creation", updatedAt: "2026-09-03T01:00:00.000Z" }),
      "W-002": worker({ id: "W-002", status: "working", objective: "Session restore", updatedAt: "2026-09-03T02:00:00.000Z" }),
      "W-003": worker({ id: "W-003", status: "verifying", objective: "Dashboard shell", updatedAt: "2026-09-03T03:00:00.000Z" }),
      "W-004": worker({
        id: "W-004",
        status: "blocked",
        kind: "fix",
        objective: "Mobile navigation",
        blocker: "Needs decision D-004 before layout work continues.",
        updatedAt: "2026-09-03T04:00:00.000Z",
      }),
    },
    pendingDecisions: [{
      id: "D-004",
      title: "Authentication method",
      question: "Which login method should the first version use?",
      blocking: true,
      affectedWorkIds: ["W-002", "W-004"],
      options: [
        { id: "magic", label: "Magic link", consequence: "Easier onboarding, depends on email delivery." },
        { id: "password", label: "Password", consequence: "Familiar, but adds reset flows." },
      ],
      recommendation: { optionId: "magic", reason: "The product prioritizes low-friction first use." },
    }],
  };
}
