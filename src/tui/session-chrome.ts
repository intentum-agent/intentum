import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { type WorkingTreeCounts, workingTreeCounts } from "../git/status.js";
import type { IntentumRuntime } from "../runtime/intentum-runtime.js";
import type { ProjectState } from "../state/schema.js";
import { type BrandAssets, intentumMark, loadBrandAssets } from "./brand.js";
import { deriveHarnessPresentation } from "./presentation.js";
import { resolveSymbolPreset, SYMBOL_SETS, type SymbolPreset, type SymbolSet, symbolPreset } from "./symbols.mjs";
import { clipHeadToCellWidth, singleLine } from "./text-layout.js";
import { formatCwd, MAX_RECENT_SESSIONS, type RecentSession, renderWelcomeCard, WELCOME_TIPS } from "./welcome-card.js";

/**
 * Session chrome: the startup welcome card and the one-line footer that
 * replace Pi's built-in ones inside an intentum session. Everything here is
 * pure rendering; canonical state stays in the runtime.
 */

/** The footer keeps one empty cell on each edge, like the editor border above it. */
const FOOTER_INSET = 1;
const FOOTER_SEPARATOR = " · ";
const PATH_MAX_CELLS = 48;
/** Working-tree counts are refreshed at most this often while the footer repaints. */
const WORKING_TREE_REFRESH_MS = 3_000;
const ELLIPSIS = "…";
const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);

