import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_EXPAND_KEY, type TranscriptTheme, transcriptTheme } from "./transcript-style.js";

/**
 * Resolve the transcript theme for a Pi host: its active `Theme`, the
 * detected symbol preset, and the key bound to tool-output expansion.
 * Renderers call this once per call/result render, never per frame.
 */
export function hostTranscriptTheme(theme: Theme): TranscriptTheme {
  let expandKey = DEFAULT_EXPAND_KEY;
  try {
    expandKey = keyText("app.tools.expand") || DEFAULT_EXPAND_KEY;
  } catch {
    // Keybindings are only initialized inside the interactive TUI.
  }
  return transcriptTheme(theme, { expandKey });
}
