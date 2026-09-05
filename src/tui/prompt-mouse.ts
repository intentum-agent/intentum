import { visibleWidth, type Component, type EditorComponent, type TUI, type TuiInputListenerResult } from "@earendil-works/pi-tui";

interface Rect { x: number; y: number; width: number; height: number }
interface LayoutBox {
  component: Component;
  rect: Rect;
  clip: Rect;
  children: LayoutBox[];
  lineOffset?: number;
}
interface VisualLine { logicalLine: number; startCol: number; length: number }

/** Pi 0.84 has no public cursor setter or component screen bounds. Keep the
 * compatibility surface here, using the host's own wrapping and paste segments.
 * Unknown editor implementations and hosts retain their normal mouse behavior.
 */
interface NativeEditor extends EditorComponent {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  lastWidth: number;
  scrollOffset: number;
  lastAction: unknown;
  jumpMode: unknown;
  isInPaste: boolean;
  getPaddingX(): number;
  buildVisualLineMap(width: number): VisualLine[];
  segment(text: string, granularity: "grapheme"): Iterable<{ segment: string; index: number }>;
  setCursorCol(col: number): void;
  cancelAutocomplete(): void;
}
interface Viewport {
  getFocusedComponent?: () => Component | null;
  currentLayout?: { root: LayoutBox; width: number; height: number };
  handleViewportInput?: (data: string) => TuiInputListenerResult;
}

function nativeEditor(editor: EditorComponent): NativeEditor | undefined {
  const candidate = editor as Partial<NativeEditor>;
  return candidate.state && Array.isArray(candidate.state.lines)
    && typeof candidate.lastWidth === "number" && typeof candidate.scrollOffset === "number"
    && typeof candidate.getPaddingX === "function" && typeof candidate.buildVisualLineMap === "function"
    && typeof candidate.segment === "function" && typeof candidate.setCursorCol === "function"
    && typeof candidate.cancelAutocomplete === "function" ? candidate as NativeEditor : undefined;
}

function editorBox(box: LayoutBox, editor: Component): LayoutBox | undefined {
  // InteractiveMode mounts its editor as the sole child of a plain Container,
  // which the layout engine treats as a single leaf.
  const children = (box.component as Component & { children?: Component[] }).children;
  if (box.component === editor || (children?.length === 1 && children[0] === editor)) return box;
  for (const child of box.children) {
    const found = editorBox(child, editor);
    if (found) return found;
  }
  return undefined;
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

/** Enable click-to-position in Intentum's default fullscreen prompt. */
export function installPromptMouse(tui: TUI, component: EditorComponent): () => void {
  // Pi 0.85 routes component mouse events itself, including click-to-position
  // and drag-to-copy. Preserve that richer native implementation when present.
  if (typeof (component as EditorComponent & { handleMouse?: unknown }).handleMouse === "function") return () => {};
  const editor = nativeEditor(component);
  const viewport = tui as unknown as Viewport;
  const original = viewport.handleViewportInput;
  if (!editor || tui.mode !== "fullscreen" || typeof original !== "function") return () => {};
  let disposed = false;
  let pressed = false;
  const click = (button: number, x: number, y: number, release: boolean): boolean => {
    if (disposed || viewport.getFocusedComponent?.() !== component || tui.hasOverlay() || editor.isInPaste) {
      pressed = false;
      return false;
    }
    // Keep the release/drag of a prompt click out of transcript selection.
    if (pressed && (button === 0 || button === 32)) {
      if (release) pressed = false;
      if (release || button === 32) return true;
    }
    if (release || button !== 0) return false;
    pressed = false;
    const layout = viewport.currentLayout;
    // Screen coordinates are only meaningful for the last painted dimensions.
    if (!layout || layout.width !== tui.terminal.columns || layout.height !== tui.terminal.rows) return false;
    const box = editorBox(layout.root, component);
    if (!box || !contains(box.rect, x, y) || !contains(box.clip, x, y)) return false;
    const visualLines = editor.buildVisualLineMap(editor.lastWidth);
    const row = y - box.rect.y + (box.lineOffset ?? 0) - 1; // top border
    const visibleCount = Math.min(visualLines.length - editor.scrollOffset, Math.max(5, Math.floor(tui.terminal.rows * 0.3)));
    if (row < 0 || row >= visibleCount) return false; // borders and autocomplete
    const visual = visualLines[editor.scrollOffset + row];
    if (!visual) return false;
    const text = (editor.state.lines[visual.logicalLine] ?? "").slice(visual.startCol, visual.startCol + visual.length);
    const padding = Math.min(editor.getPaddingX(), Math.max(0, Math.floor((box.rect.width - 1) / 2)));
    const column = Math.max(0, x - box.rect.x - padding);
    let cells = 0;
    let offset = 0;
    for (const grapheme of editor.segment(text, "grapheme")) {
      const width = visibleWidth(grapheme.segment);
      // Snap either cell of a wide character to its leading boundary. Paste
      // markers and combined emoji are indivisible, just like keyboard moves.
      if (cells + width > column) break;
      cells += width;
      offset = grapheme.index + grapheme.segment.length;
    }
    editor.cancelAutocomplete();
    editor.lastAction = null;
    editor.jumpMode = null;
    editor.state.cursorLine = visual.logicalLine;
    editor.setCursorCol(visual.startCol + offset);
    pressed = true;
    tui.requestRender();
    return true;
  };
  viewport.handleViewportInput = (data) => {
    if (disposed) return original.call(tui, data);
    // Stdin can batch mouse reports. Delegate untouched reports individually,
    // preserving keyboard data for the host's remaining input listeners.
    let found = false;
    const remainder = data.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (report, button, x, y, suffix) => {
      found = true;
      if (click(Number(button), Number(x) - 1, Number(y) - 1, suffix === "m")) return "";
      const result = original.call(tui, report);
      return result?.consume ? "" : result?.data ?? report;
    });
    if (!found) {
      pressed = false;
      return original.call(tui, data);
    }
    if (!remainder) return { consume: true };
    return original.call(tui, remainder) ?? { data: remainder };
  };
  return () => {
    if (disposed) return;
    disposed = true;
    viewport.handleViewportInput = original;
  };
}
