import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ProjectState, WorkerRecord, WorkerStatus } from "../src/state/schema.js";
import {
  centeredOverlayOrigin,
  IntentumControlPanel,
  parseMouseSequences,
  statusGlyph,
  type PanelAction,
  type PanelStyle,
} from "../src/tui/control-panel.js";

const ESC = "\u001b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = "\r";
const TAB = "\t";

describe("intentum control panel rendering", () => {
  it("frames compact, wide, and narrow layouts to the exact terminal-cell width", () => {
    for (const tab of ["overview", "workers", "decisions", "help"] as const) {
      const panel = new IntentumControlPanel({ state: busyState(), onAction: () => {}, initialTab: tab });
      for (const width of [40, 60, 80, 100, 120]) {
        const lines = panel.render(width);
        expect(lines.length).toBeGreaterThan(6);
        for (const line of lines) expect(visibleWidth(line), `${tab}@${width}: ${visible(line)}`).toBe(width);
      }
    }
  });

  it("orders the overview as next, attention/results, active work, then project context", () => {
    const text = plain(new IntentumControlPanel({
      state: busyState(),
      onAction: () => {},
      bodyHeight: 30,
    }).render(80));

    expect(text).toContain("⋗ intentum · Fixture Product");
    expect(text).toContain("BUILD 4/8");
    expect(text).toContain("Answer decision D-004 so blocked work can continue.");
    expect(text).toContain("Answer decision · Authentication method");
    expect(text).toContain("Decision required · ◆ D-004 · Authentication method");
    expect(text).toContain("Review result · ✓ W-001 · Account creation");
    expect(text).toContain("Resolve blocker · ⚠ W-004");
    expect(text).toContain("Verifying · ◐ W-003 · Dashboard shell");
    expect(text).toMatch(/architecture\s+›\s+BUILD\s+›\s+verify\s+·\s+4\/8/);
    expect(text).not.toMatch(/dis›dir|\[[A-Za-z ]+\]/);

    expect(text.indexOf("NEXT")).toBeLessThan(text.indexOf("ATTENTION & RESULTS"));
    expect(text.indexOf("ATTENTION & RESULTS")).toBeLessThan(text.indexOf("ACTIVE WORK"));
    expect(text.indexOf("ACTIVE WORK")).toBeLessThan(text.indexOf("PROJECT"));
    expect(text.indexOf("Resolve blocker")).toBeLessThan(text.indexOf("Review result · ✓ W-001"));
  });

  it("uses two information columns at 100 cells and one column below 100", () => {
    const wide = visibleLines(new IntentumControlPanel({ state: busyState(), onAction: () => {}, bodyHeight: 30 }).render(100));
    expect(wide.some((line) => line.includes("ATTENTION & RESULTS") && line.includes("│ ACTIVE WORK"))).toBe(true);

    const compact = visibleLines(new IntentumControlPanel({ state: busyState(), onAction: () => {}, bodyHeight: 30 }).render(80));
    expect(compact.some((line) => line.includes("ATTENTION & RESULTS") && line.includes("ACTIVE WORK"))).toBe(false);

    const heightConstrained = visibleLines(new IntentumControlPanel({
      state: busyState(),
      onAction: () => {},
      bodyHeight: 10,
      density: "compact",
    }).render(100));
    expect(heightConstrained.some((line) => line.includes("ATTENTION & RESULTS") && line.includes("ACTIVE WORK"))).toBe(false);
  });

  it("fills the body only when requested by a fullscreen host", () => {
    const regular = new IntentumControlPanel({ state: projectState(), onAction: () => {}, initialTab: "help", bodyHeight: 20 });
    const fullscreen = new IntentumControlPanel({ state: projectState(), onAction: () => {}, initialTab: "help", bodyHeight: 20, fillBody: true });
    expect(fullscreen.render(80)).toHaveLength(26);
    expect(regular.render(80).length).toBeLessThan(26);

    regular.setFillBody(true);
    expect(regular.render(80)).toHaveLength(26);
  });

  it("keeps CJK and emoji content cell-safe at every supported width", () => {
    const state = busyState();
    state.projectName = "意图工作台 🧑🏽‍💻";
    state.workers["W-002"]!.objective = "优化移动导航 👨‍👩‍👧‍👦 并保持中文字符完整";
    for (const width of [40, 60, 80, 100, 120]) {
      const lines = new IntentumControlPanel({ state, onAction: () => {}, initialTab: "workers", bodyHeight: 30 }).render(width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      expect(plain(lines)).not.toContain("\uFFFD");
    }
  });

  it("renders project discovery and an empty Worker state as actionable guidance", () => {
    const overview = plain(new IntentumControlPanel({ state: projectState(), onAction: () => {}, bodyHeight: 20 }).render(80));
    expect(overview).toContain("Shape the charter from repository evidence");
    expect(overview).toContain("Continue in chat · Return to the Designer editor");

    const workers = plain(new IntentumControlPanel({ state: projectState(), onAction: () => {}, initialTab: "workers" }).render(80));
    expect(workers).toContain("No Worker yet. New work starts from conversation with the Designer.");
  });

  it("wraps the complete primary status and action at 80 columns", () => {
    const state = projectState();
    state.phase = "build";
    state.workers["W-002"] = worker({
      id: "W-002",
      status: "working",
      objective: "Implement the complete responsive onboarding experience without losing the verification context",
    });
    const copy = normalizedPanelCopy(new IntentumControlPanel({ state, onAction: () => {}, bodyHeight: 30 }).render(80));
    expect(copy).toContain(
      "W-002 is working. Keep shaping the product or steer it with a targeted instruction.",
    );
    expect(copy).toContain(
      "View Worker · Implement the complete responsive onboarding experience without losing the verification context",
    );
  });

  it("renders host-owned action feedback and pulse frames without retaining timers", () => {
    const panel = new IntentumControlPanel({ state: busyState(), onAction: () => {}, pulseFrame: 0, bodyHeight: 30 });
    panel.setActionState({ status: "loading", label: "Pausing W-002…" });
    expect(plain(panel.render(80))).toContain("◐ Pausing W-002…");
    panel.setPulseFrame(1);
    expect(plain(panel.render(80))).toContain("◓ Pausing W-002…");
    panel.setActionState({ status: "success", message: "W-002 paused safely." });
    expect(plain(panel.render(80))).toContain("✓ W-002 paused safely.");
    panel.setActionState({ status: "error", message: "Worker session unavailable." });
    expect(plain(panel.render(80))).toContain("✕ Worker session unavailable.");

    const reduced = new IntentumControlPanel({ state: busyState(), onAction: () => {}, reducedMotion: true, pulseFrame: 9, bodyHeight: 30 });
    reduced.setActionState({ status: "loading" });
    const staticText = plain(reduced.render(80));
    expect(staticText).toContain("• Working…");
    expect(staticText).toContain("● W-002");
  });

  it("applies distinct semantic tones to paused, blocked, failed, verifying, and review states", () => {
    const state = semanticState();
    const panel = new IntentumControlPanel({
      state,
      onAction: () => {},
      initialTab: "workers",
      bodyHeight: 40,
      style: ansiStyle(),
    });
    const raw = panel.render(120).join("\n");
    expect(raw).toMatch(/\u001b\[36m[^\n]*Verifying/);
    expect(raw).toMatch(/\u001b\[32m[^\n]*Ready for review/);
    expect(raw).toMatch(/\u001b\[33m[^\n]*Blocked/);
    expect(raw).toMatch(/\u001b\[31m[^\n]*Failed/);
    expect(raw).toMatch(/\u001b\[2m[^\n]*Paused/);
  });

  it("renders a paused project title as neutral and routes Worker resume through the project", () => {
    const state = projectState();
    state.phase = "paused";
    state.phaseBeforePause = "build";
    state.schedulerPaused = true;
    state.workers["W-001"] = worker({ id: "W-001", status: "paused", objective: "Paused work" });
    const panel = new IntentumControlPanel({
      state,
      onAction: () => {},
      initialTab: "workers",
      bodyHeight: 30,
      style: ansiStyle(),
    });
    const lines = panel.render(100);
    expect(lines[0]).toMatch(/\u001b\[2m PAUSED \(build 4\/8\) \u001b\[22m/);
    const text = plain(lines);
    expect(text).toContain("Resume project first");
    expect(text).not.toContain("› Resume · Continue the preserved session");
  });

  it("does not offer ineffective steering while a Worker is verifying", () => {
    const state = projectState();
    state.phase = "verify";
    state.workers["W-001"] = worker({ id: "W-001", status: "verifying", objective: "Verify result" });
    const text = plain(new IntentumControlPanel({
      state,
      onAction: () => {},
      initialTab: "workers",
      bodyHeight: 30,
    }).render(80));
    expect(text).not.toContain("› Steer");
    expect(text).toContain("› Abort");
  });

  it("names the mouse limitation in fullscreen mode", () => {
    const fullscreen = new IntentumControlPanel({ state: busyState(), onAction: () => {}, mouse: "fullscreen" });
    expect(plain(fullscreen.render(100))).toContain("mouse: keyboard only in fullscreen");
    const available = new IntentumControlPanel({ state: busyState(), onAction: () => {}, mouse: "available" });
    expect(plain(available.render(100))).toContain("click or scroll");
  });
});

describe("intentum control panel keyboard and async detail", () => {
  it("moves through full-row actions and activates the visible focused option", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state: busyState(), onAction: (action) => actions.push(action), bodyHeight: 30 });
    panel.render(80);
    expect(panel.focusedControlId).toBe("overview:primary:decision:D-004");
    panel.handleInput(DOWN);
    expect(panel.focusedControlId).toBe("overview:decision:D-004");
    panel.handleInput(DOWN);
    expect(panel.focusedControlId).toBe("overview:open:W-004");
    panel.handleInput(DOWN);
    expect(panel.focusedControlId).toBe("overview:review:W-001");
    panel.handleInput(ENTER);
    expect(panel.activeTab).toBe("workers");
    expect(panel.selectedWorker).toBe("W-001");
    expect(actions).toEqual([{ type: "inspect-worker", workerId: "W-001" }]);
  });

  it("never activates the previously focused control after scrolling it offscreen", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({
      state: busyState(),
      onAction: (action) => actions.push(action),
      bodyHeight: 5,
    });
    panel.render(80);
    const hiddenAfterScroll = panel.focusedControlId;
    expect(hiddenAfterScroll).toBe("overview:primary:decision:D-004");
    panel.handleWheel(1);
    panel.handleWheel(1);
    panel.render(80);
    expect(panel.focusedControlId).not.toBe(hiddenAfterScroll);
    panel.handleInput(ENTER);
    expect(panel.activeTab).not.toBe("decisions");
  });

  it("keeps action feedback visible after acting from a deep scroll position", () => {
    const state = busyState();
    for (let index = 5; index < 20; index += 1) {
      const id = `W-${String(index).padStart(3, "0")}`;
      state.workers[id] = worker({ id, status: "queued", objective: `Queued outcome ${index}` });
    }
    const panel = new IntentumControlPanel({ state, onAction: () => {}, initialTab: "workers", bodyHeight: 5 });
    panel.render(80);
    panel.handleWheel(1);
    panel.handleWheel(1);
    panel.setActionState({ status: "loading", label: "Applying Worker action…" });
    expect(plain(panel.render(80))).toContain("Applying Worker action…");
  });

  it("opens an older Worker at a visible row in a long list", () => {
    const state = projectState();
    state.phase = "build";
    state.workers["W-001"] = worker({
      id: "W-001",
      status: "completed",
      objective: "Old completed result",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
    for (let index = 2; index < 20; index += 1) {
      const id = `W-${String(index).padStart(3, "0")}`;
      state.workers[id] = worker({
        id,
        status: "integrated",
        objective: `Integrated outcome ${index}`,
        updatedAt: `2026-09-04T${String(index).padStart(2, "0")}:00:00.000Z`,
      });
    }
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state, onAction: (action) => actions.push(action), bodyHeight: 5 });
    panel.render(80);
    panel.handleInput(ENTER);
    const text = plain(panel.render(80));
    expect(panel.focusedControlId).toBe("worker:W-001");
    expect(text).toContain("W-001");
    expect(text).toContain("Loading result evidence…");
    expect(actions).toEqual([{ type: "inspect-worker", workerId: "W-001" }]);
  });

  it("brings keyboard focus into view while traversing a long Worker list", () => {
    const state = busyState();
    for (let index = 5; index < 25; index += 1) {
      const id = `W-${String(index).padStart(3, "0")}`;
      state.workers[id] = worker({ id, status: "queued", objective: `Queued outcome ${index}` });
    }
    const panel = new IntentumControlPanel({ state, onAction: () => {}, initialTab: "workers", bodyHeight: 6 });
    panel.render(80);
    for (let index = 0; index < 14; index += 1) panel.handleInput(DOWN);
    const rendered = panel.render(80).join("\n");
    expect(panel.focusedControlId).toBeDefined();
    expect(rendered).toContain("\u001b[7m");
    expect(plain(panel.render(80))).toMatch(/… \d+ more/);
  });

  it("loads Worker inspection lazily and presents outcome evidence before technical metadata", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({
      state: busyState(),
      onAction: (action) => actions.push(action),
      initialTab: "workers",
      bodyHeight: 60,
    });
    let lines = visibleLines(panel.render(80));
    const completedRow = lines.findIndex((line) => line.includes("W-001") && line.includes("Ready for review"));
    panel.handleClick(5, completedRow);

    lines = visibleLines(panel.render(80));
    const reviewRow = lines.findIndex((line) => line.includes("Review evidence"));
    panel.handleClick(70, reviewRow);
    expect(actions).toEqual([{ type: "inspect-worker", workerId: "W-001" }]);
    expect(plain(panel.render(80))).toContain("Loading result evidence…");

    panel.setWorkerDetailState("W-001", { status: "loaded", detail: completedInspection() });
    const text = plain(panel.render(80));
    expect(text).toContain("OUTCOME");
    expect(text).toContain("USER-VISIBLE CHANGES");
    expect(text).toContain("Added account creation for end users.");
    expect(text).toContain("TEST EVIDENCE");
    expect(text).toContain("✓ pnpm test · All focused tests passed.");
    expect(text).toContain("RISKS");
    expect(text).toContain("Email delivery remains environment-dependent.");
    expect(text).toContain("NEXT");
    expect(text).toContain("Run a production mail smoke test.");
    expect(text).toContain("Fifth visible change remains available through scrolling.");
    expect(text).toContain("✓ pnpm test:extra-5 · Additional evidence 5.");
    expect(text).toContain("TECHNICAL");
    expect(text).toContain("branch    intentum/W-001 → main");
    expect(text.indexOf("USER-VISIBLE CHANGES")).toBeLessThan(text.indexOf("TECHNICAL"));
    expect(text.indexOf("TEST EVIDENCE")).toBeLessThan(text.indexOf("TECHNICAL"));
    expect(text.indexOf("RISKS")).toBeLessThan(text.indexOf("TECHNICAL"));
  });

  it("keeps Worker detail failures in-panel and makes retry explicit", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state: busyState(), onAction: (action) => actions.push(action), initialTab: "workers", bodyHeight: 30 });
    let lines = visibleLines(panel.render(80));
    const detailsRow = lines.findIndex((line) => line.includes("Details · Load result"));
    panel.handleClick(70, detailsRow);
    panel.setWorkerDetailState("W-004", { status: "error", message: "Stored result could not be read." });
    const failed = plain(panel.render(80));
    expect(failed).toContain("✕ Stored result could not be read.");
    expect(failed).toContain("Retry details");

    lines = visibleLines(panel.render(80));
    const retryRow = lines.findIndex((line) => line.includes("Retry details"));
    panel.handleClick(70, retryRow);
    expect(actions).toEqual([
      { type: "inspect-worker", workerId: "W-004" },
      { type: "inspect-worker", workerId: "W-004" },
    ]);
  });

  it("switches tabs, closes, and keeps the project pause shortcut", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state: busyState(), onAction: (action) => actions.push(action) });
    panel.handleInput(TAB);
    expect(panel.activeTab).toBe("workers");
    panel.handleInput("3");
    expect(panel.activeTab).toBe("decisions");
    panel.handleInput("?");
    expect(panel.activeTab).toBe("help");
    panel.handleInput(`${ESC}[Z`);
    expect(panel.activeTab).toBe("decisions");
    panel.handleInput("p");
    panel.handleInput(ESC);
    expect(actions).toEqual([{ type: "pause-project" }, { type: "close" }]);
  });

  it("drafts decision options and discussion instead of resolving internally", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state: busyState(), onAction: (action) => actions.push(action), initialTab: "decisions", bodyHeight: 30 });
    let lines = visibleLines(panel.render(80));
    expect(lines.join("\n")).toContain("Choose A · Magic link · Easier onboarding");
    expect(lines.join("\n")).toContain("Designer recommends Magic link");

    const chooseRow = lines.findIndex((line) => line.includes("Choose A · Magic link"));
    panel.handleClick(70, chooseRow);
    lines = visibleLines(panel.render(80));
    const discussRow = lines.findIndex((line) => line.includes("Discuss in chat"));
    panel.handleClick(70, discussRow);
    expect(actions).toEqual([
      { type: "decide", decisionId: "D-004", optionId: "magic" },
      { type: "discuss", decisionId: "D-004" },
    ]);
  });

  it("shows complete long decision questions and consequences", () => {
    const state = busyState();
    const decision = state.pendingDecisions[0]!;
    decision.question = "Which authentication method should the first release use while preserving recovery, accessibility, and clear user expectations?";
    decision.options[0]!.consequence = "Magic links reduce password friction but depend on reliable email delivery and a clearly communicated retry path.";
    const copy = normalizedPanelCopy(new IntentumControlPanel({
      state,
      onAction: () => {},
      initialTab: "decisions",
      bodyHeight: 40,
    }).render(80));
    expect(copy).toContain(decision.question);
    expect(copy).toContain(decision.options[0]!.consequence);
  });

  it("ignores keyboard and pointer actions while suspended", () => {
    const actions: PanelAction[] = [];
    const panel = new IntentumControlPanel({ state: busyState(), onAction: (action) => actions.push(action) });
    panel.setSuspended(true);
    panel.handleInput(ESC);
    panel.render(80);
    expect(panel.handleClick(5, 4)).toBe(true);
    expect(actions).toEqual([]);
  });
});

