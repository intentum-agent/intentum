import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { DecisionRequest, ProjectState, WorkerRecord, WorkerStatus } from "../state/schema.js";
import type { WorkContract } from "../work/contract.js";
import type { WorkerResult } from "../work/result.js";
import { intentumLabel } from "./brand.js";
import {
  ACTIVE_WORKER_STATUSES,
  deriveHarnessPresentation,
  phaseLabel,
  sortedWorkers,
  workerStatusPresentation,
  type HarnessPresentationModel,
  type PresentationTone,
} from "./presentation.js";
import { clipSingleLine, clipToCellWidth, padToCellWidth, singleLine, wrapToCellWidth } from "./text-layout.js";

export type PanelTab = "overview" | "workers" | "decisions" | "help";
export const PANEL_TABS: readonly PanelTab[] = ["overview", "workers", "decisions", "help"];

export type PanelAction =
  | { type: "close" }
  | { type: "pause-project" }
  | { type: "resume-project" }
  | { type: "show-status" }
  | { type: "inspect-worker"; workerId: string }
  | { type: "steer"; workerId: string }
  | { type: "pause-worker"; workerId: string }
  | { type: "resume-worker"; workerId: string }
  | { type: "integrate"; workerId: string }
  | { type: "abort"; workerId: string }
  | { type: "decide"; decisionId: string; optionId: string }
  | { type: "discuss"; decisionId: string };

/** Host-owned state for an asynchronous panel action. */
export type PanelActionState =
  | { status: "idle" }
  | { status: "loading"; label?: string }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/** Shape returned by the existing `workers.inspect()` API. */
export interface WorkerInspectionDetail {
  worker?: WorkerRecord;
  contract?: WorkContract;
  result?: WorkerResult;
  diagnostic?: string;
}

/** Host-owned state for lazily loaded Worker result evidence. */
export type WorkerDetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; detail: WorkerInspectionDetail }
  | { status: "error"; message: string };

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
  mouse?: MouseAvailability;
  initialTab?: PanelTab;
  /** Rows available for the scrolling body. */
  bodyHeight?: number;
  /** Fill every body row; fullscreen hosts use this to cover the viewport. */
  fillBody?: boolean;
  /** Host-owned animation frame. The component never creates a timer. */
  pulseFrame?: number;
  /** Defaults from INTENTUM_REDUCED_MOTION=1. */
  reducedMotion?: boolean;
  /** Host-selected responsive density; direct callers otherwise derive it from width. */
  density?: "wide" | "compact";
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
  kind: "tab" | "row" | "action" | "close";
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
const STABLE_BODY_ROWS = 8;
const WHEEL_LINES = 3;
const WIDE_PANEL_WIDTH = 100;
const COMPACT_PANEL_WIDTH = 60;
const ELLIPSIS = "…";
const SGR_MOUSE_PATTERN = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const PULSE_FRAMES = ["●", "◉"] as const;

const TAB_LABELS: Record<PanelTab, string> = {
  overview: "Overview",
  workers: "Workers",
  decisions: "Decisions",
  help: "Help",
};

const NARROW_TAB_LABELS: Record<PanelTab, string> = {
  overview: "1 Ov",
  workers: "2 Wk",
  decisions: "3 Dn",
  help: "4 ?",
};

/**
 * Keyboard-first command center. The host owns async work, subscriptions, and
 * animation timers; the panel owns layout, viewport-safe focus, and hit zones.
 */
export class IntentumControlPanel implements Component {
  private state: ProjectState;
  private tab: PanelTab;
  private readonly style: PanelStyle;
  private readonly mouse: MouseAvailability;
  private readonly onAction: (action: PanelAction) => void;
  private readonly reducedMotion: boolean;
  private bodyHeight: number;
  private fillBody: boolean;
  private density: "wide" | "compact" | undefined;
  private pulseFrame: number;
  private actionState: PanelActionState = { status: "idle" };
  private readonly workerDetailStates = new Map<string, WorkerDetailState>();

  private focusId: string | undefined;
  private selectedWorkerId: string | undefined;
  private selectedDecisionId: string | undefined;
  private readonly expandedWorkers = new Set<string>();
  private scrollTop = 0;
  private suspended = false;
  private focusAfterScroll: 1 | -1 | undefined;
  private focusAtViewportStart = false;

  private regions: HitRegion[] = [];
  private allBodyControls: Control[] = [];
  private visibleBodyControls: Control[] = [];
  private readonly controlRows = new Map<string, number>();
  private bodyRowCount = 0;
  private lastHeight = 0;
  private lastWidth = 0;
  private cachedLines: string[] | undefined;
  private cachedWidth = -1;

  constructor(options: ControlPanelOptions) {
    this.state = options.state;
    this.onAction = options.onAction;
    this.style = { ...PLAIN_STYLE, ...options.style };
    this.mouse = options.mouse ?? "unavailable";
    this.tab = options.initialTab ?? "overview";
    this.bodyHeight = Math.max(MIN_BODY_HEIGHT, options.bodyHeight ?? DEFAULT_BODY_HEIGHT);
    this.fillBody = options.fillBody ?? false;
    this.density = options.density;
    this.pulseFrame = normalizeFrame(options.pulseFrame ?? 0);
    this.reducedMotion = options.reducedMotion ?? process.env.INTENTUM_REDUCED_MOTION === "1";
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

  /** Ignore input while a nested confirmation or input dialog owns the UI. */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
  }

