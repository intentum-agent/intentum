import { visibleWidth } from "@earendil-works/pi-tui";
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
      "◆ Decision required · Authentication method",
      "⚠ W-004 Blocked · Needs decision D-004 before layout work continues.",
      "✓ W-001 Ready for review · Account creation",
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
    expect(visibleWidth(risk ?? "")).toBeLessThanOrEqual(visibleWidth("⚠ W-004 Blocked · ") + 96);
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

  it("accepts host-theme styling and never manufactures ANSI", () => {
    const plain = renderStatusWidget(busyState());
    const themed = renderStatusWidget(busyState(), {
      style: {
        neutral: (text) => `<neutral>${text}</neutral>`,
        progress: (text) => `<progress>${text}</progress>`,
        review: (text) => `<review>${text}</review>`,
        warning: (text) => `<warning>${text}</warning>`,
        error: (text) => `<error>${text}</error>`,
      },
    });
    expect(plain.join("\n")).not.toContain("\u001b[");
    expect(themed).toEqual([
      "<warning>◆ Decision required · Authentication method</warning>",
      "<warning>⚠ W-004 Blocked · Needs decision D-004 before layout work continues.</warning>",
      "<review>✓ W-001 Ready for review · Account creation</review>",
    ]);
    expect(themed.join("\n")).not.toContain("\u001b[");
  });

  it("keeps the notification status to a few plain lines", () => {
    const empty = renderStatusBrief(projectState()).split("\n");
    expect(empty[0]).toBe("Fixture Product · DISCOVERY 1/8 · Feature: none yet · autonomy guided");
    expect(empty).toHaveLength(2);

    const busy = renderStatusBrief(busyState());
    expect(busy).toContain("⚠ W-004 Blocked ·");
    expect(busy).toContain("◆ Decision required · Authentication method");
    expect(busy).not.toContain("\u001b[");
    expect(busy).not.toContain("/intentum");
    expect(busy.split("\n").length).toBeLessThanOrEqual(5);
  });

  it("keeps the textual status complete for non-TUI hosts", () => {
    const text = renderStatusText(busyState());
    expect(text).toContain("Phase: BUILD 4/8");
    expect(text).toContain("- W-004 Blocked: Needs decision D-004 before layout work continues.");
    expect(text).toContain("- D-004 Blocking: Authentication method");
  });

  it("clips CJK and emoji by terminal cells", () => {
    const state = busyState();
    const blocked = state.workers["W-004"];
    if (!blocked) throw new Error("fixture missing W-004");
    blocked.blocker = "移动端导航 👨‍👩‍👧‍👦 需要产品决定";
    const lines = renderStatusWidget(state, { width: 32 });
    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
    expect(lines.join("\n")).toContain("👨‍👩‍👧‍👦");
  });

  it("keeps repository-authored project and feature text on safe plain lines", () => {
    const state = projectState();
    state.projectName = "\u001b[31mProject\u001b[0m\nInjected";
    state.activeFeatureId = "F-001\nInjected";
    const brief = renderStatusBrief(state);
    expect(brief.split("\n")[0]).toBe("Project Injected · DISCOVERY 1/8 · Feature: F-001 Injected · autonomy guided");
    expect(brief).not.toContain("\u001b");

    const complete = renderStatusText(state);
    expect(complete).toContain("Project: Project Injected");
    expect(complete).toContain("Active feature: F-001 Injected");
    expect(complete).not.toContain("\u001b");
  });
});

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
