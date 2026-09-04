import type { FontEnvironment } from "./nerd-font.mjs";

export type SymbolPreset = "nerd" | "unicode" | "ascii";

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
}

export const SYMBOL_SETS: Readonly<Record<SymbolPreset, SymbolSet>>;

export function explicitSymbolPreset(environment?: NodeJS.ProcessEnv): SymbolPreset | undefined;
export function symbolPreset(environment?: NodeJS.ProcessEnv): SymbolPreset;
export function resolveSymbolPreset(options?: FontEnvironment): Promise<SymbolPreset>;