export interface ChromeStyle {
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  muted(text: string): string;
  /** Section titles in the welcome card; phase and active work in the footer. */
  accent(text: string): string;
  /** Box edges and rules in the welcome card. */
  border(text: string): string;
  /** Working directory, tokens in, and context pressure while it is low. */
  link(text: string): string;
  /** Model, tokens out, cost, and context size. */
  label(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  danger(text: string): string;
  /** Applied only to the logo's signal points, never to the wordmark. */
  signal(text: string): string;
}

export type ChromeTone = Exclude<keyof ChromeStyle, "bold" | "italic">;

export interface DesignerWorkingIndicator {
  readonly message: string;
  readonly frames: readonly string[];
  readonly intervalMs?: number;
}

export const PLAIN_CHROME_STYLE: ChromeStyle = {
  bold: (text) => text,
  dim: (text) => text,
  italic: (text) => text,
  muted: (text) => text,
  accent: (text) => text,
  border: (text) => text,
  link: (text) => text,
  label: (text) => text,
  success: (text) => text,
  warning: (text) => text,
  danger: (text) => text,
  signal: (text) => text,
};

export interface ContextInfo {
  readonly percent: number | null;
  readonly contextWindow: number;
}

export interface UsageInfo {
  readonly input: number;
  readonly output: number;
  /** Cumulative session cost in dollars. */
  readonly cost: number;
}

export interface FooterInput {
  readonly state: ProjectState | undefined;
  readonly host?: string | undefined;
  readonly model?: string | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
  readonly branch?: string | null | undefined;
  readonly workingTree?: WorkingTreeCounts | undefined;
  readonly sessionId?: string | undefined;
  readonly usage?: UsageInfo | undefined;
  readonly context?: ContextInfo | undefined;
  /** Status texts other extensions published with setStatus(); shown after intentum's own. */
  readonly otherStatuses?: readonly string[] | undefined;
  readonly symbols?: SymbolPreset | undefined;
}

interface FooterSegment {
  readonly order: number;
  /** Higher survives a narrower terminal longer. */
  readonly priority: number;
  /** Styled text; widths are measured on the visible cells. */
  readonly text: string;
  readonly compact?: string;
  readonly essential?: boolean;
}

/**
 * Footer: icon-led segments joined by dots, session facts on the left and
 * spend on the right. Phase, blocking decisions, and exceptional work survive
 * narrow terminals; everything else yields by priority.
 */
export function renderFooterLine(input: FooterInput, width: number, style: ChromeStyle = PLAIN_CHROME_STYLE): string {
  const columns = Math.max(1, Math.floor(width));
  const preset = input.symbols ?? symbolPreset();
  const symbols = SYMBOL_SETS[preset];
  const left = leftSegments(input, symbols, preset, style);
  const right = rightSegments(input, symbols, style);
  const budget = columns - 2 * FOOTER_INSET;
  const chosen = chooseSegments(left, right, budget);
  if (chosen) {
    const separator = style.dim(FOOTER_SEPARATOR);
    const leftText = chosen.left.map((segment) => segment.text).join(separator);
    const rightText = chosen.right.map((segment) => segment.text).join(separator);
    const inset = " ".repeat(FOOTER_INSET);
    if (!rightText) return `${inset}${leftText}`;
    const gap = " ".repeat(Math.max(1, budget - visibleWidth(leftText) - visibleWidth(rightText)));
    return `${inset}${leftText}${gap}${rightText}${inset}`;
  }

  // At phone-width terminal extremes, punctuation and phase names yield so
  // the essential facts still survive as independent, styled tokens.
  const state = input.state;
  if (!state) return truncateToWidth(style.dim("/init"), columns, ELLIPSIS);
  const model = deriveHarnessPresentation(state);
  const blocking = state.pendingDecisions.filter((decision) => decision.blocking).length;
  const minimal = [style.accent(`${model.phase.paused ? "P" : ""}${model.phase.index}/${model.phase.total}`)];
  if (blocking) minimal.push(style.warning(`${symbols.decision}${blocking}`));
  if (model.counts.attention) {
    const tone = model.counts.failed || model.counts.interrupted ? "danger" : "warning";
    minimal.push(style[tone](`${symbols.attention}${model.counts.attention}`));
  }
  return truncateToWidth(minimal.join(" "), columns, ELLIPSIS);
}

function leftSegments(input: FooterInput, symbols: SymbolSet, preset: SymbolPreset, style: ChromeStyle): FooterSegment[] {
  const state = input.state;
  const segments: FooterSegment[] = state
    ? [{ order: 0, priority: 80, text: style.dim(intentumMark(singleLine(state.projectName), { symbols: preset })) }]
    : [{
      order: 0,
      priority: 100,
      essential: true,
      text: style.dim(`${intentumMark(undefined, { symbols: preset })} · no project · /init`),
      compact: style.dim("/init"),
    }];

  if (input.host) {
    segments.push({ order: 1, priority: 20, text: withIcon(symbols.host, singleLine(input.host)) });
  }
  if (input.model) {
    segments.push({ order: 2, priority: 45, text: style.label(withIcon(symbols.model, modelLabel(input.model, input.thinkingLevel))) });
  }
  if (input.cwd) {
    const shown = clipHeadToCellWidth(formatCwd(input.cwd, input.home), PATH_MAX_CELLS);
    const linked = `\u001b]8;;${pathToFileURL(input.cwd).href}\u0007${shown}\u001b]8;;\u0007`;
    segments.push({ order: 3, priority: 48, text: style.link(withIcon(symbols.folder, linked)) });
  }
  const git = gitText(input, symbols, style);
  if (git) segments.push({ order: 4, priority: 50, text: git });
  if (input.sessionId) {
    segments.push({ order: 5, priority: 28, text: withIcon(symbols.session, singleLine(input.sessionId).slice(0, 8)) });
  }

  if (state) {
    const model = deriveHarnessPresentation(state);
    const blocking = state.pendingDecisions.filter((decision) => decision.blocking).length;
    const compactPhase = model.phase.paused
      ? `PAUSED ${model.phase.index}/${model.phase.total}`
      : `${model.phase.current.toUpperCase()} ${model.phase.index}/${model.phase.total}`;
    segments.push({
      order: 10,
      priority: 100,
      essential: true,
      text: style.accent(withIcon(symbols.phase, model.phase.label)),
      compact: style.accent(withIcon(symbols.phase, compactPhase)),
    });
    if (blocking) {
      segments.push({
        order: 20,
        priority: 99,
        essential: true,
        text: style.warning(withIcon(symbols.decision, `${blocking} decision${blocking === 1 ? "" : "s"}`)),
        compact: style.warning(`${symbols.decision}${blocking}`),
      });
    }
    if (model.counts.attention) {
      const tone: ChromeTone = model.counts.failed || model.counts.interrupted ? "danger" : "warning";
      segments.push({
        order: 30,
        priority: 98,
        essential: true,
        text: style[tone](withIcon(symbols.attention, `${model.counts.attention} attention`)),
        compact: style[tone](`${symbols.attention}${model.counts.attention}`),
      });
    }
    if (model.counts.active) {
      segments.push({ order: 40, priority: 60, text: style.accent(withIcon(symbols.active, `${model.counts.active} active`)) });
    }
    if (model.counts.review) {
      segments.push({ order: 50, priority: 55, text: style.success(withIcon(symbols.review, `${model.counts.review} review`)) });
    }
    if (model.counts.paused) {
      segments.push({ order: 60, priority: 42, text: style.muted(withIcon(symbols.paused, `${model.counts.paused} paused`)) });
    }
    segments.push({ order: 70, priority: 35, text: style.dim(withIcon(symbols.autonomy, state.autonomy)) });
  }

  let statusOrder = 80;
  for (const status of input.otherStatuses ?? []) {
    const text = singleLine(status);
    if (text) segments.push({ order: statusOrder++, priority: 30, text: style.dim(text) });
  }
  return segments;
}

function rightSegments(input: FooterInput, symbols: SymbolSet, style: ChromeStyle): FooterSegment[] {
  const segments: FooterSegment[] = [];
  const usage = input.usage;
  if (usage?.input) {
    segments.push({ order: 0, priority: 44, text: style.link(withIcon(symbols.input, formatTokens(usage.input))) });
  }
  if (usage?.output) {
    segments.push({ order: 1, priority: 44, text: style.label(withIcon(symbols.output, formatTokens(usage.output))) });
  }
  if (usage?.cost) {
    const amount = usage.cost.toFixed(2);
    segments.push({ order: 2, priority: 48, text: style.label(symbols.cost ? `${symbols.cost} ${amount}` : `$${amount}`) });
  }
  const context = input.context;
  if (context) {
    const percent = context.percent;
    const tone: ChromeTone = percent === null ? "muted" : percent > 90 ? "danger" : percent > 70 ? "warning" : "link";
    const shown = percent === null ? "?" : `${percent.toFixed(1)}%`;
    segments.push({
      order: 3,
      priority: 70,
      text: style[tone](withIcon(symbols.context, `${shown}/${formatTokens(context.contextWindow)}`)),
    });
    segments.push({ order: 4, priority: 25, text: style.label(withIcon(symbols.context, formatTokens(context.contextWindow))) });
  }
  return segments;
}

function gitText(input: FooterInput, symbols: SymbolSet, style: ChromeStyle): string | undefined {
  const counts = input.workingTree;
  const dirty = counts !== undefined && (counts.staged > 0 || counts.unstaged > 0 || counts.untracked > 0);
  const parts: string[] = [];
  if (input.branch) parts.push(style[dirty ? "warning" : "success"](withIcon(symbols.branch, singleLine(input.branch))));
  if (counts) {
    if (counts.unstaged) parts.push(style.warning(`*${counts.unstaged}`));
    if (counts.staged) parts.push(style.success(`+${counts.staged}`));
    if (counts.untracked) parts.push(style.link(`?${counts.untracked}`));
  }
  return parts.length ? parts.join(" ") : undefined;
}

function withIcon(icon: string, text: string): string {
  return icon ? `${icon} ${text}` : text;
}

/**
 * Essential segments always stay (compacted when they must); the rest of
 * both sides compete by priority for the remaining cells. Returns undefined
 * when not even the compact essentials fit.
 */
function chooseSegments(
  left: readonly FooterSegment[],
  right: readonly FooterSegment[],
  budget: number,
): { left: FooterSegment[]; right: FooterSegment[] } | undefined {
  const byOrder = (first: FooterSegment, second: FooterSegment) => first.order - second.order;
  const essential = left.filter((segment) => segment.essential).sort(byOrder);
  let chosenLeft = essential;
  if (joinedWidth(essential) > budget) {
    chosenLeft = essential.map((segment) => segment.compact ? { ...segment, text: segment.compact } : segment);
    if (joinedWidth(chosenLeft) > budget) return undefined;
  }
  let chosenRight: FooterSegment[] = [];

  const optional = [
    ...left.filter((segment) => !segment.essential).map((segment) => ({ segment, side: "left" as const })),
    ...right.map((segment) => ({ segment, side: "right" as const })),
  ].sort((first, second) => second.segment.priority - first.segment.priority || first.segment.order - second.segment.order);

  for (const { segment, side } of optional) {
    const candidateLeft = side === "left" ? [...chosenLeft, segment].sort(byOrder) : chosenLeft;
    const candidateRight = side === "right" ? [...chosenRight, segment].sort(byOrder) : chosenRight;
    const rightWidth = joinedWidth(candidateRight);
    if (joinedWidth(candidateLeft) + (rightWidth ? 1 + rightWidth : 0) <= budget) {
      chosenLeft = candidateLeft;
      chosenRight = candidateRight;
    }
  }
  return { left: chosenLeft, right: chosenRight };
}

function joinedWidth(segments: readonly FooterSegment[]): number {
  return segments.reduce(
    (width, segment, index) => width + visibleWidth(segment.text) + (index ? FOOTER_SEPARATOR.length : 0),
    0,
  );
}

function modelLabel(model: string, thinkingLevel: string | undefined): string {
  const safeModel = singleLine(model);
  const safeThinking = thinkingLevel ? singleLine(thinkingLevel) : undefined;
  return safeThinking && safeThinking !== "off" ? `${safeModel} · ${safeThinking}` : safeModel;
}

/** Compact token counts: 512, 1.5K, 18K, 272K, 1M, 1.5M. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 10_000) return `${Math.round(count / 1_000)}K`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${count}`;
}

export async function packageVersion(): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(PACKAGE_JSON_URL, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function reducedMotionEnabled(environment: { readonly INTENTUM_REDUCED_MOTION?: string } = process.env): boolean {
  return environment.INTENTUM_REDUCED_MOTION === "1";
}

/** Pi owns the timer and only animates these frames while the Designer streams. */
export function designerWorkingIndicator(
  style: ChromeStyle = PLAIN_CHROME_STYLE,
  reducedMotion = reducedMotionEnabled(),
): DesignerWorkingIndicator {
  if (reducedMotion) {
    return { message: "Designer working", frames: [style.signal("●")] };
  }
  return {
    message: "Designer working",
    frames: [style.dim("·"), style.dim("•"), style.signal("●"), style.dim("•")],
    intervalMs: 160,
  };
}

/**
 * Replace Pi's startup header and footer for the life of this session.
 * Returns a disposer that restores both. Hosts without header/footer support
 * (RPC, tests) are left untouched.
 */
export async function installSessionChrome(runtime: IntentumRuntime, ctx: ExtensionContext): Promise<() => void> {
  const ui = ctx.ui as Partial<ExtensionContext["ui"]>;
  if (ctx.mode !== "tui") {
    return () => {};
  }

  let indicatorStyle = PLAIN_CHROME_STYLE;
  try {
    const hostTheme = ctx.ui.theme as ThemeLike | undefined;
    if (hostTheme && typeof hostTheme.fg === "function" && typeof hostTheme.bold === "function") {
      indicatorStyle = themeStyle(hostTheme);
    }
  } catch {
    // Test/RPC-like shims may omit the theme getter.
  }
  const working = designerWorkingIndicator(indicatorStyle, reducedMotionEnabled());
  try {
    ui.setWorkingMessage?.(working.message);
    ui.setWorkingIndicator?.({
      frames: [...working.frames],
      ...(working.intervalMs === undefined ? {} : { intervalMs: working.intervalMs }),
    });
  } catch {
    // Older compatible hosts may not expose working-indicator customization.
  }
  let workingRestored = false;
  const restoreWorking = () => {
    if (workingRestored) return;
    workingRestored = true;
    try {
      ui.setWorkingIndicator?.();
      ui.setWorkingMessage?.();
    } catch {
      // Restoration is best-effort while the TUI is shutting down.
    }
  };

  if (typeof ui.setHeader !== "function" || typeof ui.setFooter !== "function") {
    return restoreWorking;
  }

  let assets: BrandAssets | undefined;
  try {
    assets = await loadBrandAssets();
  } catch {
    // Missing artwork degrades to the text-only header.
  }
  const version = await packageVersion();
  const symbols = await resolveSymbolPreset();
  const unicode = symbols !== "ascii";
  const host = hostname().split(".")[0];
  let state: ProjectState | undefined;
  try {
    state = (await runtime.store.exists()) ? await runtime.store.read() : undefined;
  } catch {
    state = undefined;
  }

  const contextUsage = (): ContextInfo | undefined => {
    try {
      const usage = ctx.getContextUsage();
      return usage ? { percent: usage.percent, contextWindow: usage.contextWindow } : undefined;
    } catch {
      return undefined;
    }
  };
  const sessionUsage = (): UsageInfo | undefined => {
    try {
      let input = 0;
      let output = 0;
      let cost = 0;
      for (const entry of ctx.sessionManager.getEntries()) {
        const usage = entry.type === "message"
          ? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
          : entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined;
        if (!usage) continue;
        input += usage.input;
        output += usage.output;
        cost += usage.cost.total;
      }
      return { input, output, cost };
    } catch {
      return undefined;
    }
  };
  const sessionId = (): string | undefined => {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return undefined;
    }
  };
  const selectedModel = (): Pick<FooterInput, "model" | "thinkingLevel"> => {
    try {
      return { model: ctx.model?.name || ctx.model?.id, thinkingLevel: ctx.thinkingLevel };
    } catch {
      return {};
    }
  };

