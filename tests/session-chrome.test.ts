import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import type { ProjectState, WorkerRecord } from "../src/state/schema.js";
import {
  type ChromeStyle,
  designerWorkingIndicator,
  formatTokens,
  installSessionChrome,
  reducedMotionEnabled,
  renderFooterLine,
  renderHeaderLines,
} from "../src/tui/session-chrome.js";

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type LooseFooterFactory = (...args: unknown[]) => { render(width: number): string[] };

const LOGO = ["####", "#######", "    #####ooo", "    #####ooo", "#######", "####"];

const MARKED: ChromeStyle = {
  bold: (text) => `<b>${text}</b>`,
  dim: (text) => `<d>${text}</d>`,
  warning: (text) => `<w>${text}</w>`,
  danger: (text) => `<e>${text}</e>`,
  signal: (text) => `<s>${text}</s>`,
};

describe("intentum session header", () => {
  const info = { version: "0.1.0", model: "kimi-k2.6", thinkingLevel: "medium", cwd: "/home/bobby/dev/app", home: "/home/bobby" };

  it("lays the session card beside the small logo, in Claude Code's shape", () => {
    expect(renderHeaderLines(LOGO, info, 100)).toEqual([
      "####",
      "#######        intentum v0.1.0",
      "    #####ooo   kimi-k2.6 · medium",
      "    #####ooo   ~/dev/app",
      "#######",
      "####",
    ]);
  });

  it("drops the logo and keeps the facts in a narrow terminal", () => {
    expect(renderHeaderLines(LOGO, info, 30)).toEqual(["intentum v0.1.0", "kimi-k2.6 · medium", "~/dev/app"]);
    expect(renderHeaderLines(LOGO, info, 12).every((line) => visibleWidth(line) <= 12)).toBe(true);
  });

  it("styles only the signal points and the wordmark", () => {
    const lines = renderHeaderLines(LOGO, { ...info, model: undefined, thinkingLevel: undefined }, 100, MARKED);
    expect(lines[1]).toBe("#######        <b>intentum</b> <d>v0.1.0</d>");
    expect(lines[2]).toBe("    #####<s>ooo</s>   <d>no model selected</d>");
    expect(lines.join("\n")).not.toContain("<s>#");
  });
});

