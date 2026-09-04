import { describe, expect, it } from "vitest";
import type { ProjectState, WorkerRecord } from "../src/state/schema.js";
import {
  centeredOverlayOrigin,
  IntentumControlPanel,
  parseMouseSequences,
  type PanelAction,
} from "../src/tui/control-panel.js";

const ESC = "\u001b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = "\r";
const ESCAPE = ESC;
const TAB = "\t";

describe("intentum control panel rendering", () => {
  it("frames every tab inside the requested width", () => {
    for (const tab of ["overview", "workers", "decisions", "help"] as const) {
      const panel = new IntentumControlPanel({ state: busyState(), onAction: () => {}, initialTab: tab });
      for (const width of [40, 60, 96, 140]) {
        const lines = panel.render(width);
        expect(lines.length).toBeGreaterThan(6);
        for (const line of lines) expect(visible(line).length, `${tab}@${width}: ${line}`).toBe(width);
      }
    }
  });

  it("leads the overview with the next step, phase trail, and the decision that blocks work", () => {
    const text = plain(new IntentumControlPanel({ state: busyState(), onAction: () => {} }).render(96));
    expect(text).toContain("⋗ intentum · Fixture Product");
    expect(text).toContain("BUILD 4/8");
    expect(text).toContain("Next     Answer decision D-004 so blocked work can continue.");
    expect(text).toContain("discovery › direction › architecture › build › verify › review › ship › maintain");
    expect(text).toContain("◆ Decision required · Authentication method  [Decide]");
    expect(text).toContain("✓ W-001 Account creation — ready to integrate  [Integrate]");
    expect(text).toContain("⚠ W-004 blocked: Needs decision D-004 before layout work continues.  [Open]");
    expect(text).toContain("[Pause project] [Workers] [Decisions] [Status text]");
    expect(text).toContain("↑↓ move · ⏎ act · tab switch · p pause/resume · esc close");
  });

  it("tells an empty project what to do next instead of showing an empty table", () => {
    const text = plain(new IntentumControlPanel({ state: projectState(), onAction: () => {}, initialTab: "workers" }).render(80));
    expect(text).toContain("No Worker yet. New work starts from conversation with the Designer.");
  });

  it("names the mouse limitation in fullscreen mode", () => {
    const fullscreen = new IntentumControlPanel({ state: busyState(), onAction: () => {}, mouse: "fullscreen" });
    expect(plain(fullscreen.render(100))).toContain("mouse: keyboard only in fullscreen");
    const available = new IntentumControlPanel({ state: busyState(), onAction: () => {}, mouse: "available" });
    expect(plain(available.render(100))).toContain("click or scroll");
  });

  it("scrolls a long body and reports what is hidden", () => {
    const state = busyState();
    for (let index = 5; index < 30; index += 1) {
      const id = `W-${String(index).padStart(3, "0")}`;
      state.workers[id] = worker({ id, status: "queued", objective: `Queued outcome ${index}` });
    }
    const panel = new IntentumControlPanel({ state, onAction: () => {}, initialTab: "workers", bodyHeight: 8 });
    const first = plain(panel.render(90));
    expect(first).toMatch(/… \d+ more below/);
    panel.handleWheel(1);
    const scrolled = plain(panel.render(90));
    expect(scrolled).toMatch(/… \d+ more above/);
  });
});

describe("intentum control panel keyboard", () => {
  it("moves focus with arrows and activates with enter", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state: busyState(), onAction: (action) => actions.push(action) });
    panel.render(96);
    expect(panel.focusedControlId).toBe("overview:decide:D-004");
    panel.handleInput(DOWN);
    expect(panel.focusedControlId).toBe("overview:integrate:W-001");
    panel.handleInput(ENTER);
    expect(actions).toEqual([{ type: "integrate", workerId: "W-001" }]);
    panel.handleInput(UP);
    panel.handleInput(UP);
    expect(panel.focusedControlId).toBe("overview:status");
  });

  it("switches tabs with tab, digits, and question mark", () => {
    const panel = new IntentumControlPanel({ state: busyState(), onAction: () => {} });
    panel.handleInput(TAB);
    expect(panel.activeTab).toBe("workers");
    panel.handleInput("3");
    expect(panel.activeTab).toBe("decisions");
    panel.handleInput("?");
    expect(panel.activeTab).toBe("help");
    panel.handleInput(`${ESC}[Z`);
    expect(panel.activeTab).toBe("decisions");
  });

  it("closes on escape, q, and ctrl+c and toggles the project with p", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state: busyState(), onAction: (action) => actions.push(action) });
    panel.handleInput(ESCAPE);
    panel.handleInput("q");
    panel.handleInput("\u0003");
    panel.handleInput("p");
    expect(actions).toEqual([{ type: "close" }, { type: "close" }, { type: "close" }, { type: "pause-project" }]);

    const paused = busyState();
    paused.phase = "paused";
    paused.phaseBeforePause = "build";
    paused.schedulerPaused = true;
    const resumed: PanelAction[] = [];
    new IntentumControlPanel({ state: paused, onAction: (action) => resumed.push(action) }).handleInput("p");
    expect(resumed).toEqual([{ type: "resume-project" }]);
  });

  it("offers each Worker only the operations its status allows", () => {
    const panel = new IntentumControlPanel({ state: busyState(), onAction: () => {}, initialTab: "workers" });
    const blocked = plain(panel.render(100));
    expect(blocked).toContain("▸ W-004");
    expect(blocked).toContain("[Resume] [Queue instruction] [Details]");
    expect(blocked).not.toContain("[Integrate]");

    for (let step = 0; step < 5; step += 1) panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    expect(panel.selectedWorker).toBe("W-002");
    const working = plain(panel.render(100));
    expect(working).toContain("[Steer] [Pause] [Abort] [Details]");
    expect(working).toContain("Core API complete; implementing session restore.");
  });

  it("expands debug details only on request", () => {
    const panel = new IntentumControlPanel({ state: busyState(), onAction: () => {}, initialTab: "workers" });
    expect(plain(panel.render(100))).not.toContain("intentum/W-004");
    panel.handleInput("\u001b[F");
    expect(panel.focusedControlId).toBe("worker:W-001");
    panel.handleInput("\u001b[H");
    expect(panel.focusedControlId).toBe("worker:W-004");
    for (let step = 0; step < 3; step += 1) panel.handleInput(DOWN);
    expect(panel.focusedControlId).toBe("worker:W-004:details");
    panel.handleInput(ENTER);
    const expanded = plain(panel.render(100));
    expect(expanded).toContain("branch    intentum/W-004 → main");
    expect(expanded).toContain("[Hide details]");
  });

  it("drafts decisions instead of resolving them", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state: busyState(), onAction: (action) => actions.push(action), initialTab: "decisions" });
    const text = plain(panel.render(100));
    expect(text).toContain("[Choose A] Magic link — Easier onboarding, depends on email delivery.");
    expect(text).toContain("Designer recommends Magic link: The product prioritizes low-friction first use.");
    expect(text).toContain("Affects W-002, W-004  [Discuss in chat]");
    panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    expect(actions).toEqual([
      { type: "decide", decisionId: "D-004", optionId: "magic" },
      { type: "discuss", decisionId: "D-004" },
    ]);
  });

  it("ignores input while suspended", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state: busyState(), onAction: (action) => actions.push(action) });
    panel.setSuspended(true);
    panel.handleInput(ESCAPE);
    panel.render(80);
    expect(panel.handleClick(1, 1)).toBe(true);
    expect(actions).toEqual([]);
  });
});