  setState(state: ProjectState): void {
    const previous = this.state;
    this.state = state;
    for (const workerId of this.workerDetailStates.keys()) {
      const before = previous.workers[workerId];
      const after = state.workers[workerId];
      const terminalEvidenceChanged = Boolean(after)
        && before?.status !== after?.status
        && (after?.status === "completed" || after?.status === "blocked" || after?.status === "failed");
      if (!after || before?.attemptId !== after.attemptId || before?.resultCommit !== after.resultCommit || terminalEvidenceChanged) {
        this.workerDetailStates.delete(workerId);
        this.expandedWorkers.delete(workerId);
      }
    }
    this.invalidate();
  }

  setActionState(state: PanelActionState): void {
    this.actionState = state;
    if (state.status !== "idle") {
      this.scrollTop = 0;
      this.focusAfterScroll = undefined;
      this.focusId = undefined;
      this.focusAtViewportStart = false;
    }
    this.invalidate();
  }

  setWorkerDetailState(workerId: string, state: WorkerDetailState): void {
    if (state.status === "idle") this.workerDetailStates.delete(workerId);
    else this.workerDetailStates.set(workerId, state);
    this.invalidate();
  }

  /** Update a host-owned pulse frame. No timer is retained by the panel. */
  setPulseFrame(frame: number): void {
    const next = normalizeFrame(frame);
    if (next === this.pulseFrame) return;
    this.pulseFrame = next;
    this.invalidate();
  }

  setBodyHeight(rows: number): void {
    const next = Math.max(MIN_BODY_HEIGHT, rows);
    if (next === this.bodyHeight) return;
    this.bodyHeight = next;
    this.invalidate();
  }

  setFillBody(fill: boolean): void {
    if (fill === this.fillBody) return;
    this.fillBody = fill;
    this.invalidate();
  }

  setDensity(density: "wide" | "compact"): void {
    if (density === this.density) return;
    this.density = density;
    this.invalidate();
  }

