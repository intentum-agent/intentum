import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import type { IntentumRuntime } from "../runtime/intentum-runtime.js";
import type { ProjectState } from "../state/schema.js";
import { type BrandAssets, intentumLabel, loadBrandAssets } from "./brand.js";
import { phaseLabel, summarizeWorkers } from "./status-widget.js";

/**
 * Session chrome: the startup header and the one-line footer that replace
 * Pi's built-in ones inside an intentum session. Everything here is pure
 * rendering; canonical state stays in the runtime.
 */

const LOGO_GAP = "   ";
/** Below this many columns for the text block, the logo is dropped. */
const MIN_TEXT_COLUMNS = 24;
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
  warning(text: string): string;
  danger(text: string): string;
  /** Applied only to the logo's signal points, never to the wordmark. */
  signal(text: string): string;
}

export const PLAIN_CHROME_STYLE: ChromeStyle = {
  bold: (text) => text,
  dim: (text) => text,
  warning: (text) => text,
  danger: (text) => text,
  signal: (text) => text,
};

export interface SessionInfo {
  readonly version: string;
  /** Model id as Pi selects it (`--model`), or undefined when none is selected. */
  readonly model?: string | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly cwd: string;
  readonly home?: string | undefined;
  readonly unicode?: boolean | undefined;
}

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

/**
 * Header: the small logo beside three lines of session facts, in the shape
 * of a coding-agent startup card. Narrow terminals get the text alone.
 */
export function renderHeaderLines(
  logo: readonly string[],
  info: SessionInfo,
  width: number,
  style: ChromeStyle = PLAIN_CHROME_STYLE,
): string[] {
  const columns = Math.max(1, Math.floor(width));
  const text = [
    `${style.bold("intentum")} ${style.dim(`v${info.version}`)}`,
    style.dim(modelLabel(info.model, info.thinkingLevel)),
    style.dim(formatCwd(info.cwd, info.home)),
  ];
  const logoWidth = logo.reduce((max, line) => Math.max(max, line.length), 0);

  if (logo.length === 0 || columns < logoWidth + LOGO_GAP.length + MIN_TEXT_COLUMNS) {
    return text.map((line) => truncateToWidth(line, columns, ELLIPSIS));
  }

  // Text rows sit on logo rows 1..3 so the block reads as vertically centred.
  const firstTextRow = Math.max(0, Math.floor((logo.length - text.length) / 2));
  const textColumns = columns - logoWidth - LOGO_GAP.length;
  return logo.map((line, index) => {
    const styled = colorSignalPoints(line, style.signal) + " ".repeat(logoWidth - line.length);
    const row = text[index - firstTextRow];
    return row === undefined ? styled.trimEnd() : `${styled}${LOGO_GAP}${truncateToWidth(row, textColumns, ELLIPSIS)}`;
  });
}

/**
 * Footer: identity and phase on the left, branch and context on the right.
 * The model already sits in the header. Only counts that need a glance are
 * added, and the right side yields first when the terminal is narrow.
 */
export function renderFooterLine(input: FooterInput, width: number, style: ChromeStyle = PLAIN_CHROME_STYLE): string {
  const columns = Math.max(1, Math.floor(width));
  const left = footerLeft(input, style);
  const right = footerRight(input, style);
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (rightWidth === 0 || leftWidth + FOOTER_GAP + rightWidth > columns) {
    return truncateToWidth(left, columns, ELLIPSIS);
  }
  return `${left}${" ".repeat(columns - leftWidth - rightWidth)}${right}`;
}

function footerLeft(input: FooterInput, style: ChromeStyle): string {
  const parts: string[] = [];
  const state = input.state;
  if (!state) {
    parts.push(style.dim(`${intentumLabel(undefined, { unicode: input.unicode })} · no project · /intentum init`));
  } else {
    const label = intentumLabel(state.projectName, { unicode: input.unicode });
    parts.push(style.dim(`${label} · ${phaseLabel(state).toLowerCase()} · ${state.autonomy}`));
    const summary = summarizeWorkers(Object.values(state.workers));
    if (summary.active.length) {
      parts.push(style.dim(`${summary.active.length} worker${summary.active.length === 1 ? "" : "s"}`));
    }
    if (summary.attention.length) parts.push(style.danger(`⚠ ${summary.attention.length}`));
    if (state.pendingDecisions.some((decision) => decision.blocking)) parts.push(style.warning("◆ decision"));
  }
  for (const status of input.otherStatuses ?? []) {
    if (status.trim()) parts.push(style.dim(status.trim()));
  }
  return parts.join(style.dim(" · "));
}

function footerRight(input: FooterInput, style: ChromeStyle): string {
  const parts: string[] = [];
  if (input.branch) parts.push(input.branch);
  if (input.context) {
    const percent = input.context.percent === null ? "?" : `${Math.round(input.context.percent)}%`;
    parts.push(`${percent} of ${formatTokens(input.context.contextWindow)}`);
  }
  return parts.length ? style.dim(parts.join(" · ")) : "";
}

function modelLabel(model: string | undefined, thinkingLevel: string | undefined): string {
  if (!model) return "no model selected";
  return thinkingLevel && thinkingLevel !== "off" ? `${model} · ${thinkingLevel}` : model;
}

export function formatCwd(cwd: string, home: string | undefined = process.env.HOME): string {
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
  return cwd;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return `${count}`;
}

function colorSignalPoints(line: string, signal: (text: string) => string): string {
  return line.replace(/o+/g, (points) => signal(points));
}

export async function packageVersion(): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(PACKAGE_JSON_URL, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Replace Pi's startup header and footer for the life of this session.
 * Returns a disposer that restores both. Hosts without header/footer support
 * (RPC, tests) are left untouched.
 */
export async function installSessionChrome(runtime: IntentumRuntime, ctx: ExtensionContext): Promise<() => void> {
  const ui = ctx.ui as Partial<ExtensionContext["ui"]>;
  if (ctx.mode !== "tui" || typeof ui.setHeader !== "function" || typeof ui.setFooter !== "function") {
    return () => {};
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

  const session = (): Pick<SessionInfo, "model" | "thinkingLevel"> => {
    try {
      return { model: ctx.model?.id, thinkingLevel: ctx.thinkingLevel };
    } catch {
      return {};
    }
  };
  const contextUsage = (): ContextInfo | undefined => {
    try {
      const usage = ctx.getContextUsage();
      return usage ? { percent: usage.percent, contextWindow: usage.contextWindow } : undefined;
    } catch {
      return undefined;
    }
  };

  const logo = assets?.logoSmall ?? [];
  ctx.ui.setHeader((_tui, theme) => {
    const style = themeStyle(theme);
    return {
      render: (width: number) => renderHeaderLines(logo, { version, ...session(), cwd: ctx.cwd }, width, style),
      invalidate() {},
    };
  });

  let unsubscribeState = () => {};
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

  return () => {
    unsubscribeState();
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
  };
}

type ThemeLike = {
  fg(color: "dim" | "warning" | "error", text: string): string;
  bold(text: string): string;
};

function themeStyle(theme: ThemeLike): ChromeStyle {
  return {
    bold: (text) => theme.bold(text),
    dim: (text) => theme.fg("dim", text),
    warning: (text) => theme.fg("warning", text),
    danger: (text) => theme.fg("error", text),
    signal: (text) => theme.fg("error", text),
  };
}