  // The session list reads every session file for this directory, so it must
  // not delay the first frame: the card shows "Loading…" until it arrives.
  let sessions: RecentSession[] | undefined;
  let headerTui: { requestRender(): void } | undefined;
  void recentSessions(ctx).then((list) => {
    sessions = list;
    headerTui?.requestRender();
  });

  const logo = assets?.logoSmall ?? [];
  const tip = WELCOME_TIPS[Math.floor(Math.random() * WELCOME_TIPS.length)] ?? "";
  try {
    ctx.ui.setHeader((tui, theme) => {
      const style = themeStyle(theme);
      headerTui = tui;
      return {
        render: (width: number) => {
          let model: { name: string; provider: string } | undefined;
          let thinkingLevel: string | undefined;
          try {
            model = ctx.model ? { name: ctx.model.name, provider: ctx.model.provider } : undefined;
            thinkingLevel = ctx.thinkingLevel;
          } catch {
            // A host without model state still gets the card.
          }
          return renderWelcomeCard(
            logo,
            { version, model, thinkingLevel, cwd: ctx.cwd, state, sessions, tip, unicode },
            width,
            style,
          );
        },
        invalidate() {},
        dispose() {
          headerTui = undefined;
        },
      };
    });
  } catch {
    restoreWorking();
    return () => {};
  }

