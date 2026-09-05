import { CustomEditor, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, OverlayHandle } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { IntentumModelPicker, modelKey, type PickerModel } from "../tui/model-picker.js";
import { singleLine } from "../tui/text-layout.js";
import { centeredOverlayOrigin } from "../tui/control-panel.js";
import { installOverlayMouse } from "../tui/overlay-mouse.js";
import { installPromptMouse } from "../tui/prompt-mouse.js";
import { ProviderPinStore } from "../state/provider-pins.js";

export function modelPickerSize(columns: number, rows: number): { width: number; height: number } {
  return { width: Math.max(1, Math.floor(columns * 0.94)), height: Math.max(1, Math.floor(rows * 0.9)) };
}

export function initialProviderPins(ctx: Pick<ExtensionContext, "model" | "sessionManager">): string[] {
  const counts = new Map<string, number>();
  for (const entry of ctx.sessionManager?.getEntries() ?? []) {
    if (entry.type === "model_change") {
      const key = entry.provider;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const frequent = [...counts].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  return [...new Set([...(ctx.model ? [ctx.model.provider] : []), ...frequent])].slice(0, 3);
}

/** Keep Pi's editor, autocomplete, draft, and other app actions intact. */
export function wireModelPickerEditor(
  editor: EditorComponent,
  isModelShortcut: (data: string) => boolean,
  open: (query?: string) => void,
): (command: string) => Promise<void> {
  const handleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data) => {
    if (isModelShortcut(data)) return open();
    // Pi wires onSubmit after the editor factory returns. Wrap at input time,
    // after autocomplete/paste handling has decided to actually submit text.
    const onSubmit = editor.onSubmit;
    editor.onSubmit = (text) => {
      if (text.trim() === "/model") {
        editor.setText("");
        open();
      } else {
        // Preserve native /model <reference> resolution, including thinking suffixes.
        onSubmit?.(text);
      }
    };
    try { handleInput(data); }
    finally {
      if (onSubmit) editor.onSubmit = onSubmit;
      else delete editor.onSubmit;
    }
  };
  return async (command) => {
    const draft = editor.getText();
    try { await editor.onSubmit?.(command); }
    finally { if (!editor.getText()) editor.setText(draft); }
  };
}

export async function openModelPicker(pi: Pick<ExtensionAPI, "setModel">, ctx: ExtensionContext, query = ""): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("The model picker requires an interactive terminal. Use Pi's model selection API in RPC mode.", "info");
    return;
  }
  if (!ctx.isIdle()) {
    ctx.ui.notify("Wait for the current turn to finish before changing the Designer model.", "warning");
    return;
  }
  const available = ctx.modelRegistry.getAvailable();
  const scoped = ctx.scopedModels.map((entry) => entry.model);
  const models = [...ctx.modelRegistry.getAll(), ...available, ...scoped];
  const availableKeys = new Set(available.map(modelKey));
  const selectableKeys = new Set((scoped.length ? scoped : available).filter((model) => availableKeys.has(modelKey(model))).map(modelKey));
  const pinStore = new ProviderPinStore(join(getAgentDir(), "intentum", "provider-pins.json"));
  let pins: string[] = [];
  const providerIds = new Set(models.map((model) => model.provider));
  try { pins = await pinStore.load(initialProviderPins(ctx).filter((provider) => providerIds.has(provider))); }
  catch (error) { ctx.ui.notify(`Could not load provider pins: ${singleLine(String(error))}`, "warning"); }
  let overlayHandle: OverlayHandle | undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    let disposed = false;
    let pinWrites = Promise.resolve();
    const picker = new IntentumModelPicker({
      models, current: ctx.model, query, scoped: ctx.scopedModels.length > 0,
      availableKeys, selectableKeys,
      pins,
      onPin: (key, pinned) => {
        pinWrites = pinWrites.then(async () => {
          try { await pinStore.setPinned(key, pinned); }
          catch (error) {
            if (!disposed) { picker.setPinned(key, !pinned); picker.setError(`Could not save pin: ${String(error)}`); tui.requestRender(); }
            else ctx.ui.notify(`Could not save provider pin: ${singleLine(String(error))}`, "warning");
          }
        });
      },
      style: {
        accent: (text) => theme.fg("accent", text),
        bold: (text) => theme.bold(text),
        muted: (text) => theme.fg("muted", text),
        border: (text) => theme.fg("borderMuted", text),
        success: (text) => theme.fg("success", text),
        error: (text) => theme.fg("error", text),
        focus: (text) => theme.bg("selectedBg", text),
      },
      onCancel: () => done(undefined),
      onConnect: (provider) => done(provider),
      onSelect: (model) => { void select(model); },
    });
    async function select(model: PickerModel): Promise<void> {
      if (disposed) return;
      if (!ctx.isIdle()) {
        picker.setError("The Designer is working. Wait for the turn to finish.");
        tui.requestRender();
        return;
      }
      if (!selectableKeys.has(modelKey(model))) return;
      if (ctx.model && modelKey(ctx.model) === modelKey(model)) return done(undefined);
      picker.setBusy(true);
      tui.requestRender();
      try {
        if (!await pi.setModel(model)) throw new Error("No credentials available. Use /login to reconnect this provider.");
        if (!disposed) done(undefined);
      } catch (error) {
        if (!disposed) {
          picker.setError(error instanceof Error ? error.message : String(error));
          tui.requestRender();
        }
      }
    }
    const stopMouse = installOverlayMouse(tui, ctx.ui, () => !disposed && Boolean(overlayHandle?.isFocused()), (event) => {
      if (event.release || (event.button !== 0 && event.button !== 64 && event.button !== 65)) return;
      // Rebuild hit targets first: clicks after a terminal resize must use the
      // new geometry, even before the host has painted another frame.
      const size = modelPickerSize(tui.terminal.columns, tui.terminal.rows);
      picker.setHeight(size.height);
      picker.render(size.width);
      const origin = centeredOverlayOrigin(tui.terminal, { width: picker.width, height: picker.renderedHeight });
      const x = event.x - origin.col;
      const y = event.y - origin.row;
      if (event.button === 0) picker.handleClick(x, y);
      else picker.handleWheel(x, y, event.button === 64 ? -1 : 1);
      tui.requestRender();
    });
    return {
      get focused() { return picker.focused; },
      set focused(value: boolean) { picker.focused = value; },
      render(width: number) {
        picker.setHeight(modelPickerSize(tui.terminal.columns, tui.terminal.rows).height);
        return picker.render(width);
      },
      handleInput(data: string) { picker.handleInput(data); tui.requestRender(); },
      invalidate() { picker.invalidate(); },
      dispose() { disposed = true; stopMouse(); },
    };
  }, { overlay: true, overlayOptions: { width: "94%", maxHeight: "90%", anchor: "center" }, onHandle: (handle) => { overlayHandle = handle; } });
}

