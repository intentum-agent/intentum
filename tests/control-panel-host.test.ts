import { describe, expect, it } from "vitest";
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import type { ProjectState } from "../src/state/schema.js";

import {
  DISABLE_MOUSE_REPORTS,
  ENABLE_MOUSE_REPORTS,
  hasAnimatedWorker,
  mouseAvailabilityFor,
  openControlPanel,
  panelBodyRowsFor,
  panelSurfaceFor,
  panelStyleFromTheme,
  panelWidthFor,
  performPanelAction,
  reducedMotionEnabled,
} from "../src/tools/control-panel-host.js";
import { createTempRepository } from "./helpers/temp-repo.js";
import { ScriptedWorkerFactory } from "./helpers/scripted-worker.js";

const ESC = "\u001b";

describe("control panel host layout", () => {
  it("sizes the panel to the terminal without exceeding the design width", () => {
    expect(panelWidthFor(60)).toBe(60);
    expect(panelWidthFor(200)).toBe(100);
    expect(panelWidthFor(30)).toBe(30);
    expect(panelBodyRowsFor(24)).toBe(16);
    expect(panelBodyRowsFor(80)).toBe(24);
  });

  it("uses a fullscreen workspace, a regular dialog, and a safe small-terminal fallback", () => {
    expect(panelSurfaceFor(120, 40, "fullscreen")).toMatchObject({
      kind: "workspace",
      width: 120,
      bodyRows: 34,
      density: "wide",
    });
    expect(panelSurfaceFor(80, 24, "fullscreen")).toMatchObject({
      kind: "workspace",
      width: 80,
      bodyRows: 18,
      density: "compact",
    });
    expect(panelSurfaceFor(120, 40, "regular")).toMatchObject({
      kind: "dialog",
      width: 100,
      bodyRows: 24,
      density: "wide",
    });
    expect(panelSurfaceFor(40, 12, "fullscreen").kind).toBe("fallback");
    expect(panelSurfaceFor(30, 12, "regular").kind).toBe("fallback");
  });

  it("only offers mouse input where the Pi renderer does not own it", () => {
    expect(mouseAvailabilityFor({ mode: "regular" })).toBe("available");
    expect(mouseAvailabilityFor({ mode: "fullscreen" })).toBe("fullscreen");
  });

  it("supports an explicit static-motion fallback", () => {
    expect(reducedMotionEnabled({ INTENTUM_REDUCED_MOTION: "1" })).toBe(true);
    expect(reducedMotionEnabled({ TERM: "dumb" })).toBe(true);
    expect(reducedMotionEnabled({})).toBe(false);
  });

  it("animates only Worker states whose glyph actually changes", () => {
    const state = completedProjectState();
    state.workers["W-001"]!.status = "pause_requested";
    expect(hasAnimatedWorker(state)).toBe(false);
    state.workers["W-001"]!.status = "working";
    expect(hasAnimatedWorker(state)).toBe(true);
    state.workers["W-001"]!.status = "verifying";
    expect(hasAnimatedWorker(state)).toBe(true);
  });

  it("pairs the focus background with the theme text colour so it stays readable", () => {
    const style = panelStyleFromTheme({
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bg: (color, text) => `[${color}]${text}[/${color}]`,
      bold: (text) => `*${text}*`,
    });
    expect(style.focus("Overview")).toBe("[selectedBg]<text>*Overview*</text>[/selectedBg]");
  });
});

