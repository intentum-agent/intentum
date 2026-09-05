import { describe, expect, it, vi } from "vitest";
import { CustomEditor, type KeybindingsManager as AppKeybindingsManager, type ExtensionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { initialProviderPins, modelPickerSize, openModelPicker, registerModelPicker, wireModelPickerEditor } from "../src/tools/model-picker-host.js";
import { centeredOverlayOrigin } from "../src/tui/control-panel.js";
import type { PickerModel } from "../src/tui/model-picker.js";

const current: PickerModel = {
  id: "current", provider: "test", name: "Current Model", api: "openai-completions", baseUrl: "https://example.test",
  reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 16_000,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
const other = { ...current, id: "other", name: "Other Model" };
const disconnected = { ...other, provider: "unconnected", name: "Unconnected Model" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function host(options: { scoped?: boolean; mode?: "tui" | "rpc"; idle?: boolean; result?: boolean } = {}) {
  let component: (Component & { dispose?(): void }) | undefined;
  const done = vi.fn();
  const notify = vi.fn();
  const setModel = vi.fn(async (_model: PickerModel) => options.result ?? true);
  const getAvailable = vi.fn(() => [current, other]);
  const getAll = vi.fn(() => [current, other, disconnected]);
  const terminal = { columns: 100, rows: 30, write: vi.fn() };
  const listeners: Array<(data: string) => unknown> = [];
  const unsubscribe = vi.fn();
  const ctx = {
    mode: options.mode ?? "tui", model: current,
    scopedModels: options.scoped ? [{ model: other }] : [],
    isIdle: vi.fn(() => options.idle ?? true),
    modelRegistry: { getAvailable, getAll },
    ui: {
      notify,
      onTerminalInput: vi.fn((handler) => { listeners.push(handler); return unsubscribe; }),
      custom: vi.fn(async (factory, options) => new Promise<string | undefined>((resolve) => {
        component = factory(
          { mode: "regular", terminal, requestRender: vi.fn() },
          { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value },
          {}, (result: string | undefined) => { done(); component?.dispose?.(); component = undefined; resolve(result); },
        );
        options?.onHandle?.({ isFocused: () => true });
      })),
    },
  } as unknown as ExtensionContext;
  return {
    ctx, setModel, getAvailable, getAll, done, notify, terminal, listeners, unsubscribe,
    ready: () => vi.waitFor(() => expect(component).toBeDefined(), { interval: 1 }),
    component: () => component!, text: () => component!.render(116).map(stripTerminalSequences).join("\n"),
  };
}

describe("model picker host", () => {
  it("maps terminal clicks into the resized overlay and restores mouse reporting on close", async () => {
    const h = host();
    const opened = openModelPicker(h, h.ctx);
    await h.ready();
    h.terminal.columns = 160;
    h.terminal.rows = 40;
    const size = modelPickerSize(160, 40);
    expect(size).toEqual({ width: 150, height: 36 });
    const lines = h.component().render(size.width).map(stripTerminalSequences);
    const origin = centeredOverlayOrigin(h.terminal, { width: size.width, height: lines.length });
    const otherRow = lines.findIndex((line) => line.includes("Other Model"));
    const click = (x: number, y: number) => h.listeners[0]!(`\x1b[<0;${origin.col + x + 1};${origin.row + y + 1}M`);
    click(lines[otherRow]!.indexOf("Other Model") + 2, otherRow);
    expect(h.setModel).not.toHaveBeenCalled();
    click(4, lines.findIndex((line) => line.includes("[ Use model ]")));
    await opened;
    expect(h.setModel).toHaveBeenCalledExactlyOnceWith(other);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.terminal.write).toHaveBeenLastCalledWith("\x1b[?1006l\x1b[?1000l");
  });

  it("seeds the current provider and most frequently selected providers without inventing preferences", () => {
    const ctx = {
      model: current,
      sessionManager: { getEntries: () => [
        { type: "model_change", provider: "a", modelId: "rare" },
        { type: "model_change", provider: "b", modelId: "another-model" },
        { type: "model_change", provider: "b", modelId: "frequent" },
        { type: "model_change", provider: "c", modelId: "other" },
      ] },
    } as unknown as ExtensionContext;
    expect(initialProviderPins(ctx)).toEqual(["test", "b", "a"]);
  });
  it("uses only scoped models and applies the selection through Pi", async () => {
    const h = host({ scoped: true });
    const opened = openModelPicker(h, h.ctx);
    await h.ready();
    expect(h.getAvailable).toHaveBeenCalledOnce();
    expect(h.text()).toContain("scoped");
    expect(h.text()).not.toContain("Current Model");
    h.component().handleInput?.("\r");
    await opened;
    expect(h.setModel).toHaveBeenCalledExactlyOnceWith(other);
    expect(h.done).toHaveBeenCalledOnce();
  });

  it("shows unconnected providers beside ready ones and requests native login", async () => {
    const h = host();
    const opened = openModelPicker(h, h.ctx, "unconnected");
    await h.ready();
    expect(h.text()).toContain("1/2 providers ready");
    expect(h.text()).toContain("unconnected");
    expect(h.text()).toContain("Enter to connect");
    h.component().handleInput?.("\r");
    await expect(opened).resolves.toBe("unconnected");
    expect(h.setModel).not.toHaveBeenCalled();
  });

  it("can switch between models from multiple authenticated providers", async () => {
    const h = host();
    const second = { ...other, provider: "second" };
    h.getAvailable.mockReturnValue([current, other, second]);
    h.getAll.mockReturnValue([current, other, second, disconnected]);
    for (const target of [second, other]) {
      const opened = openModelPicker(h, h.ctx, `${target.provider}/${target.id}`);
      await h.ready();
      expect(h.text()).toContain("2/3 providers ready");
      h.component().handleInput?.("\r");
      await opened;
      expect(h.setModel).toHaveBeenLastCalledWith(target);
    }
  });

  it("keeps the provider catalogue visible under a scope without enabling excluded models", async () => {
    const h = host({ scoped: true });
    const opened = openModelPicker(h, h.ctx, "current");
    await h.ready();
    expect(h.text()).toContain("unconnected");
    h.component().handleInput?.("\r");
    expect(h.text()).toContain("Outside session scope");
    expect(h.setModel).not.toHaveBeenCalled();
    h.component().handleInput?.("\x1b");
    await opened;
  });

  it("leaves the model untouched on cancel or when selecting the current model", async () => {
    for (const input of ["\x1b", "\r"]) {
      const h = host();
      const opened = openModelPicker(h, h.ctx);
      await h.ready();
      h.component().handleInput?.(input);
      await opened;
      expect(h.setModel).not.toHaveBeenCalled();
    }
  });

  it("keeps failures visible and allows retry without double dispatch", async () => {
    const h = host({ result: false });
    const opened = openModelPicker(h, h.ctx, "other");
    await h.ready();
    h.component().handleInput?.("\r");
    h.component().handleInput?.("\r");
    await tick();
    expect(h.setModel).toHaveBeenCalledOnce();
    expect(h.done).not.toHaveBeenCalled();
    expect(h.text()).toContain("/login");
    h.setModel.mockResolvedValueOnce(true);
    h.component().handleInput?.("\r");
    await opened;
    expect(h.setModel).toHaveBeenCalledTimes(2);
  });

  it("does not open terminal UI in RPC or during an active turn", async () => {
    for (const options of [{ mode: "rpc" as const }, { idle: false }]) {
      const h = host(options);
      await openModelPicker(h, h.ctx);
      expect(h.ctx.ui.custom).not.toHaveBeenCalled();
      expect(h.setModel).not.toHaveBeenCalled();
      expect(h.notify).toHaveBeenCalledOnce();
    }
  });

  it("rechecks idle state before applying a model", async () => {
    const h = host();
    const opened = openModelPicker(h, h.ctx, "other");
    await h.ready();
    vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    h.component().handleInput?.("\r");
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.text()).toContain("Wait for the turn");
    h.component().handleInput?.("\x1b");
    await opened;
  });
});

describe("native editor integration", () => {
  function editor() {
    const identity = (text: string) => text;
    const theme: EditorTheme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
    const keys = new KeybindingsManager({ "app.model.select": { defaultKeys: ["ctrl+y"] } });
    const instance = new CustomEditor({ requestRender: vi.fn() } as unknown as TUI, theme, keys as AppKeybindingsManager);
    const open = vi.fn();
    const submitNative = wireModelPickerEditor(instance, (data) => keys.matches(data, "app.model.select"), open);
    const submit = vi.fn();
    // Match Pi: it assigns this callback after the custom factory returns.
    instance.onSubmit = submit;
    return { instance, open, submit, submitNative };
  }

  it("opens from the configured shortcut while preserving an unsent draft", () => {
    const h = editor();
    h.instance.setText("draft text");
    h.instance.handleInput("\x19");
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.instance.getText()).toBe("draft text");
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("intercepts bare /model and forwards normal text and direct model references", () => {
    const h = editor();
    h.instance.setText("/model");
    h.instance.handleInput("\r");
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.instance.getText()).toBe("");
    expect(h.submit).not.toHaveBeenCalled();
    for (const value of ["hello", "/model test/other:high", "/models sonnet"]) {
      h.instance.setText(value);
      h.instance.handleInput("\r");
      expect(h.submit).toHaveBeenLastCalledWith(value);
      expect(h.instance.onSubmit).toBe(h.submit);
    }
  });

  it("does not treat pasted command text as a submission", () => {
    const h = editor();
    h.instance.handleInput("\x1b[200~/model\x1b[201~");
    expect(h.open).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("awaits the native login flow and restores the unsent draft", async () => {
    const h = editor();
    h.instance.setText("unfinished draft");
    let finish = () => {};
    const native = vi.fn(async () => {
      h.instance.setText("");
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    h.instance.onSubmit = native;
    const login = h.submitNative("/login second");
    expect(native).toHaveBeenCalledWith("/login second");
    expect(h.instance.getText()).toBe("");
    finish();
    await login;
    expect(h.instance.getText()).toBe("unfinished draft");
  });

  it("composes with and restores an existing editor across reloads", () => {
    const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
    const pi = {
      registerCommand: vi.fn(),
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => events.set(name, [...events.get(name) ?? [], handler]),
    } as unknown as ExtensionAPI;
    registerModelPicker(pi);
    const previous = vi.fn();
    let factory = previous as ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
    const ctx = { mode: "tui", ui: { getEditorComponent: () => factory, setEditorComponent: (value: typeof factory) => { factory = value; } } } as unknown as ExtensionContext;
    events.get("session_start")![0]!({}, ctx);
    const first = factory;
    expect(first).not.toBe(previous);
    events.get("session_start")![0]!({}, ctx);
    expect(factory).not.toBe(first);
    events.get("session_shutdown")![0]!({}, ctx);
    expect(factory).toBe(previous);
  });
});