describe("intentum session footer", () => {
  it("names the missing project and the command that creates it", () => {
    expect(renderFooterLine({ state: undefined }, 80)).toBe("⋗ intentum · no project · /intentum init");
  });

  it("keeps an idle project to identity, phase, and session facts", () => {
    const line = renderFooterLine(
      { state: projectState(), branch: "main", context: { percent: 0, contextWindow: 262_144 } },
      100,
    );
    expect(line).toMatch(/^⋗ intentum · Fixture Product · DISCOVERY 1\/8 · guided {2,}main · 0% of 262k$/);
    expect(visibleWidth(line)).toBe(100);
  });

  it("adds only the counts that need a glance, coloured by severity", () => {
    const line = renderFooterLine({ state: busyState(), otherStatuses: ["plan mode"] }, 400, MARKED);
    expect(line).toBe(
      "<d>⋗ intentum · Fixture Product</d><d> · </d><d>BUILD 4/8</d><d> · </d><w>◆ 1 decision</w><d> · </d><w>⚠ 1 attention</w><d> · </d><d>● 2 active</d><d> · </d><d>balanced</d><d> · </d><d>plan mode</d>",
    );
  });

  it("yields the right side first when the terminal is narrow", () => {
    const line = renderFooterLine({ state: projectState(), branch: "feature/long-branch-name", context: { percent: 12.4, contextWindow: 262_144 } }, 60);
    expect(line).toBe("⋗ intentum · Fixture Product · DISCOVERY 1/8 · guided");
    expect(stripAnsi(renderFooterLine({ state: projectState() }, 20))).toBe("DISCOVERY 1/8");
  });

  it("does not repeat the wordmark when the project is named intentum", () => {
    const state = { ...projectState(), projectName: "intentum" };
    expect(renderFooterLine({ state }, 80)).toBe("⋗ intentum · DISCOVERY 1/8 · guided");
  });

  it("preserves phase, a blocking decision, and exceptional work before identity", () => {
    const line = renderFooterLine({ state: busyState(), branch: "feature/hidden-first" }, 40);
    expect(line).toContain("BUILD 4/8");
    expect(line).toContain("◆ 1 decision");
    expect(line).toContain("⚠ 1 attention");
    expect(line).not.toContain("Fixture Product");
    expect(line).not.toContain("feature/hidden-first");
    expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("keeps essential glyphs at the smallest practical footer width", () => {
    const line = renderFooterLine({ state: busyState() }, 12);
    expect(line).toContain("4/8");
    expect(line).toContain("◆1");
    expect(line).toContain("⚠1");
    expect(visibleWidth(line)).toBeLessThanOrEqual(12);
  });

  it("strips terminal controls from project, branch, model, and cwd labels", () => {
    const state = { ...projectState(), projectName: "\u001b[31mFixture\u001b[0m\nInjected" };
    const footer = renderFooterLine({ state, branch: "main\nInjected" }, 100);
    expect(footer).toContain("Fixture Injected");
    expect(footer).toContain("main Injected");
    expect(footer).not.toContain("\u001b");
    expect(renderHeaderLines(LOGO, {
      version: "0.1.0",
      model: "model\nInjected",
      cwd: "/tmp/project\nInjected",
    }, 100).join("\n")).not.toContain("model\nInjected");
  });

  it("formats context windows the way the footer reads them", () => {
    expect(formatTokens(262_144)).toBe("262k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(512)).toBe("512");
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
      "W-002": worker({ id: "W-002", status: "working", objective: "Session restore" }),
      "W-003": worker({ id: "W-003", status: "verifying", objective: "Dashboard shell" }),
      "W-004": worker({ id: "W-004", status: "blocked", objective: "Mobile navigation", blocker: "Needs D-004." }),
    },
    pendingDecisions: [{
      id: "D-004",
      title: "Authentication method",
      question: "Which login method should the first version use?",
      blocking: true,
      affectedWorkIds: ["W-002", "W-004"],
      options: [{ id: "magic", label: "Magic link", consequence: "Easier onboarding." }],
    }],
  };
}

describe("installSessionChrome", () => {
  it("pads the footer with one blank row to mirror Pi's spacer above the editor", async () => {
    const runtime = {
      store: { exists: async () => false, read: async () => undefined },
      onStateChange: () => () => {},
    } as unknown as IntentumRuntime;
    let footerFactory: FooterFactory | undefined;
    const ctx = {
      mode: "tui",
      cwd: "/home/bobby/dev/app",
      getContextUsage: () => undefined,
      ui: {
        setHeader: () => {},
        setFooter: (factory: FooterFactory | undefined) => {
          footerFactory = factory;
        },
      },
    } as unknown as ExtensionContext;

    const dispose = await installSessionChrome(runtime, ctx);
    expect(footerFactory).toBeDefined();
    const footer = (footerFactory as unknown as LooseFooterFactory)(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { onBranchChange: () => () => {}, getGitBranch: () => "main", getExtensionStatuses: () => new Map() },
    );
    expect(footer.render(80)).toEqual(["", "⋗ intentum · no project · /intentum init" + " ".repeat(80 - 40 - 4) + "main"]);
    dispose();
  });

  it("uses a restrained Designer indicator and restores Pi defaults on dispose", async () => {
    const runtime = {
      store: { exists: async () => false, read: async () => undefined },
      onStateChange: () => () => {},
    } as unknown as IntentumRuntime;
    const messages: Array<string | undefined> = [];
    const indicators: Array<{ frames: string[]; intervalMs?: number } | undefined> = [];
    const ctx = {
      mode: "tui",
      cwd: "/home/bobby/dev/app",
      getContextUsage: () => undefined,
      ui: {
        theme: { fg: (_color: string, text: string) => `<theme>${text}</theme>`, bold: (text: string) => text },
        setWorkingMessage: (message?: string) => messages.push(message),
        setWorkingIndicator: (indicator?: { frames: string[]; intervalMs?: number }) => indicators.push(indicator),
        setHeader: () => {},
        setFooter: () => {},
      },
    } as unknown as ExtensionContext;

    const dispose = await installSessionChrome(runtime, ctx);
    expect(messages).toEqual(["Designer working"]);
    expect(indicators[0]).toMatchObject({ intervalMs: 160 });
    expect(indicators[0]?.frames).toEqual([
      "<theme>·</theme>",
      "<theme>•</theme>",
      "<theme>●</theme>",
      "<theme>•</theme>",
    ]);
    dispose();
    dispose();
    expect(messages).toEqual(["Designer working", undefined]);
    expect(indicators.at(-1)).toBeUndefined();
    expect(indicators).toHaveLength(2);
  });
});

describe("Designer working indicator", () => {
  it("uses a static branded point when reduced motion is requested", () => {
    expect(reducedMotionEnabled({ INTENTUM_REDUCED_MOTION: "1" })).toBe(true);
    expect(reducedMotionEnabled({ INTENTUM_REDUCED_MOTION: "0" })).toBe(false);
    expect(designerWorkingIndicator(MARKED, true)).toEqual({
      message: "Designer working",
      frames: ["<s>●</s>"],
    });
  });
});
