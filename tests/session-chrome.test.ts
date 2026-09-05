import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { hostname } from "node:os";
import { describe, expect, it, vi } from "vitest";
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
  muted: (text) => `<m>${text}</m>`,
  accent: (text) => `<a>${text}</a>`,
  border: (text) => `<r>${text}</r>`,
  link: (text) => `<l>${text}</l>`,
  label: (text) => `<k>${text}</k>`,
  success: (text) => `<g>${text}</g>`,
  warning: (text) => `<w>${text}</w>`,
  danger: (text) => `<e>${text}</e>`,
  signal: (text) => `<s>${text}</s>`,
};

/** Everything a live Pi session hands the footer, in the shape of the target screenshot. */
const SESSION = {
  host: "Bobbys-MacBook-Pro",
  model: "GPT-5.6-Sol",
  thinkingLevel: "xhigh",
  cwd: "/home/bobby/dev/app",
  home: "/home/bobby",
  branch: "main",
  workingTree: { staged: 5, unstaged: 10, untracked: 0 },
  sessionId: "01a06c6f-2bea-7404-b5ba-ff77b27731cb",
  usage: { input: 18_200, output: 13, cost: 0.14 },
  context: { percent: 6.1, contextWindow: 272_000 },
  symbols: "unicode",
} as const;

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
  it("names the missing project and the command that creates it, beside the session facts", () => {
    expect(renderFooterLine({ state: undefined, symbols: "unicode" }, 80)).toBe(" ⋗ intentum · no project · /init");
    const line = stripHyperlinks(renderFooterLine({ ...SESSION, state: undefined }, 140));
    expect(line).toMatch(/^ ⋗ intentum · no project · \/init · ⬢ GPT-5\.6-Sol · xhigh · ▸ ~\/dev\/app · ⑂ main \*10 \+5 · ⌗ 01a06c6f {2,}↑ 18K · ↓ 13 · \$0\.14 · ◫ 6\.1%\/272K $/);
  });

  it("leads with the mark and project, then session facts, then phase, with spend right-aligned", () => {
    const line = renderFooterLine({ ...SESSION, state: projectState() }, 200);
    expect(stripHyperlinks(line)).toBe(
      " ⋗ Fixture Product · ▣ Bobbys-MacBook-Pro · ⬢ GPT-5.6-Sol · xhigh · ▸ ~/dev/app · ⑂ main *10 +5 · ⌗ 01a06c6f · ⚑ DISCOVERY 1/8 · ⚙ guided"
      + " ".repeat(19)
      + "↑ 18K · ↓ 13 · $0.14 · ◫ 6.1%/272K · ◫ 272K ",
    );
    expect(visibleWidth(line)).toBe(200);
  });

  it("links the working directory so terminals can open it", () => {
    const line = renderFooterLine({ ...SESSION, state: projectState() }, 160);
    expect(line).toContain("\u001b]8;;file:///home/bobby/dev/app\u0007~/dev/app\u001b]8;;\u0007");
  });

  it("adds only the counts that need a glance, coloured by severity", () => {
    const line = renderFooterLine({ state: busyState(), otherStatuses: ["plan mode"], symbols: "unicode" }, 400, MARKED);
    expect(line).toBe(
      " <d>⋗ Fixture Product</d><d> · </d><a>⚑ BUILD 4/8</a><d> · </d><w>◆ 1 decision</w><d> · </d><w>⚠ 1 attention</w><d> · </d>"
      + "<a>● 2 active</a><d> · </d><d>⚙ balanced</d><d> · </d><d>plan mode</d>",
    );
  });

  it("colours git by cleanliness and context by pressure", () => {
    const untracked = renderFooterLine({ ...SESSION, state: projectState(), workingTree: { staged: 0, unstaged: 0, untracked: 2 } }, 200, MARKED);
    expect(untracked).toContain("<w>⑂ main</w> <l>?2</l>");
    expect(renderFooterLine({ ...SESSION, state: projectState() }, 200, MARKED)).toContain("<w>⑂ main</w> <w>*10</w> <g>+5</g>");
    expect(renderFooterLine({ ...SESSION, state: projectState(), workingTree: { staged: 0, unstaged: 0, untracked: 0 } }, 200, MARKED))
      .toContain("<g>⑂ main</g><d> · </d>");

    const pressured = renderFooterLine({ ...SESSION, state: projectState(), context: { percent: 91.4, contextWindow: 272_000 } }, 200, MARKED);
    expect(pressured).toContain("<e>◫ 91.4%/272K</e>");
    const unknown = renderFooterLine({ ...SESSION, state: projectState(), context: { percent: null, contextWindow: 272_000 } }, 200, MARKED);
    expect(unknown).toContain("<m>◫ ?/272K</m>");
  });

  it("yields host, session, and totals first and keeps context pressure longest", () => {
    const line = renderFooterLine({ ...SESSION, state: projectState() }, 100);
    expect(stripHyperlinks(line)).toBe(
      " ⋗ Fixture Product · ▸ ~/dev/app · ⑂ main *10 +5 · ⚑ DISCOVERY 1/8      ↑ 18K · $0.14 · ◫ 6.1%/272K ",
    );
    expect(visibleWidth(line)).toBe(100);
    expect(renderFooterLine({ ...SESSION, state: projectState() }, 50)).toBe(" ⋗ Fixture Product · ⚑ DISCOVERY 1/8  ◫ 6.1%/272K ");
    expect(stripAnsi(renderFooterLine({ state: projectState(), symbols: "unicode" }, 20))).toBe(" ⚑ DISCOVERY 1/8");
  });

  it("does not repeat the wordmark when the project is named intentum", () => {
    const state = { ...projectState(), projectName: "intentum" };
    expect(renderFooterLine({ state, symbols: "unicode" }, 80)).toBe(" ⋗ intentum · ⚑ DISCOVERY 1/8 · ⚙ guided");
  });

  it("preserves phase, a blocking decision, and exceptional work before identity", () => {
    const line = renderFooterLine({ ...SESSION, state: busyState() }, 44);
    expect(line).toContain("BUILD 4/8");
    expect(line).toContain("◆ 1 decision");
    expect(line).toContain("⚠ 1 attention");
    expect(line).not.toContain("Fixture Product");
    expect(line).not.toContain("main");
    expect(visibleWidth(line)).toBeLessThanOrEqual(44);
  });

  it("keeps essential glyphs at the smallest practical footer width", () => {
    const line = renderFooterLine({ state: busyState(), symbols: "unicode" }, 12);
    expect(line).toContain("4/8");
    expect(line).toContain("◆1");
    expect(line).toContain("⚠1");
    expect(visibleWidth(line)).toBeLessThanOrEqual(12);
  });

  it("swaps glyph sets per symbol preset", () => {
    const unicode = renderFooterLine({ ...SESSION, state: busyState(), symbols: "unicode" }, 400);
    expect(unicode).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u);
    expect(unicode).toContain("◫ 6.1%/272K");
    expect(unicode).toContain("⚠ 1 attention");
    const nerd = renderFooterLine({ ...SESSION, state: projectState(), symbols: "nerd" }, 200);
    expect(nerd).toContain(" \u{F08C9} Fixture Product · ");
    expect(nerd).toContain("\uF126 main *10 +5");
    expect(nerd).toContain("\uF155 0.14");
    expect(nerd).toContain("\uE70F 6.1%/272K");
    const ascii = stripHyperlinks(renderFooterLine({ ...SESSION, state: projectState(), symbols: "ascii" }, 200));
    expect(ascii).toContain(">• Fixture Product · host Bobbys-MacBook-Pro · GPT-5.6-Sol · xhigh · ~/dev/app · @ main *10 +5 · id 01a06c6f · DISCOVERY 1/8 · guided");
    expect(ascii).toContain("in: 18K · out: 13 · $0.14 · ctx: 6.1%/272K · ctx: 272K");
  });

  it("keeps a long working directory recognisable from its tail", () => {
    const deep = `/home/bobby/${"segment/".repeat(12)}leaf`;
    const line = stripHyperlinks(renderFooterLine({ ...SESSION, state: projectState(), cwd: deep }, 300));
    const shown = /▸ (\S+)/.exec(line)?.[1] ?? "";
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("segment/segment/leaf")).toBe(true);
    expect(visibleWidth(shown)).toBeLessThanOrEqual(48);
    expect(line).not.toContain("~/segment/");
  });

  it("strips terminal controls from project, branch, host, model, and cwd labels", () => {
    const state = { ...projectState(), projectName: "\u001b[31mFixture\u001b[0m\nInjected" };
    const footer = renderFooterLine({ state, branch: "main\nInjected", host: "box\u0007\nInjected", model: "m\rInjected", symbols: "unicode" }, 200);
    expect(footer).toContain("Fixture Injected");
    expect(footer).toContain("main Injected");
    expect(footer).toContain("box Injected");
    expect(footer).toContain("m Injected");
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

  it("formats token counts the way the footer reads them", () => {
    expect(formatTokens(262_144)).toBe("262K");
    expect(formatTokens(18_200)).toBe("18K");
    expect(formatTokens(1_500)).toBe("1.5K");
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatTokens(512)).toBe("512");
  });
});

function stripAnsi(value: string): string {
  return value.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function stripHyperlinks(value: string): string {
  return value.replaceAll(/\u001b\]8;;[^\u0007]*\u0007/g, "");
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
  it("installs a single-row footer fed from the host session", async () => {
    vi.stubEnv("INTENTUM_SYMBOLS", "unicode");
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
    const lines = footer.render(120);
    expect(lines).toHaveLength(1);
    const line = stripHyperlinks(lines[0] ?? "");
    expect(line).toContain(" ⋗ intentum · no project · /init · ");
    expect(line).toContain(`▣ ${hostname().split(".")[0]}`);
    expect(line).toContain("▸ /home/bobby/dev/app · ⑂ main");
    expect(visibleWidth(line)).toBeLessThanOrEqual(120);
    dispose();
    vi.unstubAllEnvs();
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
