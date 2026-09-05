import { describe, expect, it, vi } from "vitest";
import { TuiAltScreen, type Terminal, type TUI, type TuiInputListenerResult } from "@earendil-works/pi-tui";
import { installOverlayMouse } from "../src/tui/overlay-mouse.js";

describe("overlay mouse routing", () => {
  it("captures fullscreen mouse before viewport selection and restores the renderer through Pi's proxy", async () => {
    const { createInteractiveTuiReference } = await import(new URL("./modes/interactive/interactive-mode.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
    const renderer = new TuiAltScreen({ columns: 120, rows: 40, write: vi.fn() } as unknown as Terminal);
    const reference = createInteractiveTuiReference(() => renderer) as TUI;
    const internal = renderer as unknown as { handleViewportInput(data: string): TuiInputListenerResult };
    const original = vi.spyOn(internal, "handleViewportInput");
    const received = vi.fn();
    let focused = true;
    const stop = installOverlayMouse(reference, { onTerminalInput: vi.fn() }, () => focused, received);
    expect(internal.handleViewportInput("\x1b[<0;10;5M")).toEqual({ consume: true });
    expect(received).toHaveBeenCalledWith({ x: 9, y: 4, button: 0, release: false });
    expect(original).not.toHaveBeenCalled();
    expect(internal.handleViewportInput("\x1b[<65;10;5M")).toEqual({ consume: true });
    expect(original).not.toHaveBeenCalled();
    internal.handleViewportInput("x");
    expect(original).toHaveBeenCalledWith("x");
    focused = false;
    internal.handleViewportInput("y");
    expect(original).toHaveBeenCalledWith("y");
    stop();
    focused = true;
    const before = received.mock.calls.length;
    internal.handleViewportInput("\x1b[<65;10;5M");
    expect(received).toHaveBeenCalledTimes(before);
    expect(original).toHaveBeenCalledWith("\x1b[<65;10;5M");
  });

  it("enables mouse only for regular overlays, preserves mixed keyboard input, and unsubscribes", () => {
    let listener: (data: string) => TuiInputListenerResult = () => undefined;
    const unsubscribe = vi.fn();
    const write = vi.fn();
    const onMouse = vi.fn();
    const stop = installOverlayMouse({ mode: "regular", terminal: { write } } as unknown as TUI, {
      onTerminalInput(handler) { listener = handler; return unsubscribe; },
    }, () => true, onMouse);
    expect(write).toHaveBeenCalledWith("\x1b[?1000h\x1b[?1006h");
    expect(listener("a\x1b[<0;3;4M\x1b[<0;3;4mb")).toEqual({ data: "ab" });
    expect(onMouse).toHaveBeenCalledTimes(2);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(write).toHaveBeenLastCalledWith("\x1b[?1006l\x1b[?1000l");
  });
});
