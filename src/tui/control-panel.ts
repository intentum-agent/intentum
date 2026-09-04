import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { PROJECT_PHASES, type DecisionRequest, type ProjectState, type WorkerRecord, type WorkerStatus } from "../state/schema.js";
import { intentumLabel } from "./brand.js";
import { ACTIVE_WORKER_STATUSES, phaseLabel, sortedWorkers, summarizeWorkers, type WorkerSummary } from "./status-widget.js";

export type PanelTab = "overview" | "workers" | "decisions" | "help";
export const PANEL_TABS: readonly PanelTab[] = ["overview", "workers", "decisions", "help"];

export type PanelAction =
  | { type: "close" }
  | { type: "pause-project" }
  | { type: "resume-project" }
  | { type: "show-status" }
  | { type: "steer"; workerId: string }
  | { type: "pause-worker"; workerId: string }
  | { type: "resume-worker"; workerId: string }
  | { type: "integrate"; workerId: string }
  | { type: "abort"; workerId: string }
  | { type: "decide"; decisionId: string; optionId: string }
  | { type: "discuss"; decisionId: string };

export interface PanelStyle {
  accent(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  muted(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  border(text: string): string;
  /** Highlight for the keyboard-focused control. */
  focus(text: string): string;
}

export type MouseAvailability = "available" | "fullscreen" | "unavailable";

export interface ControlPanelOptions {
  state: ProjectState;
  onAction: (action: PanelAction) => void;
  style?: Partial<PanelStyle>;
  unicode?: boolean | undefined;
  mouse?: MouseAvailability;
  initialTab?: PanelTab;
  /** Rows available for the scrolling body. */
  bodyHeight?: number;
}

export interface HitRegion {
  row: number;
  start: number;
  end: number;
  control: Control;
}

export interface SgrMouseEvent {
  button: number;
  /** Zero-based terminal column. */
  x: number;
  /** Zero-based terminal row. */
  y: number;
  release: boolean;
}

interface Control {
  id: string;
  kind: "tab" | "row" | "button" | "close";
  activate: () => void;
}

interface Segment {
  text: string;
  style?: keyof PanelStyle;
  control?: Control;
}

type Line = Segment[];

const PLAIN_STYLE: PanelStyle = {
  accent: (text) => text,
  bold: (text) => text,
  dim: (text) => text,
  muted: (text) => text,
  success: (text) => text,
  warning: (text) => text,
  error: (text) => text,
  border: (text) => text,
  focus: (text) => `\u001b[7m${text}\u001b[27m`,
};

const DEFAULT_BODY_HEIGHT = 14;
const MIN_BODY_HEIGHT = 3;
/** Keep the frame from jumping when a tab has little to show. */
const STABLE_BODY_ROWS = 8;
const WHEEL_LINES = 3;
const ACTIVE_PHASES = PROJECT_PHASES.filter((phase) => phase !== "paused");
const ELLIPSIS = "…";
const SGR_MOUSE_PATTERN = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;

const TAB_LABELS: Record<PanelTab, string> = {
  overview: "Overview",
  workers: "Workers",
  decisions: "Decisions",
  help: "Help",
};

/**
 * Interactive control center. Every control is reachable by keyboard and,
 * when the host forwards SGR mouse reports, by a single click. Rendering is
 * pure: the component records hit regions for the last frame and the host
 * translates absolute terminal coordinates into panel coordinates.
 */
export class IntentumControlPanel implements Component {
  private state: ProjectState;
  private tab: PanelTab;
  private readonly style: PanelStyle;
  private readonly unicode: boolean | undefined;
  private readonly mouse: MouseAvailability;
  private readonly onAction: (action: PanelAction) => void;
  private bodyHeight: number;

  private focusId: string | undefined;
  private selectedWorkerId: string | undefined;
  private selectedDecisionId: string | undefined;
  private readonly expandedWorkers = new Set<string>();
  private scrollTop = 0;
  private suspended = false;

  private regions: HitRegion[] = [];
  private bodyControls: Control[] = [];
  private lastHeight = 0;
  private lastWidth = 0;
  private cachedLines: string[] | undefined;
  private cachedWidth = -1;

  constructor(options: ControlPanelOptions) {
    this.state = options.state;
    this.onAction = options.onAction;
    this.style = { ...PLAIN_STYLE, ...options.style };
    this.unicode = options.unicode;
    this.mouse = options.mouse ?? "unavailable";
    this.tab = options.initialTab ?? "overview";
    this.bodyHeight = Math.max(MIN_BODY_HEIGHT, options.bodyHeight ?? DEFAULT_BODY_HEIGHT);
  }

  get activeTab(): PanelTab {
    return this.tab;
  }

  get height(): number {
    return this.lastHeight;
  }

  get width(): number {
    return this.lastWidth;
  }

  get focusedControlId(): string | undefined {
    return this.focusId;
  }

  get selectedWorker(): string | undefined {
    return this.selectedWorkerId;
  }

  /** Ignore input while a nested dialog owns the conversation. */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
  }

  setState(state: ProjectState): void {
    this.state = state;
    this.invalidate();
  }

  setBodyHeight(rows: number): void {
    const next = Math.max(MIN_BODY_HEIGHT, rows);
    if (next === this.bodyHeight) return;
    this.bodyHeight = next;
    this.invalidate();
  }

  setTab(tab: PanelTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.focusId = undefined;
    this.scrollTop = 0;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = -1;
  }

  handleInput(data: string): void {
    if (this.suspended) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.onAction({ type: "close" });
      return;
    }
    if (matchesKey(data, Key.tab)) return this.cycleTab(1);
    if (matchesKey(data, Key.shift("tab"))) return this.cycleTab(-1);
    const tabIndex = Number.parseInt(data, 10);
    if (data.length === 1 && tabIndex >= 1 && tabIndex <= PANEL_TABS.length) {
      return this.setTab(PANEL_TABS[tabIndex - 1] ?? "overview");
    }
    if (data === "?") return this.setTab("help");
    if (matchesKey(data, Key.down) || matchesKey(data, Key.right) || data === "j") return this.moveFocus(1);
    if (matchesKey(data, Key.up) || matchesKey(data, Key.left) || data === "k") return this.moveFocus(-1);
    if (matchesKey(data, Key.pageDown)) return this.scrollBy(this.bodyHeight - 1);
    if (matchesKey(data, Key.pageUp)) return this.scrollBy(-(this.bodyHeight - 1));
    if (matchesKey(data, Key.home)) return this.focusIndex(0);
    if (matchesKey(data, Key.end)) return this.focusIndex(this.bodyControls.length - 1);
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === "\r" || data === "\n") {
      return this.activateFocused();
    }
    if (data === "p") {
      this.onAction({ type: this.state.phase === "paused" ? "resume-project" : "pause-project" });
    }
  }

  /**
   * Handle a primary-button press at panel-relative coordinates. Returns true
   * when the point was inside the panel, so the host can close it otherwise.
   */
  handleClick(x: number, y: number): boolean {
    this.ensureRendered();
    const inside = x >= 0 && y >= 0 && x < this.lastWidth && y < this.lastHeight;
    if (!inside || this.suspended) return inside;
    const region = this.regions.find((candidate) => candidate.row === y && x >= candidate.start && x < candidate.end);
    if (!region) return true;
    if (region.control.kind !== "tab" && region.control.kind !== "close") this.focusId = region.control.id;
    region.control.activate();
    return true;
  }

  handleWheel(direction: 1 | -1): void {
    if (this.suspended) return;
    this.scrollBy(direction * WHEEL_LINES);
  }

  render(width: number): string[] {
    const boundedWidth = Math.max(24, Math.floor(width));
    if (this.cachedLines && this.cachedWidth === boundedWidth) return this.cachedLines;

    const inner = boundedWidth - 4;
    const body = this.buildBody(inner);
    this.reconcileFocus(body);
    const viewport = this.viewportFor(body.length);

    const regions: HitRegion[] = [];
    const lines: string[] = [];
    const push = (line: Line) => {
      lines.push(this.frameLine(this.layoutLine(line, inner, lines.length, regions), inner));
    };

    lines.push(this.titleLine(inner));
    push(this.tabLine(inner));
    lines.push(this.rule(inner, "├", "┤"));

    const visible = body.slice(viewport.start, viewport.end);
    if (viewport.start > 0) {
      visible[0] = [{ text: `… ${viewport.start} more above`, style: "dim" }];
    }
    if (viewport.end < body.length) {
      visible[visible.length - 1] = [{ text: `… ${body.length - viewport.end} more below`, style: "dim" }];
    }
    for (const line of visible) push(line);
    while (lines.length - 3 < Math.min(this.bodyHeight, STABLE_BODY_ROWS)) push([]);

    lines.push(this.rule(inner, "├", "┤"));
    push(this.hintLine(inner));
    lines.push(this.rule(inner, "╰", "╯"));

    this.regions = regions;
    this.lastHeight = lines.length;
    this.lastWidth = boundedWidth;
    this.cachedLines = lines;
    this.cachedWidth = boundedWidth;
    return lines;
  }

  private ensureRendered(): void {
    if (!this.cachedLines) this.render(this.lastWidth || 80);
  }

  private cycleTab(delta: number): void {
    const index = PANEL_TABS.indexOf(this.tab);
    const next = (index + delta + PANEL_TABS.length) % PANEL_TABS.length;
    this.setTab(PANEL_TABS[next] ?? "overview");
  }

  private moveFocus(delta: number): void {
    this.ensureRendered();
    if (this.bodyControls.length === 0) return this.scrollBy(delta);
    const current = this.bodyControls.findIndex((control) => control.id === this.focusId);
    const next = current === -1
      ? (delta > 0 ? 0 : this.bodyControls.length - 1)
      : (current + delta + this.bodyControls.length) % this.bodyControls.length;
    this.focusIndex(next);
  }

  private focusIndex(index: number): void {
    this.ensureRendered();
    const control = this.bodyControls[Math.max(0, Math.min(index, this.bodyControls.length - 1))];
    if (!control) return;
    this.focusId = control.id;
    this.invalidate();
    this.ensureFocusVisible();
  }

  private activateFocused(): void {
    this.ensureRendered();
    const control = this.bodyControls.find((candidate) => candidate.id === this.focusId);
    if (control) control.activate();
  }

  private scrollBy(lines: number): void {
    this.scrollTop = Math.max(0, this.scrollTop + lines);
    this.invalidate();
  }

  private ensureFocusVisible(): void {
    const body = this.buildBody(Math.max(20, this.lastWidth - 4));
    const row = body.findIndex((line) => line.some((segment) => segment.control?.id === this.focusId));
    if (row === -1) return;
    if (row < this.scrollTop + 1) this.scrollTop = Math.max(0, row - 1);
    if (row >= this.scrollTop + this.bodyHeight - 1) this.scrollTop = row - this.bodyHeight + 2;
    this.invalidate();
  }

  private viewportFor(total: number): { start: number; end: number } {
    if (total <= this.bodyHeight) {
      this.scrollTop = 0;
      return { start: 0, end: total };
    }
    this.scrollTop = Math.min(this.scrollTop, total - this.bodyHeight);
    return { start: this.scrollTop, end: this.scrollTop + this.bodyHeight };
  }

  private reconcileFocus(body: Line[]): void {
    this.bodyControls = [];
    for (const line of body) {
      for (const segment of line) if (segment.control) this.bodyControls.push(segment.control);
    }
    if (this.focusId && this.bodyControls.some((control) => control.id === this.focusId)) return;
    this.focusId = this.bodyControls[0]?.id;
  }

  private titleLine(inner: number): string {
    const phase = ` ${phaseLabel(this.state)} `;
    const label = truncateToWidth(
      ` ${intentumLabel(this.state.projectName, { unicode: this.unicode })} `,
      Math.max(4, inner - visibleWidth(phase) - 1),
      ELLIPSIS,
    );
    const filler = Math.max(1, inner - visibleWidth(label) - visibleWidth(phase));
    return `${this.style.border("╭─")}${this.style.bold(label)}${this.style.border("─".repeat(filler))}${this.style.accent(phase)}${this.style.border("─╮")}`;
  }

  private tabLine(inner: number): Line {
    const summary = summarizeWorkers(Object.values(this.state.workers));
    const counts: Record<PanelTab, string> = {
      overview: "",
      workers: Object.keys(this.state.workers).length ? ` ${Object.keys(this.state.workers).length}` : "",
      decisions: this.state.pendingDecisions.length ? ` ${this.state.pendingDecisions.length}` : "",
      help: "",
    };
    const line: Line = [];
    for (const tab of PANEL_TABS) {
      const active = tab === this.tab;
      const attention = tab === "workers" && summary.attention.length > 0
        || tab === "decisions" && this.state.pendingDecisions.some((decision) => decision.blocking);
      line.push({
        text: ` ${TAB_LABELS[tab]}${counts[tab]} `,
        style: active ? "focus" : attention ? "warning" : "muted",
        control: { id: `tab:${tab}`, kind: "tab", activate: () => this.setTab(tab) },
      });
      line.push({ text: " " });
    }
    const used = line.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
    line.push({ text: " ".repeat(Math.max(0, inner - used - 3)) });
    line.push({ text: " ✕ ", style: "muted", control: { id: "close", kind: "close", activate: () => this.onAction({ type: "close" }) } });
    return line;
  }

  private hintLine(inner: number): Line {
    const mouse = this.mouse === "available"
      ? " · click or scroll"
      : this.mouse === "fullscreen" ? " · mouse: keyboard only in fullscreen" : "";
    const shortMouse = this.mouse === "available"
      ? " · click"
      : this.mouse === "fullscreen" ? " · no mouse in fullscreen" : "";
    const candidates = [
      `↑↓ move · ⏎ act · tab switch · p pause/resume · esc close${mouse}`,
      `↑↓ move · ⏎ act · tab switch · esc close${shortMouse}`,
      "↑↓ ⏎ tab esc · ? help",
    ];
    const text = candidates.find((candidate) => visibleWidth(candidate) <= inner) ?? candidates[candidates.length - 1] ?? "";
    return [{ text, style: "dim" }];
  }

  private buildBody(inner: number): Line[] {
    switch (this.tab) {
      case "overview": return this.overviewBody(inner);
      case "workers": return this.workersBody(inner);
      case "decisions": return this.decisionsBody(inner);
      case "help": return this.helpBody();
    }
  }

  private overviewBody(inner: number): Line[] {
    const state = this.state;
    const workers = sortedWorkers(state);
    const summary = summarizeWorkers(workers);
    const blocking = state.pendingDecisions.find((decision) => decision.blocking);
    const lines: Line[] = [];

    lines.push([{ text: "Next     ", style: "muted" }, { text: nextStep(state, summary, blocking), style: "bold" }]);
    lines.push([{ text: "Phase    ", style: "muted" }, ...this.phaseTrail(inner - 9)]);
    lines.push([
      { text: "Feature  ", style: "muted" },
      { text: `${state.activeFeatureId ?? "none yet"} · autonomy ${state.autonomy} · scheduler ${state.schedulerPaused ? "paused" : "running"}` },
    ]);
    lines.push([]);

    if (blocking) {
      lines.push([
        { text: `◆ Decision required · ${blocking.title}`, style: "warning" },
        { text: "  " },
        this.button("Decide", `overview:decide:${blocking.id}`, () => {
          this.selectedDecisionId = blocking.id;
          this.setTab("decisions");
        }),
      ]);
    }
    for (const worker of summary.results.filter((item) => item.status === "completed").slice(0, 2)) {
      lines.push([
        { text: `✓ ${worker.id} ${clip(worker.objective, inner - 40)} — ready to integrate`, style: "success" },
        { text: "  " },
        this.button("Integrate", `overview:integrate:${worker.id}`, () => this.onAction({ type: "integrate", workerId: worker.id })),
      ]);
    }
    for (const worker of summary.attention.slice(0, 2)) {
      lines.push([
        { text: `⚠ ${worker.id} ${worker.status}: ${clip(worker.blocker ?? worker.objective, inner - 26)}`, style: "error" },
        { text: "  " },
        this.button("Open", `overview:open:${worker.id}`, () => this.openWorker(worker.id)),
      ]);
    }
    for (const worker of summary.active.slice(0, 2)) {
      lines.push([
        { text: `${statusGlyph(worker.status)} ${worker.id} ${worker.status}: ${clip(worker.progressSummary ?? worker.objective, inner - 26)}`, style: "accent" },
        { text: "  " },
        this.button("Open", `overview:open:${worker.id}`, () => this.openWorker(worker.id)),
      ]);
    }
    if (workers.length === 0) {
      lines.push([{ text: "No Worker yet. Describe the outcome you want in chat; the Designer plans and starts the work.", style: "dim" }]);
    } else {
      lines.push([{
        text: `● ${summary.active.length} active · ✓ ${summary.results.length} done · ⚠ ${summary.attention.length} need attention · ◌ ${summary.queued.length} queued`,
        style: "muted",
      }]);
    }
    lines.push([]);

    const actions: Line = [];
    if (state.phase === "paused") {
      actions.push(this.button("Resume project", "overview:resume", () => this.onAction({ type: "resume-project" })));
    } else {
      actions.push(this.button("Pause project", "overview:pause", () => this.onAction({ type: "pause-project" })));
    }
    actions.push({ text: " " }, this.button("Workers", "overview:workers", () => this.setTab("workers")));
    actions.push({ text: " " }, this.button("Decisions", "overview:decisions", () => this.setTab("decisions")));
    actions.push({ text: " " }, this.button("Status text", "overview:status", () => this.onAction({ type: "show-status" })));
    lines.push(actions);
    return lines;
  }

  private phaseTrail(available: number): Line {
    const current = this.state.phase === "paused" ? this.state.phaseBeforePause : this.state.phase;
    const currentIndex = current ? ACTIVE_PHASES.indexOf(current) : -1;
    const compact = available < ACTIVE_PHASES.join(" › ").length;
    const line: Line = [];
    ACTIVE_PHASES.forEach((phase, index) => {
      if (index > 0) line.push({ text: compact ? "›" : " › ", style: "dim" });
      const label = compact ? phase.slice(0, 3) : phase;
      if (index === currentIndex) line.push({ text: this.state.phase === "paused" ? `${label}⏸` : label, style: "accent" });
      else line.push({ text: label, style: index < currentIndex ? "dim" : "muted" });
    });
    return line;
  }

  private workersBody(inner: number): Line[] {
    const workers = sortedWorkers(this.state);
    if (workers.length === 0) {
      return [[{ text: "No Worker yet. New work starts from conversation with the Designer.", style: "dim" }]];
    }
    if (!this.selectedWorkerId || !this.state.workers[this.selectedWorkerId]) {
      this.selectedWorkerId = workers[0]?.id;
    }
    const lines: Line[] = [];
    for (const worker of workers) {
      const selected = worker.id === this.selectedWorkerId;
      const marker = selected ? "▸ " : "  ";
      lines.push([{
        text: `${marker}${worker.id.padEnd(6)} ${worker.kind.padEnd(14)} ${statusGlyph(worker.status)} ${worker.status.padEnd(15)} ${clip(worker.objective, inner - 44)}`,
        style: statusStyle(worker.status),
        control: { id: `worker:${worker.id}`, kind: "row", activate: () => this.selectWorker(worker.id) },
      }]);
      if (!selected) continue;
      const detail = worker.blocker
        ? `blocker: ${clip(worker.blocker, inner - 10)}`
        : worker.progressSummary ? clip(worker.progressSummary, inner - 10) : "no progress report yet";
      lines.push([{ text: "         " }, { text: detail, style: worker.blocker ? "error" : "dim" }]);
      if (worker.pendingInstructions?.length) {
        lines.push([{ text: "         " }, { text: `queued instructions: ${worker.pendingInstructions.length}`, style: "dim" }]);
      }
      const buttons = this.workerButtons(worker);
      if (buttons.length) lines.push([{ text: "         " }, ...buttons]);
      if (this.expandedWorkers.has(worker.id)) {
        for (const [label, value] of workerDetails(worker)) {
          lines.push([{ text: "         " }, { text: label.padEnd(10), style: "muted" }, { text: clip(value, inner - 20) }]);
        }
      }
    }
    return lines;
  }

  private workerButtons(worker: WorkerRecord): Line {
    const buttons: Segment[] = [];
    const add = (label: string, action: PanelAction) => {
      if (buttons.length) buttons.push({ text: " " });
      buttons.push(this.button(label, `worker:${worker.id}:${action.type}`, () => this.onAction(action)));
    };
    const active = ACTIVE_WORKER_STATUSES.includes(worker.status);
    if (active) add("Steer", { type: "steer", workerId: worker.id });
    if (active && worker.status !== "pause_requested" && worker.status !== "verifying") {
      add("Pause", { type: "pause-worker", workerId: worker.id });
    }
    if (worker.status === "paused" || worker.status === "interrupted" || worker.status === "blocked") {
      add("Resume", { type: "resume-worker", workerId: worker.id });
      add("Queue instruction", { type: "steer", workerId: worker.id });
    }
    if (worker.status === "completed") add("Integrate", { type: "integrate", workerId: worker.id });
    if (active) add("Abort", { type: "abort", workerId: worker.id });
    if (buttons.length) buttons.push({ text: " " });
    const expanded = this.expandedWorkers.has(worker.id);
    buttons.push(this.button(expanded ? "Hide details" : "Details", `worker:${worker.id}:details`, () => {
      if (expanded) this.expandedWorkers.delete(worker.id);
      else this.expandedWorkers.add(worker.id);
      this.invalidate();
    }));
    return buttons;
  }

  private decisionsBody(inner: number): Line[] {
    const decisions = [...this.state.pendingDecisions].sort((a, b) => Number(b.blocking) - Number(a.blocking));
    if (decisions.length === 0) {
      return [[{ text: "No pending decision. The Designer asks here when your call is needed.", style: "dim" }]];
    }
    if (!this.selectedDecisionId || !decisions.some((decision) => decision.id === this.selectedDecisionId)) {
      this.selectedDecisionId = decisions[0]?.id;
    }
    const lines: Line[] = [];
    for (const decision of decisions) {
      const selected = decision.id === this.selectedDecisionId;
      lines.push([{
        text: `${selected ? "▸ " : "  "}${decision.blocking ? "◆" : "◇"} ${decision.id}  ${clip(decision.title, inner - 24)}  ${decision.blocking ? "blocking" : "open"}`,
        style: decision.blocking ? "warning" : "muted",
        control: { id: `decision:${decision.id}`, kind: "row", activate: () => this.selectDecision(decision.id) },
      }]);
      if (!selected) continue;
      lines.push([{ text: "    " }, { text: clip(decision.question, inner - 6) }]);
      decision.options.forEach((option, index) => {
        const letter = String.fromCharCode(65 + index);
        lines.push([
          { text: "    " },
          this.button(`Choose ${letter}`, `decision:${decision.id}:${option.id}`, () => {
            this.onAction({ type: "decide", decisionId: decision.id, optionId: option.id });
          }),
          { text: ` ${option.label}`, style: "bold" },
          { text: ` — ${clip(option.consequence, inner - 20 - option.label.length)}`, style: "dim" },
        ]);
      });
      if (decision.recommendation) {
        const recommended = decision.options.find((option) => option.id === decision.recommendation?.optionId);
        lines.push([
          { text: "    " },
          { text: `Designer recommends ${recommended?.label ?? decision.recommendation.optionId}: `, style: "success" },
          { text: clip(decision.recommendation.reason, inner - 40), style: "dim" },
        ]);
      }
      lines.push([
        { text: "    " },
        { text: decision.affectedWorkIds.length ? `Affects ${decision.affectedWorkIds.join(", ")}  ` : "", style: "muted" },
        this.button("Discuss in chat", `decision:${decision.id}:discuss`, () => {
          this.onAction({ type: "discuss", decisionId: decision.id });
        }),
      ]);
      lines.push([]);
    }
    return lines;
  }

  private helpBody(): Line[] {
    const mouse = this.mouse === "available"
      ? "click a tab, a row, or a [button] · wheel scrolls · a click outside the panel closes it"
      : this.mouse === "fullscreen"
        ? "Pi owns the mouse in fullscreen mode; use the keys below"
        : "not available in this host";
    return [
      [{ text: "Mouse    ", style: "muted" }, { text: mouse }],
      [{ text: "Keys     ", style: "muted" }, { text: "↑↓ or j k move · ⏎ act · tab or 1-4 switch tab · p pause/resume · esc close" }],
      [],
      [{ text: "Commands ", style: "muted" }, { text: "/intentum status · workers · decisions · pause · resume" }],
      [{ text: "         " }, { text: "/intentum steer W-ID message · worker-resume W-ID [message]" }],
      [{ text: "         " }, { text: "/intentum integrate W-ID · abort W-ID reason" }],
      [],
      [{ text: "Chat     ", style: "muted" }, { text: "Product decisions, new outcomes, and questions for a Worker go through normal conversation." }],
      [{ text: "         " }, { text: "Choosing a decision here drafts the message; you still send it.", style: "dim" }],
    ];
  }

  private button(label: string, id: string, activate: () => void): Segment {
    return { text: `[${label}]`, style: "accent", control: { id, kind: "button", activate } };
  }

  private openWorker(workerId: string): void {
    this.selectedWorkerId = workerId;
    this.setTab("workers");
    this.focusId = `worker:${workerId}`;
  }

  private selectWorker(workerId: string): void {
    this.selectedWorkerId = workerId;
    this.focusId = `worker:${workerId}`;
    this.invalidate();
  }

  private selectDecision(decisionId: string): void {
    this.selectedDecisionId = decisionId;
    this.focusId = `decision:${decisionId}`;
    this.invalidate();
  }

  private layoutLine(line: Line, inner: number, row: number, regions: HitRegion[]): string {
    let rendered = "";
    let column = 0;
    for (const segment of line) {
      const remaining = inner - column;
      if (remaining <= 0) break;
      const text = visibleWidth(segment.text) > remaining ? truncateToWidth(segment.text, remaining, ELLIPSIS) : segment.text;
      const width = visibleWidth(text);
      if (segment.control) {
        regions.push({ row, start: column + 2, end: column + 2 + width, control: segment.control });
      }
      rendered += this.styleSegment(segment, text);
      column += width;
    }
    return rendered;
  }

  private styleSegment(segment: Segment, text: string): string {
    if (segment.control && segment.control.kind !== "tab" && segment.control.id === this.focusId) {
      return this.style.focus(text);
    }
    return segment.style ? this.style[segment.style](text) : text;
  }

  private frameLine(content: string, inner: number): string {
    const padding = Math.max(0, inner - visibleWidth(content));
    return `${this.style.border("│")} ${content}${" ".repeat(padding)} ${this.style.border("│")}`;
  }

  private rule(inner: number, left: string, right: string): string {
    return this.style.border(`${left}${"─".repeat(inner + 2)}${right}`);
  }
}

