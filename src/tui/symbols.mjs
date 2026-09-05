// Plain ESM so the `intentum` launcher (bin/) and the Pi extension (src/)
// share one glyph table and one preset rule; the declaration file beside it
// types the module for TypeScript callers.
import { detectNerdFont } from "./nerd-font.mjs";

/**
 * Glyph presets for the brand mark and the session footer. `nerd` needs a
 * Nerd Font in the terminal; `unicode` uses single-cell glyphs any modern
 * font carries; `ascii` is for fonts and hosts that render neither.
 *
 * @typedef {import("./symbols.d.mts").SymbolPreset} SymbolPreset
 * @typedef {import("./symbols.d.mts").SymbolSet} SymbolSet
 */

/**
 * Transcript glyphs shared by every preset where a modern font renders them:
 * braille spinner, starburst thinking pulse, rounded frame, tree connectors.
 * Nerd Font terminals draw the same box and braille cells, so only the status
 * icons differ per preset.
 */
const UNICODE_TRANSCRIPT = Object.freeze({
  spinner: Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]),
  pulse: Object.freeze(["✻", "✼", "❉", "❊", "✺", "✹", "✸", "✶"]),
  box: Object.freeze({
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    teeRight: "├",
    teeLeft: "┤",
  }),
  tree: Object.freeze({ branch: "├─", last: "└─", vertical: "│" }),
  dot: " · ",
  bracketLeft: "[",
  bracketRight: "]",
});

/** @type {Readonly<Record<SymbolPreset, SymbolSet>>} */
export const SYMBOL_SETS = Object.freeze({
  nerd: Object.freeze({
    // nf-md-bullseye_arrow: the intent and the point it is aimed at.
    mark: "\u{F08C9}",
    host: "\uF109",
    model: "\uEC19",
    folder: "\uF115",
    branch: "\uF126",
    session: "\u{F0051}",
    phase: "\uF024",
    decision: "\uF059",
    attention: "\uF071",
    active: "\uF111",
    review: "\uF00C",
    paused: "\uF04C",
    autonomy: "\uF1DE",
    input: "\uF090",
    output: "\uF08B",
    cost: "\uF155",
    context: "\uE70F",
    starFilled: "\uF005", // nf-fa-star
    starOutline: "\uF006", // nf-fa-star_o
    status: Object.freeze({
      success: "\uF00C",
      done: "•",
      error: "\uF00D",
      warning: "\uF12A",
      info: "\uF129",
      pending: "\uF254",
      running: "\uF110",
      aborted: "\uF04D",
    }),
    ...UNICODE_TRANSCRIPT,
  }),
  unicode: Object.freeze({
    // U+22D7 GREATER-THAN WITH DOT: the prompt chevron and its point.
    mark: "⋗",
    host: "▣",
    model: "⬢",
    folder: "▸",
    branch: "⑂",
    session: "⌗",
    phase: "⚑",
    decision: "◆",
    attention: "⚠",
    active: "●",
    review: "✓",
    paused: "○",
    autonomy: "⚙",
    input: "↑",
    output: "↓",
    cost: "",
    context: "◫",
    starFilled: "★",
    starOutline: "☆",
    status: Object.freeze({
      success: "✔",
      done: "•",
      error: "✘",
      warning: "⚠",
      info: "ⓘ",
      pending: "○",
      running: "⟳",
      aborted: "⏹",
    }),
    ...UNICODE_TRANSCRIPT,
  }),
  ascii: Object.freeze({
    mark: ">•",
    host: "host",
    model: "",
    folder: "",
    branch: "@",
    session: "id",
    phase: "",
    decision: "?",
    attention: "!",
    active: "*",
    review: "ok",
    paused: "||",
    autonomy: "",
    input: "in:",
    output: "out:",
    cost: "",
    context: "ctx:",
    starFilled: "*",
    starOutline: "+",
    status: Object.freeze({
      success: "[ok]",
      done: "*",
      error: "[!!]",
      warning: "[!]",
      info: "[i]",
      pending: "[ ]",
      running: "[~]",
      aborted: "[-]",
    }),
    spinner: Object.freeze(["|", "/", "-", "\\"]),
    pulse: Object.freeze(["*", "+", "x", "+"]),
    box: Object.freeze({
      topLeft: "+",
      topRight: "+",
      bottomLeft: "+",
      bottomRight: "+",
      horizontal: "-",
      vertical: "|",
      teeRight: "+",
      teeLeft: "+",
    }),
    tree: Object.freeze({ branch: "|--", last: "`--", vertical: "|" }),
    dot: " - ",
    bracketLeft: "[",
    bracketRight: "]",
  }),
});

/**
 * The most recent Nerd Font detection. The session chrome detects once at
 * startup; synchronous callers (status text, control panel) then agree with
 * the footer instead of assuming plain glyphs.
 *
 * @type {SymbolPreset | undefined}
 */
let detected;

/**
 * The explicit `INTENTUM_SYMBOLS` choice, if it names a preset.
 *
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {SymbolPreset | undefined}
 */
export function explicitSymbolPreset(environment = process.env) {
  const value = environment.INTENTUM_SYMBOLS?.trim().toLowerCase();
  return value === "nerd" || value === "unicode" || value === "ascii" ? value : undefined;
}

/**
 * Synchronous view: the explicit choice, else the last detection, else plain
 * Unicode glyphs.
 *
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {SymbolPreset}
 */
export function symbolPreset(environment = process.env) {
  return explicitSymbolPreset(environment) ?? detected ?? "unicode";
}

/**
 * `INTENTUM_SYMBOLS` wins; otherwise only terminals that bundle the symbols
 * enable Nerd Font icons. An installed font does not prove that the terminal
 * selects it or uses it as a fallback, so plain Unicode is the safe default.
 *
 * @param {import("./nerd-font.d.mts").FontEnvironment} [options]
 * @returns {Promise<SymbolPreset>}
 */
export async function resolveSymbolPreset(options = {}) {
  const explicit = explicitSymbolPreset(options.env ?? process.env);
  if (explicit) {
    detected = explicit;
    return explicit;
  }
  detected = (await detectNerdFont(options))?.kind === "terminal" ? "nerd" : "unicode";
  return detected;
}