describe("control panel host lifecycle", () => {
  it("enables mouse reports for the panel lifetime and closes on an outside click", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    try {
      const { state } = await runtime.initialize("Mouse Fixture");
      const host = createHost(fixture.repo, "regular");
      const opened = openControlPanel(runtime, host.context, state);
      await host.ready;

      expect(host.terminalWrites).toEqual([ENABLE_MOUSE_REPORTS]);
      expect(host.listeners).toHaveLength(1);
      const listener = host.listeners[0];
      if (!listener) throw new Error("expected a terminal input listener");

      const lines = host.component?.render(100) ?? [];
      expect(lines.length).toBeGreaterThan(6);
      // The regular-mode dialog is centred on a 120x40 terminal.
      const top = Math.floor((40 - lines.length) / 2);
      const workersTabRow = top + 1;
      const workersCol = 10 + visible(lines[1] ?? "").indexOf("Workers");
      expect(listener(`${ESC}[<0;${workersCol + 1};${workersTabRow + 1}M`)).toEqual({ consume: true });
      expect(visible(host.component?.render(100)[1] ?? "")).toContain("Workers");
      expect(host.component?.render(100).map(visible).join("\n")).toContain("No Worker yet.");

      expect(listener(`${ESC}[<0;5;5Mabc`)).toEqual({ data: "abc" });
      expect(listener("abc")).toBeUndefined();

      expect(listener(`${ESC}[<0;1;1M`)).toEqual({ consume: true });
      await opened;
      expect(host.disposed).toBe(true);
      expect(host.terminalWrites).toEqual([ENABLE_MOUSE_REPORTS, DISABLE_MOUSE_REPORTS]);
      expect(host.unsubscribed).toBe(1);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("never asks for mouse reports in fullscreen mode and closes on escape", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    try {
      const { state } = await runtime.initialize("Fullscreen Fixture");
      const host = createHost(fixture.repo, "fullscreen");
      const opened = openControlPanel(runtime, host.context, state);
      await host.ready;
      expect(host.terminalWrites).toEqual([]);
      expect(host.listeners).toHaveLength(0);
      const lines = host.component?.render(120) ?? [];
      expect(lines).toHaveLength(40);
      expect(lines.every((line) => visible(line).length === 120)).toBe(true);
      expect(lines.map(visible).join("\n")).toContain("in fullscreen");
      host.component?.handleInput?.(ESC);
      await opened;
      expect(host.disposed).toBe(true);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("falls back to readable text instead of opening clipped controls", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    try {
      const { state } = await runtime.initialize("Small Fixture");
      const host = createHost(fixture.repo, "fullscreen", {}, { columns: 40, rows: 12 });
      await openControlPanel(runtime, host.context, state);
      expect(host.listeners).toHaveLength(0);
      expect(host.notifications.at(-1)?.message).toContain("60×16 required");
      expect(host.notifications.at(-1)?.message).toContain("Small Fixture · DISCOVERY 1/8");
      expect(host.notifications.at(-1)?.message).toContain("/intentum status");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("cannot activate stale controls after a resize enters fallback mode", async () => {
    const state: ProjectState = {
      schemaVersion: 1,
      projectId: "resize-fixture",
      projectName: "Resize Fixture",
      phase: "discovery",
      autonomy: "guided",
      workers: {},
      pendingDecisions: [],
      schedulerPaused: false,
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    const runtime = {
      onStateChange: () => () => undefined,
      workers: { inspect: async () => ({}) },
    } as unknown as IntentumRuntime;
    const host = createHost("/tmp/intentum-resize-fixture", "regular");
    const opened = openControlPanel(runtime, host.context, state);
    await host.ready;
    host.component?.render(100);

    host.resize(40, 12);
    const fallback = host.component?.render(40).map(visible).join("\n") ?? "";
    expect(fallback).toContain("compact status");
    host.component?.handleInput?.("\r");
    expect(host.disposed).toBe(false);

    host.component?.handleInput?.(ESC);
    await opened;
  });

  it("re-renders from canonical state changes while open", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    try {
      const { state } = await runtime.initialize("Live Fixture");
      const host = createHost(fixture.repo, "regular");
      const opened = openControlPanel(runtime, host.context, state);
      await host.ready;
      expect(visible(host.component?.render(96)[0] ?? "")).toContain("DISCOVERY 1/8");
      await runtime.pauseProject();
      expect(host.renderRequests).toBeGreaterThan(0);
      expect(visible(host.component?.render(96)[0] ?? "")).toContain("PAUSED (discovery 1/8)");
      host.component?.handleInput?.("q");
      await opened;
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("loads Worker evidence through the existing inspect API", async () => {
    const state = completedProjectState();
    const inspected: string[] = [];
    const runtime = {
      onStateChange: () => () => undefined,
      workers: {
        inspect: async (workerId: string) => {
          inspected.push(workerId);
          return {
            worker: state.workers[workerId],
            result: {
              workId: workerId,
              attemptId: "attempt-1",
              status: "completed" as const,
              summary: "User-facing work is ready for review.",
              userVisibleChanges: ["Added a clear onboarding flow."],
              filesChanged: ["src/onboarding.ts"],
              testsRun: [{ command: "pnpm test", status: "passed" as const, summary: "Focused tests passed." }],
              architectureConcerns: [],
              remainingRisks: [],
              suggestedFollowUps: [],
              resultCommit: "0123456789abcdef0123456789abcdef01234567",
              recordedAt: "2026-09-04T00:00:00.000Z",
            },
          };
        },
      },
    } as unknown as IntentumRuntime;
    const host = createHost("/tmp/intentum-host-fixture", "fullscreen");
    const opened = openControlPanel(runtime, host.context, state, "workers");
    await host.ready;

    host.component?.render(120);
    host.component?.handleInput?.(`${ESC}[B`);
    host.component?.handleInput?.("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));

    const text = host.component?.render(120).map(visible).join("\n") ?? "";
    expect(inspected).toEqual(["W-001"]);
    expect(text).toContain("OUTCOME");
    expect(text).toContain("Added a clear onboarding flow.");
    expect(text).toContain("TEST EVIDENCE");

    host.component?.handleInput?.(ESC);
    await opened;
  });

  it("hides the opaque workspace while Pi owns a nested input dialog", async () => {
    const base = completedProjectState();
    const { resultCommit: _resultCommit, ...worker } = base.workers["W-001"]!;
    const state: ProjectState = {
      ...base,
      workers: { "W-001": { ...worker, status: "working", progressSummary: "Building onboarding." } },
    };
    const instructions: string[] = [];
    const runtime = {
      onStateChange: () => () => undefined,
      workers: {
        inspect: async () => ({}),
        steer: async (_workerId: string, message: string) => {
          instructions.push(message);
        },
      },
    } as unknown as IntentumRuntime;
    const host = createHost("/tmp/intentum-dialog-fixture", "fullscreen", { input: "Keep the copy concise" });
    const opened = openControlPanel(runtime, host.context, state, "workers");
    await host.ready;
    host.component?.render(120);
    host.component?.handleInput?.(`${ESC}[B`);
    host.component?.handleInput?.(`${ESC}[B`);
    host.component?.handleInput?.("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(instructions).toEqual(["Keep the copy concise"]);
    expect(host.overlayHidden).toEqual([true, false]);
    expect(host.overlayFocuses).toBeGreaterThan(0);

    host.component?.handleInput?.(ESC);
    await opened;
  });

  it("discards inspection evidence when the Worker attempt changes mid-read", async () => {
    const initial = completedProjectState();
    let publishState: (state: ProjectState) => void = () => undefined;
    let resolveInspect: (value: Awaited<ReturnType<IntentumRuntime["workers"]["inspect"]>>) => void = () => undefined;
    const pendingInspect = new Promise<Awaited<ReturnType<IntentumRuntime["workers"]["inspect"]>>>((resolve) => {
      resolveInspect = resolve;
    });
    const runtime = {
      onStateChange: (listener: (state: ProjectState) => void) => {
        publishState = listener;
        return () => undefined;
      },
      workers: { inspect: async () => pendingInspect },
    } as unknown as IntentumRuntime;
    const host = createHost("/tmp/intentum-stale-inspect", "fullscreen");
    const opened = openControlPanel(runtime, host.context, initial, "workers");
    await host.ready;
    host.component?.render(120);
    host.component?.handleInput?.(`${ESC}[B`);
    host.component?.handleInput?.("\r");

    const { resultCommit: _oldResultCommit, ...retryWorker } = initial.workers["W-001"]!;
    const next: ProjectState = {
      ...initial,
      workers: {
        "W-001": {
          ...retryWorker,
          status: "working",
          attemptId: "attempt-2",
          updatedAt: "2026-09-04T00:01:00.000Z",
        },
      },
    };
    publishState(next);
    resolveInspect({
      worker: initial.workers["W-001"]!,
      result: {
        workId: "W-001",
        attemptId: "attempt-1",
        status: "completed",
        summary: "STALE EVIDENCE",
        userVisibleChanges: [],
        filesChanged: [],
        testsRun: [],
        architectureConcerns: [],
        remainingRisks: [],
        suggestedFollowUps: [],
        resultCommit: "0123456789abcdef0123456789abcdef01234567",
        recordedAt: "2026-09-04T00:00:00.000Z",
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(host.component?.render(120).map(visible).join("\n")).not.toContain("STALE EVIDENCE");
    host.component?.handleInput?.(ESC);
    await opened;
  });
});

describe("control panel actions", () => {
  it("pauses and resumes the project and drafts decisions into the editor", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    try {
      let { state } = await runtime.initialize("Action Fixture");
      const host = createHost(fixture.repo, "regular");
      let closed = 0;
      const actionHost = { runtime, ctx: host.context, state: () => state, close: () => { closed += 1; } };

      await expect(performPanelAction(actionHost, { type: "pause-project" })).resolves.toMatchObject({ status: "success" });
      state = (await runtime.status()).state;
      expect(state.phase).toBe("paused");
      expect(host.notifications.at(-1)?.message).toContain("Project paused");

      await expect(performPanelAction(actionHost, { type: "resume-project" })).resolves.toMatchObject({ status: "success" });
      state = (await runtime.status()).state;
      expect(state.phase).toBe("discovery");

      await expect(performPanelAction(actionHost, { type: "show-status" })).resolves.toEqual({ status: "closed" });
      expect(host.notifications.at(-1)?.message).toContain("Action Fixture · DISCOVERY 1/8");
      expect(closed).toBe(1);

      state = {
        ...state,
        pendingDecisions: [{
          id: "D-001",
          title: "Authentication method",
          question: "Which login method?",
          blocking: true,
          affectedWorkIds: [],
          options: [
            { id: "magic", label: "Magic link", consequence: "Easier onboarding." },
            { id: "password", label: "Password", consequence: "Familiar." },
          ],
        }],
      };
      await expect(performPanelAction(actionHost, { type: "decide", decisionId: "D-001", optionId: "password" }))
        .resolves.toEqual({ status: "closed" });
      expect(closed).toBe(2);
      expect(host.editorText).toBe("Decision D-001 (Authentication method): I choose Password.");

      await expect(performPanelAction(actionHost, { type: "discuss", decisionId: "D-001" }))
        .resolves.toEqual({ status: "closed" });
      expect(closed).toBe(3);
      expect(host.editorText).toBe("About decision D-001 (Authentication method): ");

      state = {
        ...state,
        pendingDecisions: [{
          id: "D-002\nInjected",
          title: "\u001b[31mUnsafe title\u001b[0m\nInjected",
          question: "Which option?",
          blocking: true,
          affectedWorkIds: [],
          options: [
            { id: "a", label: "Option\nInjected", consequence: "A" },
            { id: "b", label: "B", consequence: "B" },
          ],
        }],
      };
      await performPanelAction(actionHost, { type: "decide", decisionId: "D-002\nInjected", optionId: "a" });
      expect(host.editorText).toBe("Decision D-002 Injected (Unsafe title Injected): I choose Option Injected.");
      expect(host.editorText).not.toContain("\u001b");

      await expect(performPanelAction(actionHost, { type: "decide", decisionId: "D-404", optionId: "x" }))
        .rejects.toThrow("decision D-404 is no longer pending");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("does nothing when a steer or abort dialog is cancelled", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    try {
      const { state } = await runtime.initialize("Cancel Fixture");
      const host = createHost(fixture.repo, "regular", { input: undefined });
      const actionHost = { runtime, ctx: host.context, state: () => state, close: () => {} };
      await expect(performPanelAction(actionHost, { type: "steer", workerId: "W-404" }))
        .resolves.toEqual({ status: "cancelled" });
      await expect(performPanelAction(actionHost, { type: "abort", workerId: "W-404" }))
        .resolves.toEqual({ status: "cancelled" });
      await expect(performPanelAction(actionHost, { type: "resume-worker", workerId: "W-404" }))
        .resolves.toEqual({ status: "cancelled" });
      expect(host.notifications).toEqual([]);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });
});

interface Host {
  context: ExtensionCommandContext;
  ready: Promise<void>;
  component: { render(width: number): string[]; handleInput?(data: string): void } | undefined;
  listeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined>;
  terminalWrites: string[];
  notifications: Array<{ message: string; type?: string }>;
  renderRequests: number;
  disposed: boolean;
  unsubscribed: number;
  editorText: string | undefined;
  resize(columns: number, rows: number): void;
  overlayHidden: boolean[];
  overlayFocuses: number;
}

function createHost(
  cwd: string,
  mode: "regular" | "fullscreen",
  dialogs: { input?: string | undefined } = {},
  dimensions: { columns: number; rows: number } = { columns: 120, rows: 40 },
): Host {
  let markReady = () => {};
  const host: Host = {
    context: undefined as never,
    ready: new Promise<void>((resolve) => {
      markReady = resolve;
    }),
    component: undefined,
    listeners: [],
    terminalWrites: [],
    notifications: [],
    renderRequests: 0,
    disposed: false,
    unsubscribed: 0,
    editorText: undefined,
    overlayHidden: [],
    overlayFocuses: 0,
    resize(columns, rows) {
      tui.terminal.columns = columns;
      tui.terminal.rows = rows;
    },
  };
  const tui = {
    mode,
    terminal: {
      columns: dimensions.columns,
      rows: dimensions.rows,
      write: (data: string) => {
        host.terminalWrites.push(data);
      },
    },
    requestRender: () => {
      host.renderRequests += 1;
    },
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ui = {
    notify(message: string, type?: string) {
      host.notifications.push(type === undefined ? { message } : { message, type });
    },
    setWidget() {},
    setStatus() {},
    setEditorText(text: string) {
      host.editorText = text;
    },
    confirm: async () => true,
    input: async () => dialogs.input,
    onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined) {
      host.listeners.push(handler);
      return () => {
        host.unsubscribed += 1;
      };
    },
    async custom(
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: unknown) => void,
      ) => Host["component"] & { dispose?(): void },
      options?: { onHandle?: (handle: unknown) => void },
    ) {
      return new Promise<void>((resolve) => {
        let component: (Host["component"] & { dispose?(): void }) | undefined;
        const done = () => {
          component?.dispose?.();
          host.disposed = true;
          resolve();
        };
        component = factory(tui, theme, {}, done);
        host.component = component;
        let hidden = false;
        options?.onHandle?.({
          hide: done,
          setHidden(value: boolean) {
            hidden = value;
            host.overlayHidden.push(value);
          },
          isHidden: () => hidden,
          focus() {
            host.overlayFocuses += 1;
          },
          unfocus() {},
          isFocused: () => !hidden,
        });
        markReady();
      });
    },
  } as unknown as ExtensionUIContext;
  host.context = {
    cwd,
    ui,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
  } as unknown as ExtensionCommandContext;
  return host;
}

function visible(value: string): string {
  return value.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function completedProjectState(): ProjectState {
  return {
    schemaVersion: 1,
    projectId: "host-fixture",
    projectName: "Host Fixture",
    phase: "build",
    autonomy: "balanced",
    activeFeatureId: "F-001",
    workers: {
      "W-001": {
        id: "W-001",
        kind: "implementation",
        status: "completed",
        featureId: "F-001",
        objective: "Onboarding flow",
        resultCommit: "0123456789abcdef0123456789abcdef01234567",
        attemptId: "attempt-1",
        updatedAt: "2026-09-04T00:00:00.000Z",
      },
    },
    pendingDecisions: [],
    schedulerPaused: false,
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}