describe("intentum control panel mouse helpers", () => {
  it("makes the entire action row clickable and still reports clicks outside", () => {
    const panel = new IntentumControlPanel({ state: busyState(), onAction: () => {}, bodyHeight: 30 });
    const lines = visibleLines(panel.render(80));
    const answerRow = lines.findIndex((line) => line.includes("Answer decision · Authentication method"));
    expect(answerRow).toBeGreaterThan(0);
    expect(panel.handleClick(76, answerRow)).toBe(true);
    expect(panel.activeTab).toBe("decisions");
    expect(panel.handleClick(-1, 3)).toBe(false);
    expect(panel.handleClick(5, panel.height + 2)).toBe(false);
  });

  it("parses batched SGR reports and keeps remaining input", () => {
    const parsed = parseMouseSequences(`${ESC}[<0;12;5M${ESC}[<0;12;5mx`);
    expect(parsed.events).toEqual([
      { button: 0, x: 11, y: 4, release: false },
      { button: 0, x: 11, y: 4, release: true },
    ]);
    expect(parsed.remainder).toBe("x");
    expect(parseMouseSequences("plain")).toEqual({ events: [], remainder: "plain" });
  });

  it("mirrors the centred overlay origin used by Pi TUI", () => {
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

  it("animates only active glyphs", () => {
    expect(statusGlyph("working", 0)).toBe("●");
    expect(statusGlyph("working", 1)).toBe("◉");
    expect(statusGlyph("verifying", 1)).toBe("◓");
    expect(statusGlyph("completed", 1)).toBe("✓");
    expect(statusGlyph("working", 1, true)).toBe("●");
  });
});

function plain(lines: string[]): string {
  return visibleLines(lines).join("\n");
}

function visibleLines(lines: string[]): string[] {
  return lines.map(visible);
}

function visible(value: string): string {
  return value.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function normalizedPanelCopy(lines: string[]): string {
  return visibleLines(lines)
    .map((line) => line.startsWith("│ ") && line.endsWith(" │") ? line.slice(2, -2).trim() : line.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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

function semanticState(): ProjectState {
  const statuses: WorkerStatus[] = ["queued", "working", "verifying", "completed", "blocked", "failed", "paused"];
  const state = projectState();
  state.phase = "build";
  statuses.forEach((status, index) => {
    const id = `W-${String(index + 1).padStart(3, "0")}`;
    state.workers[id] = worker({
      id,
      status,
      objective: `${status} example`,
      updatedAt: `2026-09-03T${String(20 - index).padStart(2, "0")}:00:00.000Z`,
    });
  });
  return state;
}

function completedInspection() {
  return {
    worker: busyState().workers["W-001"]!,
    contract: {
      id: "W-001",
      featureId: "F-002",
      title: "Account creation",
      objective: "Add account creation.",
      why: "Users need accounts.",
      userVisibleResult: "Users can create an account.",
      scope: { inScope: ["account UI"], outOfScope: [] },
      interfaces: [],
      constraints: [],
      acceptanceCriteria: ["Account can be created"],
      dependencies: [],
      touchHints: [],
      risk: "medium" as const,
      preferredWorkerKind: "implementation" as const,
      contextFiles: [],
    },
    result: {
      workId: "W-001",
      attemptId: "attempt-1",
      status: "completed" as const,
      summary: "Account creation is ready for review.",
      userVisibleChanges: [
        "Added account creation for end users.",
        "Added a clear confirmation state.",
        "Improved keyboard navigation.",
        "Preserved recovery copy.",
        "Fifth visible change remains available through scrolling.",
      ],
      filesChanged: ["src/account.ts"],
      testsRun: [
        { command: "pnpm test", status: "passed" as const, exitCode: 0, summary: "All focused tests passed." },
        ...Array.from({ length: 5 }, (_, index) => ({
          command: `pnpm test:extra-${index + 1}`,
          status: "passed" as const,
          exitCode: 0,
          summary: `Additional evidence ${index + 1}.`,
        })),
      ],
      architectureConcerns: [],
      remainingRisks: ["Email delivery remains environment-dependent."],
      suggestedFollowUps: ["Run a production mail smoke test."],
      resultCommit: "0123456789abcdef0123456789abcdef01234567",
      recordedAt: "2026-09-03T05:00:00.000Z",
    },
  };
}

function ansiStyle(): Partial<PanelStyle> {
  return {
    accent: (text) => `\u001b[36m${text}\u001b[39m`,
    muted: (text) => `\u001b[2m${text}\u001b[22m`,
    success: (text) => `\u001b[32m${text}\u001b[39m`,
    warning: (text) => `\u001b[33m${text}\u001b[39m`,
    error: (text) => `\u001b[31m${text}\u001b[39m`,
  };
}
