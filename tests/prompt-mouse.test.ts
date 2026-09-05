import { afterEach, describe, expect, it, vi } from "vitest";
import { Container, Editor, TuiAltScreen, VStack, type Component, type EditorTheme, type Terminal, type TUI, type TuiInputListenerResult } from "@earendil-works/pi-tui";
import { installPromptMouse } from "../src/tui/prompt-mouse.js";
import { installOverlayMouse } from "../src/tui/overlay-mouse.js";

const identity = (text: string) => text;
const theme: EditorTheme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function host(text: string, columns = 30, rows = 20, editorHeight?: number) {
  const { createInteractiveTuiReference } = await import(new URL("./modes/interactive/interactive-mode.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  let input: (data: string) => void = () => {};
  const terminal = {
    columns, rows, kittyProtocolActive: false,
    start: (handler: typeof input) => { input = handler; }, stop: vi.fn(),
    write: vi.fn(), hideCursor: vi.fn(), showCursor: vi.fn(), moveBy: vi.fn(),
  } as unknown as Terminal;
  const renderer = new TuiAltScreen(terminal);
  const tui = createInteractiveTuiReference(() => renderer) as TUI;
  const editor = new Editor(tui, theme, { paddingX: 1 });
  editor.setText(text);
  const container = new Container();
  container.addChild(editor);
  const transcript: Component = { render: () => ["transcript"], invalidate() {} };
  const footer: Component = { render: () => ["footer", "widget"], invalidate() {} };
  renderer.setLayoutRoot(new VStack([
    { component: transcript, basis: 0, grow: 1 },
    { component: container, ...(editorHeight === undefined ? {} : { basis: editorHeight }) },
    footer,
  ]));
  renderer.setFocus(editor);
  const internal = renderer as unknown as {
    doRender(): void;
    handleViewportInput(data: string): TuiInputListenerResult;
    currentLayout: { root: { children: Array<{ rect: { y: number }; lineOffset: number }> } };
  };
  const original = vi.spyOn(internal, "handleViewportInput");
  const stop = installPromptMouse(tui, editor);
  renderer.start();
  const paint = () => internal.doRender();
  paint();
  cleanups.push(() => { stop(); renderer.stop(); });
  const report = (x: number, y: number, button = 0, release = false) => `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
  const top = () => internal.currentLayout.root.children[1]!.rect.y;
  return {
    editor, renderer, tui, terminal, internal, original, stop, paint, top, report,
    input: (data: string) => input(data),
    click: (x: number, row = 0) => input(report(x, top() + 1 + row)),
  };
}

describe("prompt click positioning", () => {
  it("defers to hosts and editors with native mouse support", () => {
    const handleViewportInput = vi.fn();
    const tui = { mode: "fullscreen", handleViewportInput } as unknown as TUI;
    const editor = new Editor(tui, theme);
    Object.assign(editor, { handleMouse: vi.fn() });
    installPromptMouse(tui, editor)();
    expect((tui as unknown as { handleViewportInput: unknown }).handleViewportInput).toBe(handleViewportInput);
  });

  it("moves the native cursor and inserts at the clicked location through Pi's input pipeline", async () => {
    const h = await host("hello world");
    const change = vi.fn();
    h.editor.onChange = change;
    h.click(7);
    expect(h.editor.getCursor()).toEqual({ line: 0, col: 6 });
    expect(change).not.toHaveBeenCalled();
    h.input("beautiful ");
    expect(h.editor.getText()).toBe("hello beautiful world");
    h.input("\x1f"); // native undo
    expect(h.editor.getText()).toBe("hello world");
    h.click(0);
    expect(h.editor.getCursor().col).toBe(0);
    h.click(29);
    expect(h.editor.getCursor().col).toBe(11);
  });

  it("positions safely around Chinese, combined emoji, and combining characters", async () => {
    const h = await host("a中文👩‍💻e\u0301z");
    for (const [x, col] of [[2, 1], [3, 1], [4, 2], [5, 2], [6, 3], [7, 3], [8, 8], [9, 10]]) {
      h.click(x!);
      expect(h.editor.getCursor()).toEqual({ line: 0, col });
    }
    h.input("!");
    expect(h.editor.getText()).toBe("a中文👩‍💻e\u0301!z");
  });

  it("uses native word wrapping, explicit newlines, and blank lines", async () => {
    const h = await host("hello world again\n\n中文测试", 14);
    h.click(2, 1);
    expect(h.editor.getCursor()).toEqual({ line: 0, col: 13 });
    h.click(8, 2);
    expect(h.editor.getCursor()).toEqual({ line: 1, col: 0 });
    h.click(5, 3);
    expect(h.editor.getCursor()).toEqual({ line: 2, col: 2 });
  });

  it("accounts for internal scrolling and host clipping in short terminals", async () => {
    const h = await host(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"), 30, 12, 3);
    const box = h.internal.currentLayout.root.children[1]!;
    expect(box.lineOffset).toBeGreaterThan(0);
    h.input(h.report(2, h.top()));
    expect(h.editor.getCursor()).toEqual({ line: 9, col: 1 });
  });

  it("recalculates wrapping after a resize has been painted", async () => {
    const h = await host("hello world again", 30);
    Object.assign(h.terminal, { columns: 14 });
    h.click(2);
    expect(h.editor.getCursor().col).toBe(17); // old frame cannot be hit-tested
    h.paint();
    h.click(2, 1);
    expect(h.editor.getCursor()).toEqual({ line: 0, col: 13 });
  });

  it("keeps large paste markers atomic", async () => {
    const h = await host("");
    const pasted = "long paste\n".repeat(20);
    h.input(`\x1b[200~${pasted}\x1b[201~`);
    h.paint();
    expect(h.editor.getText()).toContain("[paste");
    h.click(4);
    expect(h.editor.getCursor().col).toBe(0);
    h.input("prefix ");
    expect(h.editor.getExpandedText()).toBe(`prefix ${pasted}`);
  });

  it("leaves transcript clicks, wheel, modifiers, and borders to the viewport", async () => {
    const h = await host("draft");
    for (const report of [h.report(2, 0), h.report(2, h.top()), h.report(2, h.top() + 2), h.report(2, h.top() + 1, 64), h.report(2, h.top() + 1, 4)]) {
      h.input(report);
      expect(h.original).toHaveBeenCalledWith(report);
      expect(h.editor.getCursor().col).toBe(5);
    }
  });

  it("routes focused overlays first, then restores prompt clicks and disposes the bridge", async () => {
    const h = await host("draft");
    const overlay: Component = { render: () => ["overlay"], invalidate() {} };
    const handle = h.renderer.showOverlay(overlay);
    const onMouse = vi.fn();
    const stopOverlay = installOverlayMouse(h.tui, { onTerminalInput: vi.fn() }, () => handle.isFocused(), onMouse);
    h.click(2);
    expect(onMouse).toHaveBeenCalledOnce();
    expect(h.editor.getCursor().col).toBe(5);
    stopOverlay();
    handle.hide();
    h.paint();
    h.click(2);
    expect(h.editor.getCursor().col).toBe(1);
    h.stop();
    h.click(4);
    expect(h.editor.getCursor().col).toBe(1);
    expect(h.original).toHaveBeenLastCalledWith(h.report(4, h.top() + 1));
  });

  it("does not intercept another focused input or autocomplete rows", async () => {
    const h = await host("draft");
    h.renderer.setFocus({ render: () => [], invalidate() {}, handleInput() {} });
    h.click(2);
    expect(h.editor.getCursor().col).toBe(5);
    h.renderer.setFocus(h.editor);
    h.editor.setAutocompleteProvider({ getSuggestions: async () => ({ items: [{ value: "drafted", label: "drafted" }, { value: "drafting", label: "drafting" }], prefix: "draft" }), applyCompletion: () => ({ lines: ["drafted"], cursorLine: 0, cursorCol: 7 }) });
    h.input("\t");
    await vi.waitFor(() => expect(h.editor.isShowingAutocomplete()).toBe(true));
    h.paint();
    h.input(h.report(2, h.top() + 3));
    expect(h.editor.getCursor().col).toBe(5);
    h.click(2);
    expect(h.editor.isShowingAutocomplete()).toBe(false);
    expect(h.editor.getCursor().col).toBe(1);
  });

  it("consumes prompt drag and release reports while retaining batched keyboard data", async () => {
    const h = await host("draft");
    const y = h.top() + 1;
    expect(h.internal.handleViewportInput(h.report(2, y) + h.report(3, y, 32) + h.report(3, y, 0, true) + "x")).toEqual({ data: "x" });
    expect(h.editor.getCursor().col).toBe(1);
    expect(h.original).toHaveBeenCalledExactlyOnceWith("x");
  });
});
