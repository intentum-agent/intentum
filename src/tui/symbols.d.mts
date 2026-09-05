import type { FontEnvironment } from "./nerd-font.mjs";

export type SymbolPreset = "nerd" | "unicode" | "ascii";

export interface StatusSymbols {
  readonly success: string;
  readonly done: string;
  readonly error: string;
  readonly warning: string;
  readonly info: string;
  readonly pending: string;
  readonly running: string;
  readonly aborted: string;
}

export interface BoxSymbols {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
  readonly teeRight: string;
  readonly teeLeft: string;
}

export interface TreeSymbols {
  readonly branch: string;
  readonly last: string;
  readonly vertical: string;
}

export interface SymbolSet {
  /** The brand mark beside the wordmark or project name. */
  readonly mark: string;
  readonly host: string;
  readonly model: string;
  readonly folder: string;
  readonly branch: string;
  readonly session: string;
  readonly phase: string;
  readonly decision: string;
  readonly attention: string;
  readonly active: string;
  readonly review: string;
  readonly paused: string;
  readonly autonomy: string;
  readonly input: string;
  readonly output: string;
  /** Empty means the amount carries its own `$` prefix. */
  readonly cost: string;
  readonly context: string;
  /** Tool status icons in transcript headers. */
  readonly status: StatusSymbols;
  /** Live tool spinner frames, advanced in lockstep by the shared ticker. */
  readonly spinner: readonly string[];
  /** Thinking pulse frames: one fixed-width starburst cycling its facets. */
  readonly pulse: readonly string[];
  /** Rounded frame around tool output. */
  readonly box: BoxSymbols;
  /** Connectors for argument and result trees. */
  readonly tree: TreeSymbols;
  /** Separator between header meta items. */
  readonly dot: string;
  readonly bracketLeft: string;
  readonly bracketRight: string;
}

export const SYMBOL_SETS: Readonly<Record<SymbolPreset, SymbolSet>>;

export function explicitSymbolPreset(environment?: NodeJS.ProcessEnv): SymbolPreset | undefined;
export function symbolPreset(environment?: NodeJS.ProcessEnv): SymbolPreset;
export function resolveSymbolPreset(options?: FontEnvironment): Promise<SymbolPreset>;
