import type { Api, Model } from "@earendil-works/pi-ai";
import { Input, Key, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { clipSingleLine, padToCellWidth, singleLine, wrapToCellWidth } from "./text-layout.js";
import { SYMBOL_SETS, symbolPreset, type SymbolPreset, type SymbolSet } from "./symbols.mjs";

export type PickerModel = Model<Api>;

export interface ModelPickerStyle {
  accent(text: string): string;
  bold(text: string): string;
  muted(text: string): string;
  border(text: string): string;
  success(text: string): string;
  error(text: string): string;
  focus(text: string): string;
}

const plain = (text: string) => text;
const PLAIN_STYLE: ModelPickerStyle = {
  accent: plain, bold: plain, muted: plain, border: plain, success: plain, error: plain, focus: plain,
};

export interface ModelPickerOptions {
  models: readonly PickerModel[];
  current?: PickerModel | undefined;
  query?: string;
  scoped?: boolean;
  /** Full catalogue is browsable; only authenticated models in scope can run. */
  availableKeys?: ReadonlySet<string>;
  selectableKeys?: ReadonlySet<string>;
  style?: Partial<ModelPickerStyle>;
  symbols?: SymbolPreset;
  onSelect(model: PickerModel): void;
  onCancel(): void;
  onConnect?(provider: string): void;
  /** Provider IDs, never model references. */
  pins?: readonly string[];
  onPin?(provider: string, pinned: boolean): void;
}

interface PickerHit {
  row: number;
  start: number;
  end: number;
  action: () => void;
  area?: "providers" | "models";
}

export function modelKey(model: PickerModel): string {
  return `${model.provider}/${model.id}`;
}

function tokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${+(value / 1_000).toFixed(1)}k` : String(value);
}

/** Keyboard-first, session-only picker. The host owns model changes and errors. */
export class IntentumModelPicker implements Component, Focusable {
  private readonly input = new Input();
  private readonly models: PickerModel[];
  private readonly providers: string[];
  private readonly style: ModelPickerStyle;
  private readonly symbols: SymbolSet;
  private filtered: PickerModel[] = [];
  private providerIndex = 0;
  private providerBrowser = false;
  private providerOffset = 0;
  private readonly providerCounts = new Map<string, { total: number; ready: number }>();
  private selectedIndex = 0;
  private offset = 0;
  private pageSize = 8;
  private height = 22;
  private busy = false;
  private error: string | undefined;
  private readonly pins: Set<string>;
  private hits: PickerHit[] = [];
  private lastWidth = 0;
  private lastHeight = 0;

  constructor(private readonly options: ModelPickerOptions) {
    this.style = { ...PLAIN_STYLE, ...options.style };
    this.symbols = SYMBOL_SETS[options.symbols ?? symbolPreset()];
    this.pins = new Set(options.pins ?? []);
    const unique = [...new Map(options.models.map((model) => [modelKey(model), model])).values()];
    this.models = unique.sort((a, b) => {
      const current = options.current && modelKey(options.current);
      return Number(modelKey(b) === current) - Number(modelKey(a) === current)
        || Number(this.selectable(b)) - Number(this.selectable(a))
        || a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
    for (const model of this.models) {
      const counts = this.providerCounts.get(model.provider) ?? { total: 0, ready: 0 };
      counts.total++;
      if (this.available(model)) counts.ready++;
      this.providerCounts.set(model.provider, counts);
    }
    this.providers = [...this.providerCounts.keys()];
    this.sortProviders();
    this.input.setValue(singleLine(options.query ?? ""));
    this.input.handleInput("\x05"); // Place the cursor after a prefilled query (Ctrl+E).
    this.filter();
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  get selectedModel(): PickerModel | undefined { return this.filtered[this.selectedIndex]; }
  get query(): string { return this.input.getValue(); }
  get width(): number { return this.lastWidth; }
  get renderedHeight(): number { return this.lastHeight; }

  setPinned(key: string, pinned: boolean): void {
    const activeProvider = this.providers[this.providerIndex - 1];
    if (pinned) this.pins.add(key);
    else this.pins.delete(key);
    this.sortProviders();
    this.providerIndex = activeProvider ? this.providers.indexOf(activeProvider) + 1 : 0;
  }

  private get pinTarget(): string | undefined {
    return this.providers[this.providerIndex - 1] ?? this.selectedModel?.provider;
  }

  private sortProviders(): void {
    this.providers.sort((a, b) => Number(this.pins.has(b)) - Number(this.pins.has(a))
      || Number(Boolean(this.providerCounts.get(b)?.ready)) - Number(Boolean(this.providerCounts.get(a)?.ready)) || a.localeCompare(b));
  }

  private togglePin(provider = this.pinTarget): void {
    if (!provider || this.busy) return;
    const pinned = !this.pins.has(provider);
    this.setPinned(provider, pinned);
    this.options.onPin?.(provider, pinned);
  }

  handleClick(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.lastWidth || y >= this.lastHeight) return false;
    if (!this.busy) this.hits.find((hit) => hit.row === y && x >= hit.start && x < hit.end)?.action();
    return true;
  }

  handleWheel(x: number, y: number, direction: -1 | 1): void {
    if (this.busy || x < 0 || y < 0 || x >= this.lastWidth || y >= this.lastHeight) return;
    const area = this.hits.find((hit) => hit.row === y && x >= hit.start && x < hit.end)?.area;
    const previousFocus = this.providerBrowser;
    if (area) this.providerBrowser = area === "providers";
    this.move(direction * 3);
    this.providerBrowser = previousFocus;
  }

  setHeight(rows: number): void { this.height = Math.max(1, Math.floor(rows)); }
  setBusy(value: boolean): void { this.busy = value; this.error = undefined; }
  setError(message: string): void { this.busy = false; this.error = singleLine(message); }
  invalidate(): void { this.input.invalidate(); }

  handleInput(data: string): void {
    // A pending model change cannot be cancelled after it has been dispatched.
    if (this.busy) return;
    if (matchesKey(data, Key.ctrl("f"))) { this.togglePin(); return; }
    if (matchesKey(data, Key.ctrl("p"))) { this.providerBrowser = !this.providerBrowser; return; }
    if (matchesKey(data, Key.escape) && this.providerBrowser) { this.providerBrowser = false; return; }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return this.options.onCancel();
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      const count = this.providers.length + 1;
      this.providerIndex = (this.providerIndex + (matchesKey(data, Key.tab) ? 1 : -1) + count) % count;
      this.filter();
      return;
    }
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.pageUp)) return this.move(-this.pageSize);
    if (matchesKey(data, Key.pageDown)) return this.move(this.pageSize);
    if (matchesKey(data, Key.enter) || data === "\n") {
      if (this.providerBrowser) {
        const provider = this.providers[this.providerIndex - 1];
        if (provider && !this.providerCounts.get(provider)?.ready) this.options.onConnect?.(provider);
        else this.providerBrowser = false;
      } else if (this.selectedModel) {
        if (!this.available(this.selectedModel)) this.options.onConnect?.(this.selectedModel.provider);
        else if (!this.selectable(this.selectedModel)) this.setError("Outside session scope. Use /scoped-models to enable this model.");
        else this.options.onSelect(this.selectedModel);
      }
      return;
    }
    const before = this.query;
    this.input.handleInput(data);
    if (before !== this.query) this.filter();
  }

  private move(delta: number): void {
    if (this.providerBrowser) {
      this.providerIndex = Math.max(0, Math.min(this.providers.length, this.providerIndex + delta));
      this.filter();
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIndex + delta));
    this.error = undefined;
  }

  private filter(): void {
    const provider = this.providers[this.providerIndex - 1];
    const candidates = this.models.filter((model) => provider ? model.provider === provider : this.query.trim() ? true : this.selectable(model));
    this.filtered = fuzzyFilter(candidates, this.query, (model) => `${model.provider}/${model.id} ${model.name}`);
    this.selectedIndex = 0;
    this.offset = 0;
    this.error = undefined;
  }

  render(width: number): string[] {
    const columns = Math.max(1, Math.floor(width));
    this.lastWidth = columns;
    this.hits = [];
    const s = this.style;
    if (columns < 32 || this.height < 11) {
      this.pageSize = 1;
      const lines = [
        s.bold("intentum · Models"),
        this.searchLine(Math.max(3, columns)),
        s.accent(this.providerBrowser ? this.providerLabel(this.providerIndex, columns) : this.selectedModel ? singleLine(modelKey(this.selectedModel)) : "No matching models"),
        s.muted(`${this.providers.length} providers · Ctrl+P browse`),
        this.error ? s.error(this.error) : this.busy ? "Switching…" : "↑↓ browse · Enter use · Esc close",
      ].slice(0, this.height).map((line) => truncateToWidth(line, columns, "…"));
      this.lastHeight = lines.length;
      return lines;
    }

    const inner = columns - 4;
    const wide = columns >= 88 && this.height >= 16;
    const sidebar = wide && columns >= 110;
    const detailsHeight = wide ? 0 : this.height >= 17 ? 4 : 1;
    this.pageSize = Math.max(1, this.height - 9 - detailsHeight);
    this.offset = Math.min(this.offset, Math.max(0, this.filtered.length - this.pageSize));
    if (this.selectedIndex < this.offset) this.offset = this.selectedIndex;
    if (this.selectedIndex >= this.offset + this.pageSize) this.offset = this.selectedIndex - this.pageSize + 1;

    const fit = (text: string, size: number) => {
      const clipped = truncateToWidth(text, size, "…");
      return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
    };
    const frame = (text: string) => `${s.border("│")} ${fit(text, inner)} ${s.border("│")}`;
    const rule = (left: string, right: string) => s.border(`${left}${"─".repeat(columns - 2)}${right}`);
    const title = " intentum · Models ";
    const lines = [s.border("╭─") + s.bold(title) + s.border("─".repeat(Math.max(0, columns - title.length - 9))) + s.muted(" [×] ") + s.border("─╮")];
    this.hits.push({ row: 0, start: columns - 6, end: columns - 1, action: this.options.onCancel });
    const connected = this.providers.filter((provider) => this.providerCounts.get(provider)?.ready).length;
    lines.push(frame(s.muted(`Designer / current session · ${connected}/${this.providers.length} providers ready`)));
    lines.push(frame(this.searchLine(inner)));
    this.hits.push({ row: 2, start: 2, end: columns - 2, action: () => { this.providerBrowser = false; } });
    const provider = this.providers[this.providerIndex - 1];
    const label = provider ? singleLine(provider) : "All providers";
    const count = `${this.filtered.length} model${this.filtered.length === 1 ? "" : "s"}${this.options.scoped ? " · scoped" : ""}`;
    const filterLabel = s.accent(clipSingleLine(label, Math.max(5, inner - count.length - 5)));
    lines.push(frame(`${filterLabel} ${s.muted("· " + count)}`));
    this.hits.push({ row: 3, start: 2, end: columns - 2, action: () => { this.providerBrowser = !this.providerBrowser; } });
    lines.push(rule("├", "┤"));

    const detailWidth = wide ? 30 : inner;
    const providerWidth = 26;
    const listWidth = (wide ? inner - detailWidth - 3 : inner) - (sidebar ? providerWidth + 3 : 0);
    const details = this.details(detailWidth);
    const providerLines = this.providerLines(sidebar ? providerWidth : listWidth);
    const modelStart = 2 + (sidebar ? providerWidth + 3 : 0);
    for (let row = 0; row < this.pageSize; row++) {
      const index = this.offset + row;
      const model = this.filtered[index];
      let line = "";
      if (model) {
        const selected = index === this.selectedIndex;
        const active = this.options.current && modelKey(model) === modelKey(this.options.current);
        const marker = active ? " ●" : "";
        const prefix = selected ? "› " : "  ";
        const metadata = !this.available(model) ? " connect" : !this.selectable(model) ? " scoped out" : listWidth >= 46 ? ` ${tokens(model.contextWindow).padStart(5)} ctx` : "";
        const nameWidth = listWidth - visibleWidth(prefix + marker + metadata);
        const name = clipSingleLine(model.name || model.id, nameWidth);
        line = prefix + padToCellWidth(name, nameWidth) + (active ? s.success(marker) : marker) + s.muted(metadata);
        if (selected && !this.providerBrowser) line = s.focus(s.accent(line));
        else if (!this.selectable(model)) line = s.muted(line);
      } else if (row === 0) {
        line = s.muted(this.models.length ? "No matching models" : "No available models");
      } else if (row === 1 && this.filtered.length === 0) {
        line = s.muted(this.models.length ? "Try another search or provider." : "Use /login to connect a provider.");
      }
      if (this.providerBrowser && !sidebar) line = providerLines[row] ?? "";
      const screenRow = lines.length;
      if (sidebar || this.providerBrowser) {
        const providerIndex = this.providerOffset + row;
        const provider = this.providers[providerIndex - 1];
        if (provider) this.hits.push({ row: screenRow, start: 4, end: 6, area: "providers", action: () => this.togglePin(provider) });
        this.hits.push({ row: screenRow, start: 2, end: sidebar ? 2 + providerWidth : 2 + listWidth, area: "providers", action: () => {
          if (providerIndex > this.providers.length) return;
          this.providerIndex = providerIndex;
          this.providerBrowser = !sidebar;
          this.input.setValue("");
          this.filter();
          if (!sidebar) this.providerBrowser = false;
        } });
      }
      if (sidebar || !this.providerBrowser) {
        this.hits.push({ row: screenRow, start: modelStart, end: modelStart + listWidth, area: "models", action: () => {
          if (!model) return;
          this.selectedIndex = index;
          this.providerBrowser = false;
          this.error = undefined;
        } });
      }
      const body = wide ? `${fit(line, listWidth)} ${s.border("│")} ${details[row] ?? ""}` : line;
      lines.push(frame(sidebar ? `${fit(providerLines[row] ?? "", providerWidth)} ${s.border("│")} ${body}` : body));
    }
    if (!wide) {
      const compact = this.selectedModel
        ? [s.bold(clipSingleLine(modelKey(this.selectedModel), inner)), ...this.capabilities(this.selectedModel).map(s.muted)]
        : [s.muted(this.models.length ? "Clear search or press Tab to change provider." : "Use /login, then reopen /models.")];
      for (let row = 0; row < detailsHeight; row++) lines.push(frame(compact[row] ?? ""));
    }
    lines.push(rule("├", "┤"));
    const position = this.filtered.length ? `${this.offset + 1}–${Math.min(this.offset + this.pageSize, this.filtered.length)} of ${this.filtered.length}` : "0 models";
    const status = this.providerBrowser ? `${this.providerIndex + 1}/${this.providers.length + 1} providers · ● ready · ○ connect` : this.selectedModel && !this.available(this.selectedModel) ? `Enter to connect ${singleLine(this.selectedModel.provider)} with Pi /login` : `${position} · ● current model`;
    lines.push(frame(this.error ? s.error(this.error) : this.busy ? s.accent("Switching model…") : s.muted(status)));
    const action = this.selectedModel && !this.available(this.selectedModel) ? "[ Connect ]" : "[ Use model ]";
    const pinAction = this.pinTarget && this.pins.has(this.pinTarget) ? "[ Unpin provider ]" : "[ Pin provider ]";
    const controls = `${action} ${pinAction} [ Providers ]`;
    const hints = inner >= 86 ? "  Scroll · Ctrl+F pin · Enter use · Esc close" : "";
    lines.push(frame(s.accent(clipSingleLine(controls + hints, inner))));
    const actionRow = lines.length - 1;
    this.hits.push({ row: actionRow, start: 2, end: 2 + action.length, action: () => { this.providerBrowser = false; this.handleInput("\r"); } });
    this.hits.push({ row: actionRow, start: 3 + action.length, end: 3 + action.length + pinAction.length, action: () => this.togglePin() });
    this.hits.push({ row: actionRow, start: 4 + action.length + pinAction.length, end: Math.min(columns - 2, 4 + controls.length), action: () => { this.providerBrowser = !this.providerBrowser; } });
    lines.push(rule("╰", "╯"));
    this.lastHeight = lines.length;
    return lines;
  }

  private capabilities(model: PickerModel): string[] {
    return [
      `${tokens(model.contextWindow)} context · ${tokens(model.maxTokens)} output`,
      [model.reasoning ? "Reasoning" : "Standard", model.input.includes("image") ? "Text + image" : "Text"].join(" · "),
      `$/1M tokens: ${model.cost.input} in · ${model.cost.output} out`,
    ];
  }

  private available(model: PickerModel): boolean { return this.options.availableKeys?.has(modelKey(model)) ?? true; }
  private selectable(model: PickerModel): boolean { return this.options.selectableKeys?.has(modelKey(model)) ?? this.available(model); }

  private providerLabel(index: number, width: number): string {
    if (index === 0) return clipSingleLine("All providers", width);
    const provider = this.providers[index - 1]!;
    const counts = this.providerCounts.get(provider)!;
    const marker = `${this.pins.has(provider) ? this.symbols.starFilled : this.symbols.starOutline} ` + (counts.ready ? "● " : "○ ");
    const count = ` ${counts.ready || counts.total}`;
    return marker + padToCellWidth(singleLine(provider), Math.max(0, width - count.length - 4)) + count;
  }

  private providerLines(width: number): string[] {
    this.providerOffset = Math.min(this.providerOffset, Math.max(0, this.providers.length + 1 - this.pageSize));
    if (this.providerIndex < this.providerOffset) this.providerOffset = this.providerIndex;
    if (this.providerIndex >= this.providerOffset + this.pageSize) this.providerOffset = this.providerIndex - this.pageSize + 1;
    return Array.from({ length: this.pageSize }, (_, row) => {
      const index = this.providerOffset + row;
      if (index > this.providers.length) return "";
      const active = index === this.providerIndex;
      const label = `${active ? "› " : "  "}${this.providerLabel(index, width - 2)}`;
      return active ? this.providerBrowser ? this.style.focus(this.style.accent(label)) : this.style.accent(label) : this.style.muted(label);
    });
  }

  private searchLine(width: number): string {
    const line = this.input.render(width)[0] ?? "";
    if (this.query || width < 16) return line;
    return line.trimEnd() + " " + this.style.muted(clipSingleLine("Search models or providers…", width - 4));
  }

  private details(width: number): string[] {
    const model = this.selectedModel;
    if (!model) return [this.style.muted("MODEL DETAILS"), "", ...wrapToCellWidth(this.models.length ? "Search by model name, ID, or provider." : "Connect a provider with /login to see its models here.", width)];
    const s = this.style;
    return [
      s.muted("MODEL DETAILS"),
      s.bold(clipSingleLine(model.name || model.id, width)),
      s.accent(clipSingleLine(model.provider, width)),
      s.muted(clipSingleLine(model.id, width)),
      "",
      ...this.capabilities(model).map((line) => s.muted(clipSingleLine(line, width))),
      "",
      !this.available(model) ? s.accent("Enter to connect provider") : !this.selectable(model) ? s.muted("Outside session scope") : this.options.current && modelKey(model) === modelKey(this.options.current) ? s.success("● In use by Designer") : s.accent("Enter to use for this session"),
    ];
  }
}
