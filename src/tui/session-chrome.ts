import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import type { IntentumRuntime } from "../runtime/intentum-runtime.js";
import type { ProjectState } from "../state/schema.js";
import { type BrandAssets, intentumLabel, loadBrandAssets } from "./brand.js";
import { deriveHarnessPresentation } from "./presentation.js";
import { clipToCellWidth, singleLine } from "./text-layout.js";
import { MAX_RECENT_SESSIONS, type RecentSession, renderWelcomeCard, WELCOME_TIPS } from "./welcome-card.js";

/**
 * Session chrome: the startup welcome card and the one-line footer that
 * replace Pi's built-in ones inside an intentum session. Everything here is
 * pure rendering; canonical state stays in the runtime.
 */

const FOOTER_GAP = 2;
/**
 * Pi always puts one spacer row between the transcript and the editor, and
 * none between the editor and the footer. Mirroring that row below keeps the
 * editor box vertically centred between its neighbours.
 */
const FOOTER_TOP_MARGIN = "";
const ELLIPSIS = "…";
const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);

export interface ChromeStyle {
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  /** Section titles in the welcome card. */
  accent(text: string): string;
  /** Box edges and rules in the welcome card. */
  border(text: string): string;
  warning(text: string): string;
  danger(text: string): string;
  /** Applied only to the logo's signal points, never to the wordmark. */
  signal(text: string): string;
}

export interface DesignerWorkingIndicator {
  readonly message: string;
  readonly frames: readonly string[];
  readonly intervalMs?: number;
}

export const PLAIN_CHROME_STYLE: ChromeStyle = {
  bold: (text) => text,
  dim: (text) => text,
  italic: (text) => text,
  accent: (text) => text,
  border: (text) => text,
  warning: (text) => text,
  danger: (text) => text,
  signal: (text) => text,
};

export interface ContextInfo {
  readonly percent: number | null;
  readonly contextWindow: number;
}

export interface FooterInput {
  readonly state: ProjectState | undefined;
  readonly branch?: string | null | undefined;
  readonly context?: ContextInfo | undefined;
  /** Status texts other extensions published with setStatus(); shown after intentum's own. */
  readonly otherStatuses?: readonly string[] | undefined;
  readonly unicode?: boolean | undefined;
}

interface FooterToken {
  readonly order: number;
  readonly priority: number;
  readonly text: string;
  readonly compact?: string;
  readonly tone: "dim" | "warning" | "danger";
  readonly essential?: boolean;
}

/**
 * Footer: phase, blocking decisions, and exceptional work survive narrow
 * terminals. Identity/activity yield next; branch and context yield first.
 */
export function renderFooterLine(input: FooterInput, width: number, style: ChromeStyle = PLAIN_CHROME_STYLE): string {
  const columns = Math.max(1, Math.floor(width));
  const left = footerLeft(input, columns, style);
  const right = footerRight(input, style);
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (rightWidth === 0 || leftWidth + FOOTER_GAP + rightWidth > columns) {
    return truncateToWidth(left, columns, ELLIPSIS);
  }
  return `${left}${" ".repeat(columns - leftWidth - rightWidth)}${right}`;
}

function footerLeft(input: FooterInput, columns: number, style: ChromeStyle): string {
  const state = input.state;
  if (!state) {
    const text = `${intentumLabel(undefined, { unicode: input.unicode })} · no project · /init`;
    return style.dim(clipToCellWidth(text, columns));
  }

  const model = deriveHarnessPresentation(state);
  const blocking = state.pendingDecisions.filter((decision) => decision.blocking).length;
  const tokens: FooterToken[] = [
    {
      order: 0,
      priority: 80,
      text: intentumLabel(singleLine(state.projectName), { unicode: input.unicode }),
      tone: "dim",
    },
    {
      order: 10,
      priority: 100,
      text: model.phase.label,
      compact: model.phase.paused ? `PAUSED ${model.phase.index}/${model.phase.total}` : `${model.phase.current.toUpperCase()} ${model.phase.index}/${model.phase.total}`,
      tone: "dim",
      essential: true,
    },
  ];
  if (blocking) {
    tokens.push({
      order: 20,
      priority: 99,
      text: `◆ ${blocking} decision${blocking === 1 ? "" : "s"}`,
      compact: `◆${blocking}`,
      tone: "warning",
      essential: true,
    });
  }
  if (model.counts.attention) {
    tokens.push({
      order: 30,
      priority: 98,
      text: `⚠ ${model.counts.attention} attention`,
      compact: `⚠${model.counts.attention}`,
      tone: model.counts.failed || model.counts.interrupted ? "danger" : "warning",
      essential: true,
    });
  }
  if (model.counts.active) {
    tokens.push({ order: 40, priority: 60, text: `● ${model.counts.active} active`, tone: "dim" });
  }
  if (model.counts.review) {
    tokens.push({ order: 50, priority: 55, text: `✓ ${model.counts.review} review`, tone: "dim" });
  }
  if (model.counts.paused) {
    tokens.push({ order: 60, priority: 50, text: `○ ${model.counts.paused} paused`, tone: "dim" });
  }
  tokens.push({ order: 70, priority: 40, text: state.autonomy, tone: "dim" });
  let statusOrder = 80;
  for (const status of input.otherStatuses ?? []) {
    const text = singleLine(status);
    if (text) tokens.push({ order: statusOrder++, priority: 30, text, tone: "dim" });
  }

  const chosen = chooseFooterTokens(tokens, columns);
  const rendered = renderFooterTokens(chosen, style);
  if (visibleWidth(rendered) <= columns) return rendered;

  // At phone-width terminal extremes, punctuation and phase names yield so
  // the three essential facts still survive as independent, styled tokens.
  const minimal = [style.dim(`${model.phase.paused ? "P" : ""}${model.phase.index}/${model.phase.total}`)];
  if (blocking) minimal.push(style.warning(`◆${blocking}`));
  if (model.counts.attention) {
    const formatAttention = model.counts.failed || model.counts.interrupted ? style.danger : style.warning;
    minimal.push(formatAttention(`⚠${model.counts.attention}`));
  }
  return truncateToWidth(minimal.join(style.dim(" ")), columns, ELLIPSIS);
}

