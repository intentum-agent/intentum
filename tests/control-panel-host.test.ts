import { describe, expect, it } from "vitest";
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { IntentumRuntime } from "../src/runtime/intentum-runtime.js";

import {
  DISABLE_MOUSE_REPORTS,
  ENABLE_MOUSE_REPORTS,
  mouseAvailabilityFor,
  openControlPanel,
  panelBodyRowsFor,
  panelWidthFor,
  performPanelAction,
} from "../src/tools/control-panel-host.js";
import { createTempRepository } from "./helpers/temp-repo.js";
import { ScriptedWorkerFactory } from "./helpers/scripted-worker.js";

const ESC = "\u001b";

describe("control panel host layout", () => {
  it("sizes the panel to the terminal without exceeding the design width", () => {
    expect(panelWidthFor(60)).toBe(56);
    expect(panelWidthFor(200)).toBe(100);
    expect(panelWidthFor(30)).toBe(40);
    expect(panelBodyRowsFor(24)).toBe(16);
    expect(panelBodyRowsFor(80)).toBe(24);
  });

  it("only offers mouse input where the Pi renderer does not own it", () => {
    expect(mouseAvailabilityFor({ mode: "regular" })).toBe("available");
    expect(mouseAvailabilityFor({ mode: "fullscreen" })).toBe("fullscreen");
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

      const lines = host.component?.render(96) ?? [];
      expect(lines.length).toBeGreaterThan(6);
      // The overlay is centred on a 120x40 terminal, so the panel's top-left
      // corner sits at column 12 and row (40 - height) / 2.
      const top = Math.floor((40 - lines.length) / 2);
      const workersTabRow = top + 1;
      const workersCol = 12 + visible(lines[1] ?? "").indexOf("Workers");
      expect(listener(`${ESC}[<0;${workersCol + 1};${workersTabRow + 1}M`)).toEqual({ consume: true });
      expect(visible(host.component?.render(96)[1] ?? "")).toContain("Workers");
      expect(host.component?.render(96).map(visible).join("\n")).toContain("No Worker yet.");

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
      expect(host.component?.render(96).map(visible).join("\n")).toContain("in fullscreen");
      host.component?.handleInput?.(ESC);
      await opened;
      expect(host.disposed).toBe(true);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
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

      await performPanelAction(actionHost, { type: "pause-project" });
      state = (await runtime.status()).state;
      expect(state.phase).toBe("paused");
      expect(host.notifications.at(-1)?.message).toContain("Project paused");

      await performPanelAction(actionHost, { type: "resume-project" });
      state = (await runtime.status()).state;
      expect(state.phase).toBe("discovery");

      await performPanelAction(actionHost, { type: "show-status" });
      expect(host.notifications.at(-1)?.message).toContain("Action Fixture · DISCOVERY 1/8");

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
      await performPanelAction(actionHost, { type: "decide", decisionId: "D-001", optionId: "password" });
      expect(closed).toBe(1);
      expect(host.editorText).toBe("Decision D-001 (Authentication method): I choose Password.");

      await performPanelAction(actionHost, { type: "discuss", decisionId: "D-001" });
      expect(closed).toBe(2);
      expect(host.editorText).toBe("About decision D-001 (Authentication method): ");

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
      await performPanelAction(actionHost, { type: "steer", workerId: "W-404" });
      await performPanelAction(actionHost, { type: "abort", workerId: "W-404" });
      await performPanelAction(actionHost, { type: "resume-worker", workerId: "W-404" });
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
}

function createHost(
  cwd: string,
  mode: "regular" | "fullscreen",
  dialogs: { input?: string | undefined } = {},
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
  };
  const tui = {
    mode,
    terminal: {
      columns: 120,
      rows: 40,
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
  return value.replaceAll(/\[[0-9;]*m/g, "");
}