/** Parse every SGR mouse report in one stdin chunk; `remainder` is the non-mouse input. */
export function parseMouseSequences(data: string): { events: SgrMouseEvent[]; remainder: string } {
  const events: SgrMouseEvent[] = [];
  for (const match of data.matchAll(SGR_MOUSE_PATTERN)) {
    events.push({
      button: Number.parseInt(match[1] ?? "0", 10),
      x: Number.parseInt(match[2] ?? "1", 10) - 1,
      y: Number.parseInt(match[3] ?? "1", 10) - 1,
      release: match[4] === "m",
    });
  }
  return { events, remainder: events.length ? data.replace(SGR_MOUSE_PATTERN, "") : data };
}

/** Terminal origin of a centred overlay, mirroring the Pi TUI anchor math. */
export function centeredOverlayOrigin(
  terminal: { columns: number; rows: number },
  size: { width: number; height: number },
): { row: number; col: number; width: number; height: number } {
  const width = Math.max(1, Math.min(size.width, terminal.columns));
  const height = Math.max(1, Math.min(size.height, terminal.rows));
  return {
    width,
    height,
    row: Math.max(0, Math.floor((terminal.rows - height) / 2)),
    col: Math.max(0, Math.floor((terminal.columns - width) / 2)),
  };
}

function nextStep(state: ProjectState, summary: WorkerSummary, blocking: DecisionRequest | undefined): string {
  if (state.phase === "paused") return "Project is paused. Resume when you are ready.";
  if (blocking) return `Answer decision ${blocking.id} so blocked work can continue.`;
  const completed = summary.results.find((worker) => worker.status === "completed");
  if (completed) return `Integrate ${completed.id}; its result is verified and waiting.`;
  const stuck = summary.attention[0];
  if (stuck) return `${stuck.id} is ${stuck.status}; resume it or give it an instruction.`;
  if (summary.active.length) return `${summary.active.length} Worker${summary.active.length === 1 ? " is" : "s are"} busy. Steer them or keep shaping the product in chat.`;
  if (state.phase === "discovery") return "Draft the charter from the existing repository; only ask what the tree cannot answer.";
  return "Ask for the next outcome in chat; the Designer turns it into Worker contracts.";
}

