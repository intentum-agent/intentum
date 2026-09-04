import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ProjectState } from "../state/schema.js";
import { phaseLabel, summarizeWorkers } from "./presentation.js";
import type { ChromeStyle } from "./session-chrome.js";
import { singleLine } from "./text-layout.js";

/**
 * Startup welcome card: a bordered two-pane box in the shape of a coding-agent
 * launch screen. Identity and logo on the left; tips, project facts, and
 * recent sessions on the right; one rotating tip underneath. Pure rendering.
 */

const ELLIPSIS = "…";
const PANE_PADDING = 1;
/** `│ ` + left + ` │ ` + right + ` │` */
const CARD_OVERHEAD = 3 + 4 * PANE_PADDING;
const LEFT_MIN_WIDTH = 20;
const LEFT_MAX_WIDTH = 32;
/** Below this the right pane truncates every tip; the frame is dropped instead. */
const RIGHT_MIN_WIDTH = 34;
/** Right-pane content is ~50 columns; a wider frame is empty border on wide terminals. */
const CARD_MAX_WIDTH = 100;
const TIP_LABEL = "Tip:";
const TIP_INDENT = " ".repeat(TIP_LABEL.length + 1);
export const MAX_RECENT_SESSIONS = 3;
const RECENT_AGE_WIDTH = 8;
const PROJECT_TIPS: ReadonlyArray<readonly [string, string]> = [
  ["/panel", "control panel"],
  ["/status", "phase, workers, decisions"],
  ["/steer W-001 …", "redirect a running worker"],
  ["/help", "commands for this phase"],
];
const NO_PROJECT_TIPS: ReadonlyArray<readonly [string, string]> = [
  ["/init [name]", "initialize this repository"],
  ["/help", "commands for this state"],
];

/** Facts from README that a returning user is likely to have forgotten. */
export const WELCOME_TIPS: readonly string[] = [
  "`/pause` steers a live Worker to a safe boundary and keeps its worktree; `/intentum resume` continues in the same phase",
  "`/steer W-001 message` is written to a durable outbox before it reaches Pi, so a crash mid-turn never loses an instruction",
  "A completed Worker result waits until you or the Designer run `/integrate W-001`; nothing merges on its own",
  "Workers run in external Git worktrees on `intentum/F-001/W-001`; your checkout and branch stay untouched until integration",
  "Set \"quietStartup\": true in ~/.pi/agent/settings.json to hide Pi's Skills/Prompts/Extensions listing above this card",
  "Choosing a decision in `/decisions` drafts the reply into the editor; you still send it yourself",
  "`intentum --tui-mode regular` gives the control panel mouse support: click tabs, rows, and [buttons]",
];

export interface WelcomeModel {
  /** Display name, e.g. `Claude Sonnet 4.5`. */
  readonly name: string;
  readonly provider: string;
}

export interface RecentSession {
  readonly title: string;
  readonly modified: Date;
}

export interface WelcomeInput {
  readonly version: string;
  readonly model?: WelcomeModel | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly cwd: string;
  readonly home?: string | undefined;
  readonly state: ProjectState | undefined;
  /** `undefined` while the session list is still loading. */
  readonly sessions: readonly RecentSession[] | undefined;
  readonly tip: string;
  readonly now?: Date | undefined;
  /** Box-drawing glyphs; ASCII corners and rules when false. */
  readonly unicode?: boolean | undefined;
}

interface BoxGlyphs {
  readonly tl: string;
  readonly tr: string;
  readonly bl: string;
  readonly br: string;
  readonly h: string;
  readonly v: string;
}

const UNICODE_BOX: BoxGlyphs = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
const ASCII_BOX: BoxGlyphs = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };

const PLAIN_STYLE: ChromeStyle = {
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

export function renderWelcomeCard(
  logo: readonly string[],
  input: WelcomeInput,
  width: number,
  style: ChromeStyle = PLAIN_STYLE,
): string[] {
  const columns = Math.min(CARD_MAX_WIDTH, Math.max(1, Math.floor(width)));
  const left = leftPane(logo, input, style);
  const leftWidth = Math.min(
    Math.max(LEFT_MIN_WIDTH, Math.min(LEFT_MAX_WIDTH, left.reduce((max, line) => Math.max(max, visibleWidth(line)), 0))),
    columns - CARD_OVERHEAD - RIGHT_MIN_WIDTH,
  );
  if (leftWidth < LEFT_MIN_WIDTH) return stackedFallback(input, columns, style);

  const rightWidth = columns - CARD_OVERHEAD - leftWidth;
  const right = rightPane(input, rightWidth, style);
  const box = input.unicode === false ? ASCII_BOX : UNICODE_BOX;
  const pad = " ".repeat(PANE_PADDING);
  const edge = style.border(box.v);
  const rows = Math.max(left.length, right.length);

  const lines: string[] = [topBorder(box, `${style.bold("intentum")} ${style.dim(`v${input.version}`)}`, columns, style)];
  for (let row = 0; row < rows; row += 1) {
    const leftCell = center(left[row] ?? "", leftWidth);
    const rightCell = padRight(right[row] ?? "", rightWidth);
    lines.push(`${edge}${pad}${leftCell}${pad}${edge}${pad}${rightCell}${pad}${edge}`);
  }
  lines.push(style.border(`${box.bl}${box.h.repeat(columns - 2)}${box.br}`));
  lines.push("", ...tipLines(input.tip, columns, style));
  return lines;
}

function topBorder(box: BoxGlyphs, title: string, columns: number, style: ChromeStyle): string {
  // `╭─ title ─…─╮`: corner, one rule, space, title, space, rules, corner.
  const rule = Math.max(0, columns - 5 - visibleWidth(title));
  return `${style.border(`${box.tl}${box.h}`)} ${title} ${style.border(`${box.h.repeat(rule)}${box.tr}`)}`;
}

function leftPane(logo: readonly string[], input: WelcomeInput, style: ChromeStyle): string[] {
  const logoWidth = logo.reduce((max, line) => Math.max(max, line.length), 0);
  const lines = [
    "",
    style.bold(input.state ? "Welcome back!" : "Welcome!"),
    "",
    ...logo.map((line) => padRight(line, logoWidth).replace(/o+/g, (points) => style.signal(points))),
    "",
  ];
  if (input.model) {
    const thinking = safeThinking(input.thinkingLevel);
    const provider = singleLine(input.model.provider);
    lines.push(singleLine(input.model.name), style.dim(thinking ? `${provider} · ${thinking}` : provider));
  } else {
    lines.push(style.dim("no model selected"));
  }
  lines.push("");
  return lines;
}

function rightPane(input: WelcomeInput, width: number, style: ChromeStyle): string[] {
  const sections: ReadonlyArray<readonly [string, string[]]> = [
    ["Tips", tipsSection(input.state, style)],
    ["Project", projectSection(input, style)],
    ["Recent sessions", sessionsSection(input.sessions, input.now ?? new Date(), style)],
  ];
  const rule = style.border((input.unicode === false ? ASCII_BOX : UNICODE_BOX).h.repeat(width));
  const lines: string[] = [];
  sections.forEach(([title, body], index) => {
    if (index > 0) lines.push("", rule);
    lines.push(style.accent(style.bold(title)), ...body);
  });
  return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
}

function tipsSection(state: ProjectState | undefined, style: ChromeStyle): string[] {
  const tips = state ? PROJECT_TIPS : NO_PROJECT_TIPS;
  const commandWidth = tips.reduce((max, [command]) => Math.max(max, command.length), 0);
  const lines = tips.map(([command, effect]) => `${command.padEnd(commandWidth)}  ${style.dim(effect)}`);
  if (!state) lines.push(style.dim("then describe the users and the outcome in chat"));
  return lines;
}

function projectSection(input: WelcomeInput, style: ChromeStyle): string[] {
  const state = input.state;
  const cwd = style.dim(formatCwd(input.cwd, input.home));
  if (!state) return [style.dim("No project · /init [name]"), cwd];

  const lines = [`${singleLine(state.projectName)} ${style.dim(`· ${phaseLabel(state).toLowerCase()} · ${state.autonomy}`)}`];
  const workers = Object.values(state.workers);
  const summary = summarizeWorkers(workers);
  const completed = workers.filter((worker) => worker.status === "completed").length;
  const parts: string[] = [];
  if (summary.active.length) parts.push(`${summary.active.length} active`);
  if (summary.queued.length) parts.push(style.dim(`${summary.queued.length} queued`));
  if (completed) parts.push(`${completed} awaiting integration`);
  if (summary.attention.length) parts.push(style.danger(`⚠ ${summary.attention.length} need attention`));
  lines.push(parts.length ? parts.join(style.dim(" · ")) : style.dim("No workers"));

  const blocking = state.pendingDecisions.filter((decision) => decision.blocking).length;
  if (blocking) lines.push(style.warning(`◆ ${blocking} blocking decision${blocking === 1 ? "" : "s"}`));
  else if (state.pendingDecisions.length) lines.push(`${state.pendingDecisions.length} pending decision${state.pendingDecisions.length === 1 ? "" : "s"}`);
  lines.push(cwd);
  return lines;
}

function sessionsSection(sessions: readonly RecentSession[] | undefined, now: Date, style: ChromeStyle): string[] {
  if (!sessions) return [style.dim("Loading…")];
  if (sessions.length === 0) return [style.dim("No recent sessions")];
  return sessions
    .slice(0, MAX_RECENT_SESSIONS)
    .map((session) => `${style.dim(relativeAge(session.modified, now).padEnd(RECENT_AGE_WIDTH))}  ${session.title}`);
}

function tipLines(tip: string, columns: number, style: ChromeStyle): string[] {
  const label = style.italic(style.warning(TIP_LABEL));
  const bodyWidth = columns - TIP_INDENT.length;
  if (bodyWidth < 8) return [truncateToWidth(`${label} ${style.italic(style.dim(tip))}`, columns, ELLIPSIS)];
  return wrapTextWithAnsi(tip, bodyWidth).map((line, index) =>
    `${index === 0 ? `${label} ` : TIP_INDENT}${style.italic(style.dim(line))}`);
}

export function relativeAge(when: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - when.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return when.toISOString().slice(0, 10);
}

export function formatCwd(cwd: string, home: string | undefined = process.env.HOME): string {
  const displayed = home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
  return singleLine(displayed);
}

function safeThinking(level: string | undefined): string | undefined {
  const safe = level ? singleLine(level) : undefined;
  return safe && safe !== "off" ? safe : undefined;
}

/** Narrow terminals get the facts without the frame. */
function stackedFallback(input: WelcomeInput, columns: number, style: ChromeStyle): string[] {
  const thinking = safeThinking(input.thinkingLevel);
  const model = input.model ? `${singleLine(input.model.name)}${thinking ? ` · ${thinking}` : ""}` : "no model selected";
  return [
    `${style.bold("intentum")} ${style.dim(`v${input.version}`)}`,
    style.dim(model),
    style.dim(formatCwd(input.cwd, input.home)),
  ].map((line) => truncateToWidth(line, columns, ELLIPSIS));
}

function center(line: string, width: number): string {
  const text = truncateToWidth(line, width, ELLIPSIS);
  const slack = width - visibleWidth(text);
  const leading = Math.floor(slack / 2);
  return `${" ".repeat(leading)}${text}${" ".repeat(slack - leading)}`;
}

function padRight(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