describe("intentum control panel mouse", () => {
  it("activates the control under the pointer and reports clicks outside", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state: busyState(), onAction: (action) => actions.push(action) });
    const lines = panel.render(96).map(visible);
    const decideRow = lines.findIndex((line) => line.includes("[Decide]"));
    const decideCol = lines[decideRow]?.indexOf("[Decide]") ?? -1;
    expect(decideRow).toBeGreaterThan(0);

    expect(panel.handleClick(decideCol + 2, decideRow)).toBe(true);
    expect(panel.activeTab).toBe("decisions");

    const tabsRow = 1;
    const workersCol = lines[tabsRow]?.indexOf("Workers") ?? -1;
    expect(panel.handleClick(workersCol, tabsRow)).toBe(true);
    expect(panel.activeTab).toBe("workers");

    const closeCol = lines[tabsRow]?.indexOf("✕") ?? -1;
    expect(panel.handleClick(closeCol, tabsRow)).toBe(true);
    expect(actions).toEqual([{ type: "close" }]);

    expect(panel.handleClick(-1, 3)).toBe(false);
    expect(panel.handleClick(5, panel.height + 2)).toBe(false);
  });

  it("selects a Worker row by click and keeps its buttons clickable after re-render", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state: busyState(), onAction: (action) => actions.push(action), initialTab: "workers" });
    let lines = panel.render(100).map(visible);
    const row = lines.findIndex((line) => line.includes("W-001"));
    panel.handleClick(4, row);
    expect(panel.selectedWorker).toBe("W-001");

    lines = panel.render(100).map(visible);
    const buttonRow = lines.findIndex((line) => line.includes("[Integrate]"));
    const buttonCol = lines[buttonRow]?.indexOf("[Integrate]") ?? -1;
    panel.handleClick(buttonCol + 1, buttonRow);
    expect(actions).toEqual([{ type: "integrate", workerId: "W-001" }]);
  });

  it("parses batched SGR reports and keeps the remaining input", () => {
    const parsed = parseMouseSequences(`${ESC}[<0;12;5M${ESC}[<0;12;5mx`);
    expect(parsed.events).toEqual([
      { button: 0, x: 11, y: 4, release: false },
      { button: 0, x: 11, y: 4, release: true },
    ]);
    expect(parsed.remainder).toBe("x");
    expect(parseMouseSequences("plain")).toEqual({ events: [], remainder: "plain" });
  });

  it("mirrors the centred overlay origin used by the Pi TUI", () => {
    expect(centeredOverlayOrigin({ columns: 120, rows: 40 }, { width: 96, height: 18 })).toEqual({
      width: 96,
      height: 18,
      row: 11,
      col: 12,
    });
    expect(centeredOverlayOrigin({ columns: 50, rows: 10 }, { width: 96, height: 18 })).toEqual({
      width: 50,
      height: 10,
      row: 0,
      col: 0,
    });
  });
});

function plain(lines: string[]): string {
  return lines.map(visible).join("\n");
}

function visible(value: string): string {
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
      "W-001": worker({
        id: "W-001",
        status: "completed",
        objective: "Account creation",
        branch: "intentum/W-001",
        targetBranch: "main",
        resultCommit: "0123456789abcdef",
        updatedAt: "2026-09-03T01:00:00.000Z",
      }),
      "W-002": worker({
        id: "W-002",
        status: "working",
        objective: "Session restore",
        progressSummary: "Core API complete; implementing session restore.",
        updatedAt: "2026-09-03T02:00:00.000Z",
      }),
      "W-003": worker({ id: "W-003", kind: "qa", status: "verifying", objective: "Dashboard shell", updatedAt: "2026-09-03T03:00:00.000Z" }),
      "W-004": worker({
        id: "W-004",
        status: "blocked",
        kind: "fix",
        objective: "Mobile navigation",
        blocker: "Needs decision D-004 before layout work continues.",
        branch: "intentum/W-004",
        targetBranch: "main",
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