  let disposed = false;
  let unsubscribeState = () => {};
  // Working-tree counts come from `git status`, which Pi does not watch; the
  // footer refreshes them off the render path, throttled, and repaints on change.
  let workingTree: WorkingTreeCounts | undefined;
  let workingTreeRefreshedAt = 0;
  let workingTreeRefreshing = false;
  const refreshWorkingTree = (requestRender: () => void) => {
    const now = Date.now();
    if (workingTreeRefreshing || now - workingTreeRefreshedAt < WORKING_TREE_REFRESH_MS) return;
    workingTreeRefreshing = true;
    workingTreeRefreshedAt = now;
    void workingTreeCounts(ctx.cwd).then((next) => {
      workingTreeRefreshing = false;
      if (disposed || sameCounts(next, workingTree)) return;
      workingTree = next;
      requestRender();
    });
  };

  try {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const style = themeStyle(theme);
      const requestRender = () => tui.requestRender();
      const unsubscribeBranch = footerData.onBranchChange(() => {
        workingTreeRefreshedAt = 0;
        requestRender();
      });
      unsubscribeState();
      unsubscribeState = runtime.onStateChange((next) => {
        state = next;
        requestRender();
      });
      return {
        render: (width: number) => {
          refreshWorkingTree(requestRender);
          return [
            renderFooterLine(
              {
                state,
                host,
                ...selectedModel(),
                cwd: ctx.cwd,
                branch: footerData.getGitBranch(),
                workingTree,
                sessionId: sessionId(),
                usage: sessionUsage(),
                context: contextUsage(),
                otherStatuses: [...footerData.getExtensionStatuses()]
                  .filter(([key]) => key !== "intentum")
                  .map(([, text]) => text),
                symbols,
              },
              width,
              style,
            ),
          ];
        },
        invalidate() {},
        dispose() {
          unsubscribeBranch();
          unsubscribeState();
        },
      };
    });
  } catch {
    try {
      ctx.ui.setHeader(undefined);
    } catch {
      // Best-effort rollback of partial chrome installation.
    }
    restoreWorking();
    return () => {};
  }

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribeState();
    headerTui = undefined;
    try {
      ctx.ui.setFooter(undefined);
    } catch {
      // Chrome restoration is best-effort during shutdown.
    }
    try {
      ctx.ui.setHeader(undefined);
    } catch {
      // Chrome restoration is best-effort during shutdown.
    }
    restoreWorking();
  };
}

