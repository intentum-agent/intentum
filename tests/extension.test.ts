import { describe, expect, it } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import intentumExtension from "../extensions/intentum.js";
import {
  handleIntentumCommand,
  showIntentumWelcome,
  splitArguments,
} from "../src/tools/commands.js";
import { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import { ProjectStore } from "../src/state/project-store.js";
import type { ProjectState } from "../src/state/schema.js";
import { BRAND_WIDGET_KEY } from "../src/tui/brand.js";
import { createTempRepository } from "./helpers/temp-repo.js";
import { ScriptedWorkerFactory } from "./helpers/scripted-worker.js";

describe("intentum extension registration", () => {
  it("registers the narrow Phase 1/2 surface without doing work in the factory", () => {
    const commands: string[] = [];
    const tools: string[] = [];
    const events: string[] = [];
    const fake = {
      registerCommand(name: string) {
        commands.push(name);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      on(event: string) {
        events.push(event);
      },
    } as unknown as ExtensionAPI;

    intentumExtension(fake);
    expect(commands).toEqual(["intentum"]);
    expect(tools).toEqual([
      "intentum_project",
      "intentum_create_work",
      "intentum_worker",
      "intentum_integrate",
    ]);
    expect(events).toEqual(["session_start", "before_agent_start", "session_shutdown"]);
  });

  it("keeps an established project trust decision when a context has no trust probe", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    try {
      await runtime.initialize("Trust Probe");
      runtime.setWorkerSessionDefaults({ model: undefined, thinkingLevel: undefined } as never);
      await expect(runtime.createWork({
        featureId: "F-001",
        title: "Trust survives re-application of session defaults",
        objective: "Create a Worker after defaults were re-applied from a probe-less context.",
        why: "Command and tool contexts re-apply defaults mid-session.",
        userVisibleResult: "A Worker record exists.",
        scope: { inScope: ["greeting.txt"], outOfScope: [] },
        interfaces: [],
        constraints: [],
        acceptanceCriteria: ["Worker starts"],
        dependencies: [],
        touchHints: ["greeting.txt"],
        risk: "low",
        preferredWorkerKind: "implementation",
        contextFiles: ["README.md"],
      })).resolves.toMatchObject({ id: "W-001" });
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("parses quoted command arguments without invoking a shell", () => {
    expect(splitArguments("steer W-001 \"keep the name stable\"")).toEqual([
      "steer",
      "W-001",
      "keep the name stable",
    ]);
  });

  it("renders the uninitialized no-argument welcome as one non-transcript widget", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    const harness = createUiHarness(fixture.repo);
    try {
      await handleIntentumCommand(runtime, "", harness.context);

      const welcomeCalls = harness.widgets.filter(
        (call) => call.key === BRAND_WIDGET_KEY && typeof call.content === "function",
      );
      expect(welcomeCalls).toHaveLength(1);
      expect(harness.notifications).toHaveLength(1);
      expect(harness.notifications[0]?.message.split("\n")).toHaveLength(4);
      expect(harness.notifications[0]?.message).toContain("/intentum init [project name]");
      expect(harness.notifications[0]?.message).not.toMatch(/#{4}|_{3}/);

      const factory = welcomeCalls[0]?.content;
      if (typeof factory !== "function") throw new Error("expected a welcome widget factory");
      const rendered = factory(
        undefined as never,
        { fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[39m` } as never,
      ).render(80);
      expect(rendered).toHaveLength(6);
      expect(rendered.join("\n")).toContain("\u001b[31m");

      await handleIntentumCommand(runtime, "", harness.context);
      expect(harness.widgets.filter((call) => typeof call.content === "function")).toHaveLength(1);

      await handleIntentumCommand(runtime, "init From Welcome", harness.context);
      expect(harness.widgets.filter((call) => typeof call.content === "function")).toHaveLength(1);
      expect(harness.widgets.at(-1)).toMatchObject({ key: BRAND_WIDGET_KEY, content: undefined });
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("shows the banner once after first init, then clears it instead of replaying", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    const harness = createUiHarness(fixture.repo);
    try {
      await handleIntentumCommand(runtime, 'init "Branded Fixture"', harness.context);
      expect(harness.widgets.filter((call) => typeof call.content === "function")).toHaveLength(1);
      expect(harness.notifications.at(-1)?.message).toContain("intentum initialized Branded Fixture");

      await handleIntentumCommand(runtime, "init Ignored", harness.context);
      expect(harness.widgets.filter((call) => typeof call.content === "function")).toHaveLength(1);
      expect(harness.widgets.at(-1)).toMatchObject({ key: BRAND_WIDGET_KEY, content: undefined });
      expect(harness.notifications.at(-1)?.message).toContain("intentum already initialized Branded Fixture");

      await handleIntentumCommand(runtime, "", harness.context);
      expect(harness.widgets.filter((call) => typeof call.content === "function")).toHaveLength(1);
      expect(harness.customs).toHaveLength(1);
      expect(harness.customs[0]?.rendered.join("\n")).toContain("⋗ intentum · Branded Fixture");

      const rpc = createUiHarness(fixture.repo, "rpc");
      await handleIntentumCommand(runtime, "", rpc.context);
      expect(rpc.customs).toHaveLength(0);
      const helpLines = rpc.notifications.at(-1)?.message.split("\n") ?? [];
      expect(helpLines[0]).toBe("/intentum  (control panel)");
      expect(helpLines.length).toBeGreaterThanOrEqual(4);
      expect(helpLines.length).toBeLessThanOrEqual(8);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("drops the repeated name when the project is named after the tool", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    const harness = createUiHarness(fixture.repo);
    try {
      await handleIntentumCommand(runtime, "init Intentum", harness.context);
      expect(harness.notifications.at(-1)?.message).toBe("Project intentum initialized in discovery phase.");

      await handleIntentumCommand(runtime, "init", harness.context);
      expect(harness.notifications.at(-1)?.message).toBe(
        "Project intentum is already initialized; existing artifacts were preserved.",
      );
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("uses serializable banner lines for RPC instead of a component factory", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    const harness = createUiHarness(fixture.repo, "rpc");
    try {
      await handleIntentumCommand(runtime, "", harness.context);
      const banner = harness.widgets.find((call) => call.key === BRAND_WIDGET_KEY)?.content;
      expect(Array.isArray(banner)).toBe(true);
      expect(banner).toHaveLength(6);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("keeps RPC Worker and decision summaries plain and single-line per item", async () => {
    const state: ProjectState = {
      schemaVersion: 1,
      projectId: "rpc-safe",
      projectName: "RPC Safe",
      phase: "build",
      autonomy: "balanced",
      workers: {
        "W-001": {
          id: "W-001",
          kind: "implementation",
          status: "working",
          objective: "Build the flow",
          progressSummary: "\u001b[31mWorking\u001b[0m\nInjected",
          updatedAt: "2026-09-04T00:00:00.000Z",
        },
      },
      pendingDecisions: [{
        id: "D-001\nInjected",
        title: "\u001b[33mChoose auth\u001b[0m\nInjected",
        question: "Which method?",
        blocking: true,
        affectedWorkIds: ["W-001"],
        options: [
          { id: "a", label: "A", consequence: "A" },
          { id: "b", label: "B", consequence: "B" },
        ],
      }],
      schedulerPaused: false,
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    const runtime = {
      assertContextRoot: async () => undefined,
      status: async () => ({ state, text: "" }),
    } as unknown as IntentumRuntime;
    const harness = createUiHarness("/tmp/intentum-rpc-safe", "rpc");

    await handleIntentumCommand(runtime, "workers", harness.context);
    expect(harness.notifications.at(-1)?.message).toBe("W-001 · Working · Working Injected");
    await handleIntentumCommand(runtime, "decisions", harness.context);
    expect(harness.notifications.at(-1)?.message).toBe("D-001 Injected · Blocking · Choose auth Injected");
    expect(harness.notifications.map((item) => item.message).join("\n")).not.toContain("\u001b");
  });

  it("claims the one-time RPC welcome before asynchronous asset loading", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    const harness = createUiHarness(fixture.repo, "rpc");
    try {
      await Promise.all([
        handleIntentumCommand(runtime, "", harness.context),
        handleIntentumCommand(runtime, "", harness.context),
      ]);
      expect(harness.widgets.filter(
        (call) => call.key === BRAND_WIDGET_KEY && Array.isArray(call.content),
      )).toHaveLength(1);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("releases a failed welcome claim, then shares the successful retry", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    const harness = createUiHarness(fixture.repo, "rpc", 1);
    try {
      await handleIntentumCommand(runtime, "", harness.context);
      expect(harness.widgets.filter(
        (call) => call.key === BRAND_WIDGET_KEY && Array.isArray(call.content),
      )).toHaveLength(0);

      await Promise.all([
        handleIntentumCommand(runtime, "", harness.context),
        handleIntentumCommand(runtime, "", harness.context),
      ]);
      expect(harness.widgets.filter(
        (call) => call.key === BRAND_WIDGET_KEY && Array.isArray(call.content),
      )).toHaveLength(1);

      await handleIntentumCommand(runtime, "", harness.context);
      expect(harness.widgets.filter(
        (call) => call.key === BRAND_WIDGET_KEY && Array.isArray(call.content),
      )).toHaveLength(1);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("reflows the TUI Text rows when the available width shrinks", async () => {
    const fixture = await createTempRepository();
    const harness = createUiHarness(fixture.repo);
    try {
      await expect(showIntentumWelcome(harness.context, 113)).resolves.toBe(true);
      const factory = harness.widgets.find((call) => typeof call.content === "function")?.content;
      if (typeof factory !== "function") throw new Error("expected a responsive welcome widget factory");
      const component = factory(
        undefined as never,
        { fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[39m` } as never,
      );
      for (const [width, expectedLines] of [[113, 18], [58, 6], [57, 6], [21, 6], [20, 6], [12, 6], [11, 1]] as const) {
        const lines = component.render(width);
        expect(lines, `render width ${width}`).toHaveLength(expectedLines);
        expect(lines.every((line: string) => stripAnsi(line).length <= width), `render width ${width}`).toBe(true);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps durable initialization successful when the welcome UI observer fails", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    const harness = createUiHarness(fixture.repo, "tui", true);
    try {
      await expect(handleIntentumCommand(runtime, "init Observer Failure", harness.context)).resolves.toBeUndefined();
      expect((await runtime.store.read()).projectName).toBe("Observer Failure");
      await expect(Promise.all([
        runtime.store.readArtifact("charter"),
        runtime.store.readArtifact("architecture"),
      ])).resolves.toHaveLength(2);
      expect(harness.notifications.at(-1)?.message).toContain("intentum initialized Observer Failure");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("falls back to plain uninitialized help when the welcome UI observer fails", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    const harness = createUiHarness(fixture.repo, "tui", true);
    try {
      await expect(handleIntentumCommand(runtime, "", harness.context)).resolves.toBeUndefined();
      expect(harness.notifications.at(-1)?.message).toContain("/intentum init [project name]");
      expect(await runtime.store.exists()).toBe(false);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("does not replay the welcome banner during an initialized session restore", async () => {
    const fixture = await createTempRepository();
    const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<unknown>>();
    const harness = createUiHarness(fixture.repo);
    await new ProjectStore(fixture.repo).initialize({ projectName: "Restored Fixture" });
    const fake = {
      registerCommand() {},
      registerTool() {},
      on(event: string, handler: (event: unknown, context: ExtensionContext) => Promise<unknown>) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    intentumExtension(fake);
    try {
      await handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, harness.context);
      expect(
        harness.widgets.filter((call) => call.key === BRAND_WIDGET_KEY && typeof call.content === "function"),
      ).toHaveLength(0);
      expect(harness.widgets).toContainEqual({ key: BRAND_WIDGET_KEY, content: undefined });
      expect(harness.statuses.some(
        (status) => status.key === "intentum" && status.text?.startsWith("⋗ intentum · DISCOVERY 1/8"),
      )).toBe(true);

      await handlers.get("before_agent_start")?.(
        { type: "before_agent_start", systemPrompt: "base" },
        harness.context,
      );
      expect(harness.widgets.at(-1)).toMatchObject({ key: BRAND_WIDGET_KEY, content: undefined });
    } finally {
      await handlers.get("session_shutdown")?.(
        { type: "session_shutdown", reason: "quit" },
        harness.context,
      );
      await fixture.cleanup();
    }
  });

  it("publishes attention as a theme-rendered component in TUI mode", async () => {
    const fixture = await createTempRepository();
    const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<unknown>>();
    const harness = createUiHarness(fixture.repo);
    const store = new ProjectStore(fixture.repo);
    await store.initialize({ projectName: "Theme Fixture" });
    await store.update((state) => ({
      ...state,
      workers: {
        "W-001": {
          id: "W-001",
          kind: "implementation",
          status: "completed",
          objective: "可见成果 👨‍👩‍👧‍👦",
          updatedAt: "2026-09-04T00:00:00.000Z",
        },
      },
    }));
    const fake = {
      registerCommand() {},
      registerTool() {},
      on(event: string, handler: (event: unknown, context: ExtensionContext) => Promise<unknown>) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    intentumExtension(fake);
    try {
      await handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, harness.context);
      const content = harness.widgets.find((call) => call.key === "intentum" && typeof call.content === "function")?.content;
      if (typeof content !== "function") throw new Error("expected a themed attention component");
      const component = content(
        { requestRender() {} },
        { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
      ) as { render(width: number): string[] };
      const rendered = component.render(80);
      expect(rendered).toEqual(["<success>✓ W-001 Ready for review · 可见成果 👨‍👩‍👧‍👦</success>"]);
      expect(rendered.join("\n")).not.toContain("\u001b[");
    } finally {
      await handlers.get("session_shutdown")?.(
        { type: "session_shutdown", reason: "quit" },
        harness.context,
      );
      await fixture.cleanup();
    }
  });
});

interface UiHarness {
  context: ExtensionCommandContext;
  notifications: Array<{ message: string; type?: string }>;
  widgets: Array<{ key: string; content: unknown }>;
  customs: Array<{ overlay: boolean; rendered: string[] }>;
  statuses: Array<{ key: string; text: string | undefined }>;
}

function createUiHarness(
  cwd: string,
  mode: "tui" | "rpc" = "tui",
  throwOnWidget: boolean | number = false,
): UiHarness {
  const notifications: UiHarness["notifications"] = [];
  const widgets: UiHarness["widgets"] = [];
  const statuses: UiHarness["statuses"] = [];
  const customs: UiHarness["customs"] = [];
  let remainingWidgetFailures = typeof throwOnWidget === "number"
    ? throwOnWidget
    : throwOnWidget ? Number.POSITIVE_INFINITY : 0;
  const ui = {
    notify(message: string, type?: string) {
      notifications.push(type === undefined ? { message } : { message, type });
    },
    setWidget(key: string, content: unknown) {
      if (remainingWidgetFailures > 0) {
        remainingWidgetFailures -= 1;
        throw new Error("UI widget observer unavailable");
      }
      widgets.push({ key, content });
    },
    setStatus(key: string, text: string | undefined) {
      statuses.push({ key, text });
    },
    confirm: async () => true,
    onTerminalInput: () => () => {},
    async custom(
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) =>
        { render(width: number): string[]; dispose?(): void },
      options?: { overlay?: boolean },
    ) {
      // A synchronous stand-in for Pi's overlay: build, render once, then close.
      const tui = { mode: "regular", terminal: { columns: 100, rows: 30, write() {} }, requestRender() {} };
      const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
      const component = await factory(tui, theme, {}, () => {});
      customs.push({ overlay: options?.overlay ?? false, rendered: component.render(96) });
      component.dispose?.();
      return undefined;
    },
  } as unknown as ExtensionUIContext;
  const context = {
    cwd,
    ui,
    mode,
    hasUI: true,
    isProjectTrusted: () => true,
  } as unknown as ExtensionCommandContext;
  return { context, notifications, widgets, statuses, customs };
}

function stripAnsi(value: string): string {
  return value.replaceAll(/\u001b\[[0-9;]*m/g, "");
}
