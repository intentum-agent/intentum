import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import type { ProjectState, WorkerRecord } from "../src/state/schema.js";
import {
  type ChromeStyle,
  formatTokens,
  installSessionChrome,
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
    expect(line).toMatch(/^⋗ intentum · Fixture Product · discovery 1\/8 · guided {2,}main · 0% of 262k$/);
    expect(visibleWidth(line)).toBe(100);
  });

  it("adds only the counts that need a glance, coloured by severity", () => {
    const line = renderFooterLine({ state: busyState(), otherStatuses: ["plan mode"] }, 400, MARKED);
    expect(line).toBe(
      "<d>⋗ intentum · Fixture Product · build 4/8 · balanced</d><d> · </d><d>2 workers</d><d> · </d><e>⚠ 1</e><d> · </d><w>◆ decision</w><d> · </d><d>plan mode</d>",
    );
  });

  it("yields the right side first when the terminal is narrow", () => {
    const line = renderFooterLine({ state: projectState(), branch: "feature/long-branch-name", context: { percent: 12.4, contextWindow: 262_144 } }, 60);
    expect(line).toBe("⋗ intentum · Fixture Product · discovery 1/8 · guided");
    expect(stripAnsi(renderFooterLine({ state: projectState() }, 20))).toBe("⋗ intentum · Fixtur…");
  });

  it("does not repeat the wordmark when the project is named intentum", () => {
    const state = { ...projectState(), projectName: "intentum" };
    expect(renderFooterLine({ state }, 80)).toBe("⋗ intentum · discovery 1/8 · guided");
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

    await installSessionChrome(runtime, ctx);
    expect(footerFactory).toBeDefined();
    const footer = (footerFactory as unknown as LooseFooterFactory)(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { onBranchChange: () => () => {}, getGitBranch: () => "main", getExtensionStatuses: () => new Map() },
    );
    expect(footer.render(80)).toEqual(["", "⋗ intentum · no project · /intentum init" + " ".repeat(80 - 40 - 4) + "main"]);
  });
});