function sameCounts(left: WorkingTreeCounts | undefined, right: WorkingTreeCounts | undefined): boolean {
  if (!left || !right) return left === right;
  return left.staged === right.staged && left.unstaged === right.unstaged && left.untracked === right.untracked;
}

/**
 * Newest sessions started in this directory, excluding the one being shown.
 * Any failure (no session manager, unreadable directory) reads as "none".
 */
async function recentSessions(ctx: ExtensionContext): Promise<RecentSession[]> {
  try {
    const current = ctx.sessionManager.getSessionFile();
    const list = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
    return list
      .filter((session) => session.path !== current && session.messageCount > 0)
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, MAX_RECENT_SESSIONS)
      .map((session) => ({
        title: singleLine((session.name ?? session.firstMessage).split("\n")[0] ?? "") || "(untitled)",
        modified: session.modified,
      }));
  } catch {
    return [];
  }
}

type ThemeLike = {
  fg(
    color: "accent" | "border" | "dim" | "muted" | "mdLink" | "customMessageLabel" | "success" | "warning" | "error",
    text: string,
  ): string;
  bold(text: string): string;
  italic(text: string): string;
};

function themeStyle(theme: ThemeLike): ChromeStyle {
  return {
    bold: (text) => theme.bold(text),
    dim: (text) => theme.fg("dim", text),
    italic: (text) => theme.italic(text),
    muted: (text) => theme.fg("muted", text),
    accent: (text) => theme.fg("accent", text),
    border: (text) => theme.fg("border", text),
    link: (text) => theme.fg("mdLink", text),
    label: (text) => theme.fg("customMessageLabel", text),
    success: (text) => theme.fg("success", text),
    warning: (text) => theme.fg("warning", text),
    danger: (text) => theme.fg("error", text),
    signal: (text) => theme.fg("error", text),
  };
}
