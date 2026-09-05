import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiInputListenerResult } from "@earendil-works/pi-tui";
import { parseMouseSequences, type SgrMouseEvent } from "./control-panel.js";

const ENABLE = "\x1b[?1000h\x1b[?1006h";
const DISABLE = "\x1b[?1006l\x1b[?1000l";

/**
 * Pi 0.84's fullscreen renderer consumes clicks before extension listeners.
 * Its viewport listener calls this method dynamically, so intercept only mouse
 * reports while our overlay owns focus. Restore the original method on close.
 * Keep this version-sensitive bridge separate from component hit testing.
 */
export function installOverlayMouse(
  tui: TUI,
  ui: Pick<ExtensionUIContext, "onTerminalInput">,
  focused: () => boolean,
  onMouse: (event: SgrMouseEvent) => void,
): () => void {
  const route = (data: string): TuiInputListenerResult => {
    if (!focused()) return undefined;
    const { events, remainder } = parseMouseSequences(data);
    if (!events.length) return undefined;
    for (const event of events) {
      if (!focused()) break;
      onMouse(event);
    }
    return remainder ? { data: remainder } : { consume: true };
  };
  const viewport = tui as unknown as { handleViewportInput?: (data: string) => TuiInputListenerResult };
  const original = viewport.handleViewportInput;
  if (tui.mode === "fullscreen" && original) {
    const wrapped = (data: string): TuiInputListenerResult => {
      const result = route(data);
      if (!result) return original.call(tui, data);
      if (result.consume) return result;
      const rest = result.data ?? data;
      return original.call(tui, rest) ?? { data: rest };
    };
    viewport.handleViewportInput = wrapped;
    // InteractiveMode exposes a proxy that rebinds methods on every read, so
    // identity comparisons here would fail and leave the interceptor installed.
    return () => { viewport.handleViewportInput = original; };
  }
  // Newer hosts may deliver overlay mouse input without the compatibility hook.
  const stop = ui.onTerminalInput(route);
  if (tui.mode !== "fullscreen") tui.terminal.write(ENABLE);
  return () => {
    stop();
    if (tui.mode !== "fullscreen") tui.terminal.write(DISABLE);
  };
}