function footerRight(input: FooterInput, style: ChromeStyle): string {
  const parts: string[] = [];
  if (input.branch) parts.push(singleLine(input.branch));
  if (input.context) {
    const percent = input.context.percent === null ? "?" : `${Math.round(input.context.percent)}%`;
    parts.push(`${percent} of ${formatTokens(input.context.contextWindow)}`);
  }
  return parts.length ? style.dim(parts.join(" · ")) : "";
}

function chooseFooterTokens(tokens: readonly FooterToken[], columns: number): FooterToken[] {
  const essential = tokens.filter((token) => token.essential).sort((left, right) => left.order - right.order);
  const useCompact = rawFooterWidth(essential, false) > columns;
  const chosen = essential.map((token) => useCompact && token.compact ? { ...token, text: token.compact } : token);
  const optional = tokens
    .filter((token) => !token.essential)
    .sort((left, right) => right.priority - left.priority || left.order - right.order);

  for (const token of optional) {
    const candidate = [...chosen, token].sort((left, right) => left.order - right.order);
    if (rawFooterWidth(candidate, false) <= columns) chosen.push(token);
  }

  const ordered = chosen.sort((left, right) => left.order - right.order);
  if (rawFooterWidth(ordered, false) <= columns) return ordered;
  // Only extreme widths reach this branch; Pi's ANSI-aware truncator in the
  // caller keeps the final grapheme intact after all compact forms are used.
  return ordered;
}

function rawFooterWidth(tokens: readonly FooterToken[], compact: boolean): number {
  return visibleWidth(tokens.map((token) => compact ? (token.compact ?? token.text) : token.text).join(" · "));
}

function renderFooterTokens(tokens: readonly FooterToken[], style: ChromeStyle): string {
  return tokens.map((token) => style[token.tone](token.text)).join(style.dim(" · "));
}
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
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
  const unicode = process.env.INTENTUM_ASCII_MARK !== "1";
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

  let unsubscribeState = () => {};
  try {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const style = themeStyle(theme);
      const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
      unsubscribeState();
      unsubscribeState = runtime.onStateChange((next) => {
        state = next;
        tui.requestRender();
      });
      return {
        render: (width: number) => [
          FOOTER_TOP_MARGIN,
          renderFooterLine(
            {
              state,
              branch: footerData.getGitBranch(),
              context: contextUsage(),
              otherStatuses: [...footerData.getExtensionStatuses()]
                .filter(([key]) => key !== "intentum")
                .map(([, text]) => text),
            },
            width,
            style,
          ),
        ],
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

  let disposed = false;
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
  fg(color: "accent" | "border" | "dim" | "warning" | "error", text: string): string;
  bold(text: string): string;
  italic(text: string): string;
};

function themeStyle(theme: ThemeLike): ChromeStyle {
  return {
    bold: (text) => theme.bold(text),
    dim: (text) => theme.fg("dim", text),
    italic: (text) => theme.italic(text),
    accent: (text) => theme.fg("accent", text),
    border: (text) => theme.fg("border", text),
    warning: (text) => theme.fg("warning", text),
    danger: (text) => theme.fg("error", text),
    signal: (text) => theme.fg("error", text),
  };
}