  setTab(tab: PanelTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.focusId = undefined;
    this.scrollTop = 0;
    this.focusAtViewportStart = false;
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
    if (matchesKey(data, Key.end)) return this.focusIndex(this.allBodyControls.length - 1);
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === "\r" || data === "\n") {
      return this.activateFocused();
    }
    if (data === "p") {
      this.onAction({ type: this.state.phase === "paused" ? "resume-project" : "pause-project" });
    }
  }

  /** Handle a primary-button press at panel-relative coordinates. */
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
    const wide = this.density === "wide" || (this.density === undefined && boundedWidth >= WIDE_PANEL_WIDTH);
    const body = this.buildBody(inner, wide);
    this.collectBodyControls(body);
    this.bodyRowCount = body.length;
    if (this.focusId && this.focusAtViewportStart) {
      const row = this.controlRows.get(this.focusId);
      if (row !== undefined) this.scrollTop = Math.min(Math.max(0, body.length - this.bodyHeight), Math.max(0, row - 1));
      this.focusAtViewportStart = false;
    } else if (this.focusId && !this.focusAfterScroll) {
      this.ensureControlVisible(this.focusId);
    }
    const viewport = this.viewportFor(body.length);
    const visibleEntries = body.slice(viewport.start, viewport.end).map((line, index) => ({
      line,
      bodyRow: viewport.start + index,
    }));
    if (viewport.start > 0 && visibleEntries[0]) {
      visibleEntries[0] = { line: [{ text: `… ${viewport.start} more above`, style: "dim" }], bodyRow: -1 };
    }
    if (viewport.end < body.length && visibleEntries.length > 0) {
      visibleEntries[visibleEntries.length - 1] = {
        line: [{ text: `… ${body.length - viewport.end} more below`, style: "dim" }],
        bodyRow: -1,
      };
    }
    this.reconcileVisibleFocus(visibleEntries.map((entry) => entry.line));

    const regions: HitRegion[] = [];
    const lines: string[] = [];
    const push = (line: Line) => {
      lines.push(this.frameLine(this.layoutLine(line, inner, lines.length, regions), inner));
    };

    lines.push(this.titleLine(inner));
    push(this.tabLine(inner, boundedWidth));
    lines.push(this.rule(inner, "├", "┤"));
    for (const entry of visibleEntries) push(entry.line);
    const minimumBodyRows = this.fillBody ? this.bodyHeight : Math.min(this.bodyHeight, STABLE_BODY_ROWS);
    while (lines.length - 3 < minimumBodyRows) push([]);
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
    if (this.allBodyControls.length === 0) return this.scrollBy(delta);
    const current = this.allBodyControls.findIndex((control) => control.id === this.focusId);
    const next = current === -1
      ? (delta > 0 ? 0 : this.allBodyControls.length - 1)
      : (current + delta + this.allBodyControls.length) % this.allBodyControls.length;
    this.focusIndex(next);
  }

  private focusIndex(index: number): void {
    this.ensureRendered();
    const control = this.allBodyControls[Math.max(0, Math.min(index, this.allBodyControls.length - 1))];
    if (!control) return;
    this.focusId = control.id;
    this.ensureControlVisible(control.id);
    this.invalidate();
  }

  private activateFocused(): void {
    this.ensureRendered();
    const control = this.visibleBodyControls.find((candidate) => candidate.id === this.focusId);
    if (control) control.activate();
  }

  private scrollBy(lines: number): void {
    this.ensureRendered();
    const maximum = Math.max(0, this.bodyRowCount - this.bodyHeight);
    this.scrollTop = Math.max(0, Math.min(maximum, this.scrollTop + lines));
    this.focusAfterScroll = lines < 0 ? -1 : 1;
    this.invalidate();
  }

  private ensureControlVisible(controlId: string): void {
    const row = this.controlRows.get(controlId);
    if (row === undefined) return;
    const maximum = Math.max(0, this.bodyRowCount - this.bodyHeight);
    if (row < this.scrollTop + (this.scrollTop > 0 ? 1 : 0)) this.scrollTop = Math.max(0, row - 1);
    const viewportEnd = this.scrollTop + this.bodyHeight;
    if (row >= viewportEnd - (viewportEnd < this.bodyRowCount ? 1 : 0)) {
      this.scrollTop = Math.min(maximum, Math.max(0, row - this.bodyHeight + 2));
    }
  }

  private viewportFor(total: number): { start: number; end: number } {
    this.bodyRowCount = total;
    if (total <= this.bodyHeight) {
      this.scrollTop = 0;
      return { start: 0, end: total };
    }
    this.scrollTop = Math.min(this.scrollTop, total - this.bodyHeight);
    return { start: this.scrollTop, end: this.scrollTop + this.bodyHeight };
  }

  private collectBodyControls(body: Line[]): void {
    this.allBodyControls = [];
    this.controlRows.clear();
    const seen = new Set<string>();
    body.forEach((line, row) => {
      for (const segment of line) {
        const control = segment.control;
        if (!control || seen.has(control.id)) continue;
        seen.add(control.id);
        this.allBodyControls.push(control);
        this.controlRows.set(control.id, row);
      }
    });
  }

  private reconcileVisibleFocus(visibleLines: Line[]): void {
    const visible: Control[] = [];
    const seen = new Set<string>();
    for (const line of visibleLines) {
      for (const segment of line) {
        const control = segment.control;
        if (!control || seen.has(control.id)) continue;
        seen.add(control.id);
        visible.push(control);
      }
    }
    this.visibleBodyControls = visible;
    if (this.focusId && visible.some((control) => control.id === this.focusId)) {
      this.focusAfterScroll = undefined;
      return;
    }
    this.focusId = this.focusAfterScroll === -1 ? visible.at(-1)?.id : visible[0]?.id;
    this.focusAfterScroll = undefined;
  }

  private titleLine(inner: number): string {
    const phase = ` ${phaseLabel(this.state)} `;
    const label = truncateToWidth(
      ` ${intentumLabel(singleLine(this.state.projectName))} `,
      Math.max(4, inner - visibleWidth(phase) - 1),
      ELLIPSIS,
    );
    const filler = Math.max(1, inner - visibleWidth(label) - visibleWidth(phase));
    const styledPhase = this.state.phase === "paused" ? this.style.muted(phase) : this.style.accent(phase);
    return `${this.style.border("╭─")}${this.style.bold(label)}${this.style.border("─".repeat(filler))}${styledPhase}${this.style.border("─╮")}`;
  }

  private tabLine(inner: number, panelWidth: number): Line {
    const presentation = deriveHarnessPresentation(this.state);
    const counts: Record<PanelTab, string> = {
      overview: "",
      workers: presentation.counts.total ? ` ${presentation.counts.total}` : "",
      decisions: this.state.pendingDecisions.length ? ` ${this.state.pendingDecisions.length}` : "",
      help: "",
    };
    const labels = panelWidth < COMPACT_PANEL_WIDTH ? NARROW_TAB_LABELS : TAB_LABELS;
    const line: Line = [];
    for (const tab of PANEL_TABS) {
      const active = tab === this.tab;
      const attention = tab === "workers" && presentation.counts.attention > 0
        || tab === "decisions" && Boolean(presentation.blockingDecision);
      const tabTone: keyof PanelStyle = active
        ? "focus"
        : tab === "workers" && (presentation.counts.failed > 0 || presentation.counts.interrupted > 0)
          ? "error"
          : attention ? "warning" : "muted";
      line.push({
        text: ` ${labels[tab]}${counts[tab]} `,
        style: tabTone,
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
    const text = candidates.find((candidate) => visibleWidth(candidate) <= inner) ?? candidates.at(-1) ?? "";
    return [{ text, style: "dim" }];
  }

  private buildBody(inner: number, wide: boolean): Line[] {
    switch (this.tab) {
      case "overview": return wide ? this.overviewBodyWide(inner) : this.overviewBodyCompact(inner);
      case "workers": return wide ? this.workersBodyWide(inner) : this.workersBodyCompact(inner);
      case "decisions": return wide ? this.decisionsBodyWide(inner) : this.decisionsBodyCompact(inner);
      case "help": return wide ? this.helpBodyWide(inner) : this.helpBodyCompact(inner);
    }
  }

  private overviewBodyCompact(inner: number): Line[] {
    const presentation = deriveHarnessPresentation(this.state);
    return [
      this.section("NEXT"),
      ...styledTextLines(presentation.nextStep, inner, "bold"),
      ...this.primaryActionLines(inner, presentation),
      ...this.actionFeedbackLines(inner),
      [],
      this.section("ATTENTION & RESULTS"),
      ...this.overviewAttention(inner, presentation),
      [],
      this.section("ACTIVE WORK"),
      ...this.overviewActive(inner, presentation),
      [],
      this.section("PROJECT"),
      ...this.projectLines(inner, presentation),
      ...this.projectActions(inner),
    ];
  }

  private overviewBodyWide(inner: number): Line[] {
    const presentation = deriveHarnessPresentation(this.state);
    const { left, right } = columnWidths(inner);
    const attention = [this.section("ATTENTION & RESULTS"), ...this.overviewAttention(left, presentation)];
    const active = [this.section("ACTIVE WORK"), ...this.overviewActive(right, presentation)];
    return [
      this.section("NEXT"),
      ...styledTextLines(presentation.nextStep, inner, "bold"),
      ...this.primaryActionLines(inner, presentation),
      ...this.actionFeedbackLines(inner),
      [],
      ...this.combineColumns(attention, active, left, right),
      [],
      this.section("PROJECT"),
      ...this.projectLines(inner, presentation),
      ...this.projectActions(inner),
    ];
  }

  private primaryActionLines(inner: number, presentation: HarnessPresentationModel): Line[] {
    const action = presentation.primaryAction;
    switch (action.kind) {
      case "open-decision": {
        const decision = this.state.pendingDecisions.find((candidate) => candidate.id === action.decisionId);
        return this.wrappedActionLines(inner, action.label, decision?.title ?? action.decisionId, `overview:primary:decision:${action.decisionId}`, () => {
          this.selectedDecisionId = action.decisionId;
          this.setTab("decisions");
        }, "warning");
      }
      case "review-worker": {
        const worker = this.state.workers[action.workerId];
        return this.wrappedActionLines(inner, action.label, worker?.objective ?? action.workerId, `overview:primary:review:${action.workerId}`, () => {
          this.openWorker(action.workerId, true);
        }, "success");
      }
      case "open-worker": {
        const worker = this.state.workers[action.workerId];
        return this.wrappedActionLines(inner, action.label, worker?.objective ?? action.workerId, `overview:primary:worker:${action.workerId}`, () => {
          this.openWorker(action.workerId);
        }, worker ? statusStyle(worker.status) : "accent");
      }
      case "resume-project":
        return this.wrappedActionLines(inner, action.label, "Continue from the preserved phase", "overview:primary:resume", () => {
          this.onAction({ type: "resume-project" });
        });
      case "continue-in-chat":
        return this.wrappedActionLines(inner, action.label, "Return to the Designer editor", "overview:primary:chat", () => {
          this.onAction({ type: "close" });
        }, "muted");
    }
  }

  private overviewAttention(inner: number, presentation: HarnessPresentationModel): Line[] {
    const lines: Line[] = [];
    for (const decision of this.sortedDecisions().filter((item) => item.blocking).slice(0, 2)) {
      lines.push(this.actionLine(
        inner,
        "Decision required",
        `◆ ${decision.id} · ${decision.title}`,
        `overview:decision:${decision.id}`,
        () => {
          this.selectedDecisionId = decision.id;
          this.setTab("decisions");
        },
        "warning",
      ));
    }
    for (const worker of presentation.workers.attention.slice(0, 2)) {
      const detail = worker.blocker ?? worker.objective;
      lines.push(this.actionLine(
        inner,
        workerActionLabel(worker.status),
        `${statusGlyph(worker.status, this.pulseFrame, this.reducedMotion)} ${worker.id} · ${detail}`,
        `overview:open:${worker.id}`,
        () => this.openWorker(worker.id),
        statusStyle(worker.status),
      ));
    }
    for (const worker of presentation.workers.review.slice(0, 2)) {
      lines.push(this.actionLine(
        inner,
        "Review result",
        `✓ ${worker.id} · ${worker.objective}`,
        `overview:review:${worker.id}`,
        () => this.openWorker(worker.id, true),
        "success",
      ));
    }
    if (lines.length === 0) lines.push([{ text: "No result needs review and nothing is blocked.", style: "dim" }]);
    return lines;
  }

  private overviewActive(inner: number, presentation: HarnessPresentationModel): Line[] {
    const lines: Line[] = [];
    for (const worker of presentation.workers.active.slice(0, 3)) {
      const detail = worker.progressSummary ?? worker.objective;
      lines.push(this.actionLine(
        inner,
        workerStatusPresentation(worker.status).label,
        `${statusGlyph(worker.status, this.pulseFrame, this.reducedMotion)} ${worker.id} · ${detail}`,
        `overview:active:${worker.id}`,
        () => this.openWorker(worker.id),
        statusStyle(worker.status),
      ));
    }
    if (presentation.workers.active.length === 0) lines.push([{ text: "No Worker is active.", style: "dim" }]);
    if (presentation.counts.total > 0) {
      lines.push([{
        text: clipSingleLine(
          `${presentation.counts.active} active · ${presentation.counts.review} awaiting review · ${presentation.counts.attention} need attention · ${presentation.counts.queued} queued`,
          inner,
        ),
        style: "muted",
      }]);
    }
    return lines;
  }

  private projectLines(inner: number, presentation: HarnessPresentationModel): Line[] {
    return [
      [{ text: "Phase    ", style: "muted" }, ...this.phaseContext(Math.max(8, inner - 9), presentation)],
      [{ text: "Feature  ", style: "muted" }, {
        text: clipSingleLine(
          `${this.state.activeFeatureId ?? "none yet"} · autonomy ${this.state.autonomy} · scheduler ${this.state.schedulerPaused ? "paused" : "running"}`,
          Math.max(1, inner - 9),
        ),
      }],
    ];
  }

  private projectActions(inner: number): Line[] {
    const toggle = this.state.phase === "paused"
      ? this.actionLine(inner, "Resume project", "Continue from the preserved phase", "overview:resume", () => this.onAction({ type: "resume-project" }))
      : this.actionLine(inner, "Pause project", "Stop Workers at safe points", "overview:pause", () => this.onAction({ type: "pause-project" }), "muted");
    return [
      toggle,
      this.actionLine(inner, "Status text", "Show a copyable plain-text summary", "overview:status", () => this.onAction({ type: "show-status" }), "muted"),
    ];
  }

  private phaseContext(available: number, presentation: HarnessPresentationModel): Line {
    const phase = presentation.phase;
    const current = `${phase.current.toUpperCase()}${phase.paused ? " (paused)" : ""}`;
    const count = `${phase.index}/${phase.total}`;
    const candidates = [
      [phase.previous, current, phase.next].filter(Boolean).join("  ›  ") + `  ·  ${count}`,
      [current, phase.next].filter(Boolean).join("  ›  ") + `  ·  ${count}`,
      `${current}  ·  ${count}`,
    ];
    const text = candidates.find((candidate) => visibleWidth(candidate) <= available)
      ?? clipSingleLine(candidates.at(-1) ?? current, available);
    return [{ text, style: phase.paused ? "muted" : "accent" }];
  }

  private workersBodyCompact(inner: number): Line[] {
    const workers = this.prepareWorkers();
    if (workers.length === 0) {
      return [
        ...this.actionFeedbackLines(inner),
        [{ text: "No Worker yet. New work starts from conversation with the Designer.", style: "dim" }],
      ];
    }
    const lines: Line[] = [...this.actionFeedbackLines(inner)];
    for (const worker of workers) {
      const selected = worker.id === this.selectedWorkerId;
      lines.push(this.workerRow(worker, inner, selected));
      if (selected) lines.push(...this.workerPane(worker, inner));
    }
    return lines;
  }

  private workersBodyWide(inner: number): Line[] {
    const workers = this.prepareWorkers();
    if (workers.length === 0) {
      return [
        ...this.actionFeedbackLines(inner),
        [{ text: "No Worker yet. New work starts from conversation with the Designer.", style: "dim" }],
      ];
    }
    const { left, right } = columnWidths(inner);
    const selected = workers.find((worker) => worker.id === this.selectedWorkerId) ?? workers[0];
    const list: Line[] = [this.section("WORKERS")];
    for (const worker of workers) list.push(this.workerRow(worker, left, worker.id === selected?.id));
    const detail: Line[] = selected
      ? [this.section(`${selected.id} · ${workerStatusPresentation(selected.status).label.toUpperCase()}`), ...this.workerPane(selected, right)]
      : [];
    return [...this.actionFeedbackLines(inner), ...this.combineColumns(list, detail, left, right)];
  }

  private prepareWorkers(): WorkerRecord[] {
    const workers = sortedWorkers(this.state);
    if (!this.selectedWorkerId || !this.state.workers[this.selectedWorkerId]) this.selectedWorkerId = workers[0]?.id;
    return workers;
  }

  private workerRow(worker: WorkerRecord, inner: number, selected: boolean): Line {
    const status = workerStatusPresentation(worker.status);
    return this.controlLine(
      inner,
      `${selected ? "▸" : " "} ${worker.id}  ${statusGlyph(worker.status, this.pulseFrame, this.reducedMotion)} ${status.label}  ·  ${worker.objective}`,
      `worker:${worker.id}`,
      "row",
      () => this.selectWorker(worker.id),
      statusStyle(worker.status),
    );
  }

  private workerPane(worker: WorkerRecord, inner: number): Line[] {
    const lines: Line[] = [];
    const summary = worker.blocker ? `Blocked: ${worker.blocker}` : worker.progressSummary ?? worker.objective;
    lines.push(...styledTextLines(summary, inner, worker.blocker ? statusStyle(worker.status) : "dim"));
    if (worker.pendingInstructions?.length) lines.push([{ text: `Queued instructions: ${worker.pendingInstructions.length}`, style: "muted" }]);
    if (this.expandedWorkers.has(worker.id)) lines.push(...this.workerEvidenceLines(worker, inner));
    lines.push(...this.workerActionLines(worker, inner));
    return lines;
  }

  private workerEvidenceLines(worker: WorkerRecord, inner: number): Line[] {
    const detailState = this.workerDetailStates.get(worker.id) ?? { status: "idle" as const };
    if (detailState.status === "idle") return [[{ text: "Result evidence has not been loaded.", style: "dim" }]];
    if (detailState.status === "loading") return [[{ text: `${this.spinner()} Loading result evidence…`, style: "accent" }]];
    if (detailState.status === "error") {
      return [[{ text: `✕ ${clipSingleLine(detailState.message, Math.max(1, inner - 2))}`, style: "error" }]];
    }

    const { detail } = detailState;
    const result = detail.result;
    const contract = detail.contract;
    const lines: Line[] = [[], this.section("OUTCOME")];
    lines.push(...styledTextLines(
      result?.summary ?? contract?.userVisibleResult ?? "No submitted outcome yet.",
      inner,
      result ? "bold" : "dim",
    ));

    if (result?.userVisibleChanges.length) {
      lines.push(this.section("USER-VISIBLE CHANGES"));
      lines.push(...factLines(result.userVisibleChanges, inner, "success"));
    }
    if (result?.testsRun.length) {
      lines.push(this.section("TEST EVIDENCE"));
      for (const test of result.testsRun) {
        const glyph = test.status === "passed" ? "✓" : test.status === "failed" ? "✕" : "○";
        const tone: keyof PanelStyle = test.status === "passed" ? "success" : test.status === "failed" ? "error" : "muted";
        lines.push(...styledTextLines(`${glyph} ${test.command} · ${test.summary}`, inner, tone));
      }
    }

    const risks = [...(result?.remainingRisks ?? []), ...(result?.architectureConcerns ?? [])];
    if (risks.length || contract?.risk === "high") {
      lines.push(this.section("RISKS"));
      lines.push(...factLines(risks.length ? risks : [`Contract risk: ${contract?.risk}`], inner, "warning"));
    }
    if (result?.suggestedFollowUps.length) {
      lines.push(this.section("NEXT"));
      lines.push(...factLines(result.suggestedFollowUps, inner, "muted"));
    }
    if (detail.diagnostic) lines.push(...styledTextLines(`Diagnostic: ${detail.diagnostic}`, inner, "warning"));

    lines.push(this.section("TECHNICAL"));
    for (const [label, value] of workerTechnicalDetails(detail.worker ?? worker)) {
      lines.push([{ text: `${label.padEnd(9)} `, style: "muted" }, { text: clipSingleLine(value, Math.max(1, inner - 10)) }]);
    }
    return lines;
  }

  private workerActionLines(worker: WorkerRecord, inner: number): Line[] {
    const lines: Line[] = [];
    const active = ACTIVE_WORKER_STATUSES.includes(worker.status);
    const expanded = this.expandedWorkers.has(worker.id);
    const detailState = this.workerDetailStates.get(worker.id);
    const detailLabel = detailState?.status === "error"
      ? "Retry details"
      : expanded ? "Hide details" : worker.status === "completed" ? "Review evidence" : "Details";
    lines.push(this.actionLine(
      inner,
      detailLabel,
      expanded ? "Collapse result and technical evidence" : "Load result and technical evidence",
      `worker:${worker.id}:details`,
      () => this.toggleWorkerDetails(worker.id),
      worker.status === "completed" ? "success" : "muted",
    ));

    const add = (label: string, description: string, action: PanelAction, tone?: keyof PanelStyle) => {
      lines.push(this.actionLine(inner, label, description, `worker:${worker.id}:${action.type}`, () => this.onAction(action), tone));
    };
    if (active && worker.status !== "verifying") {
      add("Steer", "Send or queue an instruction", { type: "steer", workerId: worker.id });
    }
    if (active && worker.status !== "pause_requested" && worker.status !== "verifying") {
      add("Pause safely", "Stop at the next safe point", { type: "pause-worker", workerId: worker.id }, "muted");
    }
    if (worker.status === "paused" || worker.status === "interrupted" || worker.status === "blocked") {
      if (this.state.phase === "paused" || this.state.schedulerPaused) {
        add("Resume project first", "Restore project scheduling before this Worker", { type: "resume-project" });
      } else {
        add("Resume", "Continue the preserved session and worktree", { type: "resume-worker", workerId: worker.id });
      }
      add("Queue instruction", "Add guidance before resuming", { type: "steer", workerId: worker.id });
    }
    if (worker.status === "completed") {
      add("Integrate", "Verify and merge into the recorded target", { type: "integrate", workerId: worker.id }, "success");
    }
    if (active) add("Abort", "Emergency stop; preserve all artifacts", { type: "abort", workerId: worker.id }, "warning");
    return lines;
  }

  private decisionsBodyCompact(inner: number): Line[] {
    const decisions = this.prepareDecisions();
    if (decisions.length === 0) {
      return [
        ...this.actionFeedbackLines(inner),
        [{ text: "No pending decision. The Designer asks here when your call is needed.", style: "dim" }],
      ];
    }
    const lines: Line[] = [...this.actionFeedbackLines(inner)];
    for (const decision of decisions) {
      const selected = decision.id === this.selectedDecisionId;
      lines.push(this.decisionRow(decision, inner, selected));
      if (selected) lines.push(...this.decisionPane(decision, inner));
    }
    return lines;
  }

  private decisionsBodyWide(inner: number): Line[] {
    const decisions = this.prepareDecisions();
    if (decisions.length === 0) {
      return [
        ...this.actionFeedbackLines(inner),
        [{ text: "No pending decision. The Designer asks here when your call is needed.", style: "dim" }],
      ];
    }
    const { left, right } = columnWidths(inner);
    const selected = decisions.find((decision) => decision.id === this.selectedDecisionId) ?? decisions[0];
    const list: Line[] = [this.section("DECISIONS")];
    for (const decision of decisions) list.push(this.decisionRow(decision, left, decision.id === selected?.id));
    const detail = selected ? [this.section(singleLine(selected.title).toUpperCase()), ...this.decisionPane(selected, right)] : [];
    return [...this.actionFeedbackLines(inner), ...this.combineColumns(list, detail, left, right)];
  }

  private prepareDecisions(): DecisionRequest[] {
    const decisions = this.sortedDecisions();
    if (!this.selectedDecisionId || !decisions.some((decision) => decision.id === this.selectedDecisionId)) {
      this.selectedDecisionId = decisions[0]?.id;
    }
    return decisions;
  }

  private sortedDecisions(): DecisionRequest[] {
    return [...this.state.pendingDecisions].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  }

  private decisionRow(decision: DecisionRequest, inner: number, selected: boolean): Line {
    return this.controlLine(
      inner,
      `${selected ? "▸" : " "} ${decision.blocking ? "◆" : "◇"} ${decision.id} · ${decision.title} · ${decision.blocking ? "blocking" : "open"}`,
      `decision:${decision.id}`,
      "row",
      () => this.selectDecision(decision.id),
      decision.blocking ? "warning" : "muted",
    );
  }

  private decisionPane(decision: DecisionRequest, inner: number): Line[] {
    const lines: Line[] = styledTextLines(decision.question, inner, "bold");
    decision.options.forEach((option, index) => {
      const letter = String.fromCharCode(65 + index);
      lines.push(...this.wrappedActionLines(
        inner,
        `Choose ${letter} · ${option.label}`,
        option.consequence,
        `decision:${decision.id}:${option.id}`,
        () => this.onAction({ type: "decide", decisionId: decision.id, optionId: option.id }),
      ));
    });
    if (decision.recommendation) {
      const recommended = decision.options.find((option) => option.id === decision.recommendation?.optionId);
      lines.push(...styledTextLines(
        `Designer recommends ${recommended?.label ?? decision.recommendation.optionId}: ${decision.recommendation.reason}`,
        inner,
        "success",
      ));
    }
    if (decision.affectedWorkIds.length) {
      lines.push(...styledTextLines(`Affects ${decision.affectedWorkIds.join(", ")}`, inner, "muted"));
    }
    lines.push(this.actionLine(
      inner,
      "Discuss in chat",
      "Draft context without resolving the decision",
      `decision:${decision.id}:discuss`,
      () => this.onAction({ type: "discuss", decisionId: decision.id }),
      "muted",
    ));
    return lines;
  }

  private helpBodyCompact(inner: number): Line[] {
    const mouse = this.mouse === "available"
      ? "Click any complete option row; wheel scrolls; clicking outside closes."
      : this.mouse === "fullscreen"
        ? "Pi reserves the mouse in fullscreen; use the keyboard."
        : "Mouse input is unavailable in this host.";
    return [
      this.section("KEYBOARD"),
      [{ text: clipSingleLine("↑↓ or j k move · ⏎ act · tab or 1–4 switch tab · p pause/resume · esc close", inner) }],
      [],
      this.section("MOUSE"),
      [{ text: clipSingleLine(mouse, inner) }],
      [],
      this.section("COMMANDS"),
      [{ text: clipSingleLine("/intentum status · workers · decisions · pause · resume", inner) }],
      [{ text: clipSingleLine("/intentum steer W-ID message · worker-resume W-ID [message]", inner) }],
      [{ text: clipSingleLine("/intentum integrate W-ID · abort W-ID reason", inner) }],
      [],
      [{ text: "Decision choices are drafted into chat; you still send them.", style: "dim" }],
    ];
  }

  private helpBodyWide(inner: number): Line[] {
    const { left, right } = columnWidths(inner);
    const keyboard: Line[] = [
      this.section("KEYBOARD"),
      [{ text: "↑↓ or j k    Move" }],
      [{ text: "Enter        Act" }],
      [{ text: "Tab / 1–4   Switch tab" }],
      [{ text: "p            Pause or resume" }],
      [{ text: "Esc          Close" }],
    ];
    const commands: Line[] = [
      this.section("COMMANDS & MOUSE"),
      [{ text: clipSingleLine("/intentum status · workers · decisions", right) }],
      [{ text: clipSingleLine("/intentum steer W-ID message", right) }],
      [{ text: clipSingleLine("/intentum integrate W-ID", right) }],
      [{ text: clipSingleLine("/intentum abort W-ID reason", right) }],
      [{ text: clipSingleLine(this.mouse === "available" ? "Click full rows · wheel scrolls" : "Keyboard navigation in fullscreen", right), style: "dim" }],
    ];
    return this.combineColumns(keyboard, commands, left, right);
  }

  private actionFeedbackLines(inner: number): Line[] {
    switch (this.actionState.status) {
      case "idle": return [];
      case "loading": return styledTextLines(`${this.spinner()} ${this.actionState.label ?? "Working…"}`, inner, "accent");
      case "success": return styledTextLines(`✓ ${this.actionState.message}`, inner, "success");
      case "error": return styledTextLines(`✕ ${this.actionState.message}`, inner, "error");
    }
  }

  private spinner(): string {
    return this.reducedMotion ? "•" : SPINNER_FRAMES[this.pulseFrame % SPINNER_FRAMES.length] ?? "◐";
  }

  private actionLine(
    inner: number,
    label: string,
    description: string,
    id: string,
    activate: () => void,
    tone: keyof PanelStyle = "accent",
  ): Line {
    return this.controlLine(inner, `› ${label}${description ? `  ·  ${description}` : ""}`, id, "action", activate, tone);
  }

  /** A primary/decision action keeps its complete label and explanatory copy. */
  private wrappedActionLines(
    inner: number,
    label: string,
    description: string,
    id: string,
    activate: () => void,
    tone: keyof PanelStyle = "accent",
  ): Line[] {
    const labelWidth = Math.max(1, inner - 2);
    const labels = wrapToCellWidth(singleLine(`${label}${description ? ` · ${description}` : ""}`), labelWidth);
    const lines = labels.map((line, index) => this.controlLine(
      inner,
      `${index === 0 ? "› " : "  "}${line}`,
      id,
      "action",
      activate,
      tone,
    ));
    return lines;
  }

  private controlLine(
    inner: number,
    text: string,
    id: string,
    kind: "row" | "action",
    activate: () => void,
    tone: keyof PanelStyle,
  ): Line {
    return [{
      text: padToCellWidth(clipSingleLine(text, inner), inner),
      style: tone,
      control: { id, kind, activate },
    }];
  }

  private section(label: string): Line {
    return [{ text: label, style: "muted" }];
  }

  private combineColumns(leftLines: Line[], rightLines: Line[], leftWidth: number, rightWidth: number): Line[] {
    const rows = Math.max(leftLines.length, rightLines.length);
    const lines: Line[] = [];
    for (let index = 0; index < rows; index += 1) {
      lines.push([
        ...fitLine(leftLines[index] ?? [], leftWidth),
        { text: " │ ", style: "border" },
        ...fitLine(rightLines[index] ?? [], rightWidth),
      ]);
    }
    return lines;
  }

  private openWorker(workerId: string, review = false): void {
    this.selectedWorkerId = workerId;
    this.tab = "workers";
    this.scrollTop = 0;
    this.focusId = `worker:${workerId}`;
    this.focusAtViewportStart = true;
    if (review) this.expandWorkerDetails(workerId);
    this.invalidate();
  }

  private selectWorker(workerId: string): void {
    this.selectedWorkerId = workerId;
    this.focusId = `worker:${workerId}`;
    this.invalidate();
  }

  private toggleWorkerDetails(workerId: string): void {
    if (this.expandedWorkers.has(workerId)) {
      if (this.workerDetailStates.get(workerId)?.status === "error") {
        this.workerDetailStates.set(workerId, { status: "loading" });
        this.onAction({ type: "inspect-worker", workerId });
        this.invalidate();
        return;
      }
      this.expandedWorkers.delete(workerId);
      this.invalidate();
      return;
    }
    this.expandWorkerDetails(workerId);
  }

  private expandWorkerDetails(workerId: string): void {
    this.expandedWorkers.add(workerId);
    const detail = this.workerDetailStates.get(workerId);
    if (!detail || detail.status === "idle" || detail.status === "error") {
      this.workerDetailStates.set(workerId, { status: "loading" });
      this.onAction({ type: "inspect-worker", workerId });
    }
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
      const text = visibleWidth(segment.text) > remaining ? clipToCellWidth(segment.text, remaining) : segment.text;
      const width = visibleWidth(text);
      if (segment.control && width > 0) {
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

/** Parse every SGR mouse report in one stdin chunk; `remainder` is non-mouse input. */
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

function workerTechnicalDetails(worker: WorkerRecord): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (worker.branch) rows.push(["branch", `${worker.branch}${worker.targetBranch ? ` → ${worker.targetBranch}` : ""}`]);
  if (worker.worktreePath) rows.push(["worktree", worker.worktreePath]);
  if (worker.baseCommit) rows.push(["base", worker.baseCommit.slice(0, 12)]);
  if (worker.resultCommit) rows.push(["result", worker.resultCommit.slice(0, 12)]);
  if (worker.sessionRef) rows.push(["session", worker.sessionRef]);
  if (worker.featureId) rows.push(["feature", worker.featureId]);
  rows.push(["updated", worker.updatedAt]);
  return rows;
}

export function statusGlyph(status: WorkerStatus, pulseFrame = 0, reducedMotion = false): string {
  const base = workerStatusPresentation(status).glyph;
  if (reducedMotion) return base;
  if (status === "starting" || status === "working") {
    return PULSE_FRAMES[normalizeFrame(pulseFrame) % PULSE_FRAMES.length] ?? base;
  }
  if (status === "verifying") return SPINNER_FRAMES[normalizeFrame(pulseFrame) % SPINNER_FRAMES.length] ?? base;
  return base;
}

function statusStyle(status: WorkerStatus): keyof PanelStyle {
  return toneStyle(workerStatusPresentation(status).tone);
}

function toneStyle(tone: PresentationTone): keyof PanelStyle {
  switch (tone) {
    case "progress": return "accent";
    case "review":
    case "success": return "success";
    case "warning": return "warning";
    case "error": return "error";
    case "neutral": return "muted";
  }
}

function workerActionLabel(status: WorkerStatus): string {
  switch (status) {
    case "failed": return "Inspect failure";
    case "blocked": return "Resolve blocker";
    case "paused": return "Resume when ready";
    case "interrupted": return "Inspect interruption";
    default: return "Open Worker";
  }
}

function factLines(values: readonly string[], inner: number, tone: keyof PanelStyle): Line[] {
  const lines: Line[] = [];
  for (const value of values) {
    const wrapped = wrapToCellWidth(singleLine(value), Math.max(1, inner - 2));
    wrapped.forEach((line, index) => {
      lines.push([{ text: `${index === 0 ? "• " : "  "}${line}`, style: tone }]);
    });
  }
  return lines;
}

function styledTextLines(
  value: string,
  inner: number,
  tone: keyof PanelStyle,
  prefix = "",
): Line[] {
  const safePrefix = clipSingleLine(prefix, inner, "");
  const available = Math.max(1, inner - visibleWidth(safePrefix));
  return wrapToCellWidth(singleLine(value), available).map((line) => [{ text: `${safePrefix}${line}`, style: tone }]);
}

function fitLine(line: Line, width: number): Line {
  const result: Line = [];
  let remaining = width;
  for (const segment of line) {
    if (remaining <= 0) break;
    const text = visibleWidth(segment.text) > remaining ? clipToCellWidth(segment.text, remaining) : segment.text;
    result.push({ ...segment, text });
    remaining -= visibleWidth(text);
  }
  if (remaining > 0) result.push({ text: " ".repeat(remaining) });
  return result;
}

function columnWidths(inner: number): { left: number; right: number } {
  const usable = Math.max(2, inner - 3);
  const left = Math.floor(usable / 2);
  return { left, right: usable - left };
}

function normalizeFrame(frame: number): number {
  return Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
}
