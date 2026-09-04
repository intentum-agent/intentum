export const SYMBOLS_FONT_FILE: string;
export const SYMBOLS_FONT_VERSION: string;
export const SYMBOLS_FONT_URL: string;
export const SYMBOLS_FONT_SHA256: string;

export interface FontEnvironment {
  readonly platform?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly home?: string | undefined;
}

export type NerdFontSource =
  | { readonly kind: "terminal"; readonly name: string }
  | { readonly kind: "font"; readonly path: string };

export function userFontDirectory(options?: FontEnvironment): string;
export function fontDirectories(options?: FontEnvironment): string[];
export function detectNerdFont(
  options?: FontEnvironment & { readonly directories?: readonly string[] | undefined },
): Promise<NerdFontSource | undefined>;
export function installSymbolsFont(
  options?: FontEnvironment & { readonly fetch?: typeof fetch | undefined; readonly sha256?: string | undefined },
): Promise<{ path: string; installed: boolean }>;
