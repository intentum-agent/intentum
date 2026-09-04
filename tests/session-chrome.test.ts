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
} from "../src/tui/session-chrome.js";
import { relativeAge, renderWelcomeCard, type WelcomeInput } from "../src/tui/welcome-card.js";

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type LooseFooterFactory = (...args: unknown[]) => { render(width: number): string[] };

const LOGO = ["####", "#######", "    #####ooo", "    #####ooo", "#######", "####"];

const MARKED: ChromeStyle = {
  bold: (text) => `<b>${text}</b>`,
  dim: (text) => `<d>${text}</d>`,
  italic: (text) => `<i>${text}</i>`,
  accent: (text) => `<a>${text}</a>`,
  border: (text) => `<r>${text}</r>`,
  warning: (text) => `<w>${text}</w>`,
  danger: (text) => `<e>${text}</e>`,
  signal: (text) => `<s>${text}</s>`,
};

describe("intentum welcome card", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const info: WelcomeInput = {
    version: "0.1.0",
    model: { name: "Kimi K2.6", provider: "moonshot" },
    thinkingLevel: "medium",
    cwd: "/home/bobby/dev/app",
    home: "/home/bobby",
    state: undefined,
    sessions: [],
    tip: "short tip",
    now,
  };

  it("frames identity beside tips, project, and sessions, then a tip underneath", () => {
    const lines = renderWelcomeCard(LOGO, info, 72);
    expect(lines[0]).toBe(`╭─ intentum v0.1.0 ${"─".repeat(52)}╮`);
    expect(lines.at(-3)).toBe("╰──────────────────────────────────────────────────────────────────────╯");
    expect(lines.at(-2)).toBe("");
    expect(lines.at(-1)).toBe("Tip: short tip");
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
    expect(lines.slice(1, -3).every((line) => visibleWidth(line) === 72)).toBe(true);

    // `│ ` + 20-column left pane + ` │ ` → the right pane starts at column 24.
    const body = lines.slice(1, -3);
    const left = body.map((line) => line.slice(0, 24));
    const right = body.map((line) => line.slice(24));
    expect(body[1]).toBe("│       Welcome!       │ /init [name]  initialize this repository      │");
    expect(left).toContain("│         #####ooo     │");
    expect(left).toContain("│      Kimi K2.6       │");
    expect(left).toContain("│  moonshot · medium   │");
    expect(right).toEqual(expect.arrayContaining([
      " Project                                       │",
      " No project · /init [name]                     │",
      " ~/dev/app                                     │",
      " Recent sessions                               │",
      " No recent sessions                            │",
    ]));
  });

  it("greets a returning project with live counts and its newest sessions", () => {
    const lines = renderWelcomeCard(LOGO, {
      ...info,
      state: busyState(),
      sessions: [
        { title: "Fix login", modified: new Date("2026-09-04T11:58:00Z") },
        { title: "Explore repo", modified: new Date("2026-09-01T12:00:00Z") },
      ],
    }, 80);
    expect(lines.some((line) => line.startsWith("│    Welcome back!     │"))).toBe(true);
    const right = lines.map((line) => line.slice(24, -2).trimEnd());
    expect(right).toEqual(expect.arrayContaining([
      " Fixture Product · build 4/8 · balanced",
      " 2 active · ⚠ 1 need attention",
      " ◆ 1 blocking decision",
      " 2m ago    Fix login",
      " 3d ago    Explore repo",
      " /panel          control panel",
    ]));
  });

  it("says the session list is still loading rather than empty", () => {
    const lines = renderWelcomeCard(LOGO, { ...info, sessions: undefined }, 80);
    expect(lines.some((line) => line.includes("Loading…"))).toBe(true);
    expect(lines.some((line) => line.includes("No recent sessions"))).toBe(false);
  });

  it("drops the frame and keeps the facts in a narrow terminal", () => {
    expect(renderWelcomeCard(LOGO, info, 60)).toEqual(["intentum v0.1.0", "Kimi K2.6 · medium", "~/dev/app"]);
    expect(renderWelcomeCard(LOGO, info, 12).every((line) => visibleWidth(line) <= 12)).toBe(true);
  });

  it("wraps the tip with a hanging indent under its label", () => {
    const tip = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
    const lines = renderWelcomeCard(LOGO, { ...info, tip }, 70);
    const tipLines = lines.slice(lines.indexOf("") + 1);
    expect(tipLines.length).toBeGreaterThan(1);
    expect(tipLines[0]?.startsWith("Tip: one")).toBe(true);
    expect(tipLines.slice(1).every((line) => line.startsWith("     ") && !line.startsWith("      "))).toBe(true);
    expect(tipLines.every((line) => visibleWidth(line) <= 70)).toBe(true);
  });

  it("styles borders, section titles, signal points, and the tip label separately", () => {
    const joined = renderWelcomeCard(LOGO, { ...info, model: undefined }, 80, MARKED).join("\n");
    expect(joined).toContain("<r>╭─</r> <b>intentum</b> <d>v0.1.0</d> <r>");
    expect(joined).toContain("<a><b>Tips</b></a>");
    expect(joined).toContain("#####<s>ooo</s>");
    expect(joined).not.toContain("<s>#");
    expect(joined).toContain("<d>no model selected</d>");
    expect(joined).toContain("<i><w>Tip:</w></i> <i><d>short tip</d></i>");
  });

  it("falls back to ASCII rules and corners when box drawing is disabled", () => {
    const lines = renderWelcomeCard(LOGO, { ...info, unicode: false }, 72);
    expect(lines[0]?.startsWith("+- intentum v0.1.0 ---")).toBe(true);
    expect(lines[1]?.startsWith("| ")).toBe(true);
    expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│─]/);
  });

  it("describes session age at the granularity a glance needs", () => {
    expect(relativeAge(new Date("2026-09-04T11:59:30Z"), now)).toBe("just now");
    expect(relativeAge(new Date("2026-09-04T11:15:00Z"), now)).toBe("45m ago");
    expect(relativeAge(new Date("2026-09-04T03:00:00Z"), now)).toBe("9h ago");
    expect(relativeAge(new Date("2026-08-30T12:00:00Z"), now)).toBe("5d ago");
    expect(relativeAge(new Date("2026-07-01T12:00:00Z"), now)).toBe("2026-07-01");
  });
});

describe("intentum session footer", () => {
  it("names the missing project and the command that creates it", () => {
    expect(renderFooterLine({ state: undefined }, 80)).toBe("⋗ intentum · no project · /init");
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
    const card = renderWelcomeCard(LOGO, {
      version: "0.1.0",
      model: { name: "model\nInjected", provider: "prov\u001b[31mider" },
      thinkingLevel: "medium",
      cwd: "/tmp/project\nInjected",
      home: "/tmp",
      state: undefined,
      sessions: [],
      tip: "short tip",
    }, 100).join("\n");
    expect(card).toContain("model Injected");
    expect(card).toContain("~/project Injected");
    expect(card).not.toContain("\u001b");
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
    expect(footer.render(80)).toEqual(["", "⋗ intentum · no project · /init" + " ".repeat(80 - 31 - 4) + "main"]);
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