export function registerModelPicker(pi: ExtensionAPI): void {
  let opening = false;
  let restoreEditor: (() => void) | undefined;
  let stopPromptMouse: (() => void) | undefined;
  let submitNative: ((command: string) => Promise<void>) | undefined;
  const open = async (ctx: ExtensionContext, query = "") => {
    if (opening) return;
    opening = true;
    try {
      let search = query;
      while (true) {
        const provider = await openModelPicker(pi, ctx, search);
        if (!provider) break;
        if (!submitNative) {
          ctx.ui.notify(`Connect this provider with /login ${singleLine(provider)}, then reopen /models.`, "info");
          break;
        }
        await submitNative(`/login ${provider}`);
        search = provider;
      }
    }
    catch (error) { ctx.ui.notify(singleLine(error instanceof Error ? error.message : String(error)), "error"); }
    finally { opening = false; }
  };
  pi.registerCommand("models", {
    description: "Choose the Designer model with search, provider filters, and capability details",
    handler: (query, ctx) => open(ctx, query),
  });
  pi.on("session_start", (_event, ctx) => {
    restoreEditor?.();
    restoreEditor = undefined;
    submitNative = undefined;
    if (ctx.mode !== "tui" || typeof ctx.ui.setEditorComponent !== "function") return;
    const previous = ctx.ui.getEditorComponent?.();
    const factory: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> = (tui, theme, keybindings) => {
      stopPromptMouse?.();
      const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      stopPromptMouse = installPromptMouse(tui, editor);
      submitNative = wireModelPickerEditor(editor, (data) => keybindings.matches(data, "app.model.select"), (query) => { void open(ctx, query); });
      return editor;
    };
    ctx.ui.setEditorComponent(factory);
    restoreEditor = () => {
      stopPromptMouse?.();
      stopPromptMouse = undefined;
      if (ctx.ui.getEditorComponent?.() === factory) ctx.ui.setEditorComponent(previous);
    };
  });
  pi.on("session_shutdown", () => { restoreEditor?.(); restoreEditor = undefined; submitNative = undefined; });
}