function workerDetails(worker: WorkerRecord): Array<[string, string]> {
  const rows: Array<[string, string]> = [["objective", worker.objective]];
  if (worker.featureId) rows.push(["feature", worker.featureId]);
  if (worker.branch) rows.push(["branch", `${worker.branch}${worker.targetBranch ? ` → ${worker.targetBranch}` : ""}`]);
  if (worker.worktreePath) rows.push(["worktree", worker.worktreePath]);
  if (worker.baseCommit) rows.push(["base", worker.baseCommit.slice(0, 12)]);
  if (worker.resultCommit) rows.push(["result", worker.resultCommit.slice(0, 12)]);
  if (worker.sessionRef) rows.push(["session", worker.sessionRef]);
  if (worker.pendingInstructions?.length) rows.push(["queued", worker.pendingInstructions.join(" | ")]);
  rows.push(["updated", worker.updatedAt]);
  return rows;
}

export function statusGlyph(status: WorkerStatus): string {
  switch (status) {
    case "queued": return "◌";
    case "starting": return "◔";
    case "working": return "●";
    case "verifying": return "◐";
    case "pause_requested": return "◑";
    case "paused": return "○";
    case "blocked": return "⚠";
    case "failed": return "✗";
    case "interrupted": return "!";
    case "completed": return "✓";
    case "integrated": return "✓";
  }
}

function statusStyle(status: WorkerStatus): keyof PanelStyle {
  if (ACTIVE_WORKER_STATUSES.includes(status)) return "accent";
  if (status === "completed" || status === "integrated") return "success";
  if (status === "queued") return "muted";
  return "error";
}

function clip(value: string, limit: number): string {
  const collapsed = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const bounded = Math.max(8, limit);
  return collapsed.length <= bounded ? collapsed : `${collapsed.slice(0, bounded - 1)}…`;
}
