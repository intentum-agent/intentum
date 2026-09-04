// Plain ESM so the `intentum` launcher (bin/) and the Pi extension (src/)
// share one Nerd Font detector and installer; the declaration file beside
// it types the module for TypeScript callers.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SYMBOLS_FONT_FILE = "SymbolsNerdFontMono-Regular.ttf";
export const SYMBOLS_FONT_VERSION = "v3.5.1";
export const SYMBOLS_FONT_URL =
  `https://raw.githubusercontent.com/ryanoasis/nerd-fonts/${SYMBOLS_FONT_VERSION}/patched-fonts/NerdFontsSymbolsOnly/${SYMBOLS_FONT_FILE}`;
/** SHA-256 of the pinned file; a download that differs is discarded. */
export const SYMBOLS_FONT_SHA256 = "fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749";

// JetBrainsMonoNerdFont-Regular.ttf, "Hack Nerd Font Mono.ttf", SymbolsNerdFontMono-Regular.ttf
const NERD_FONT_FILE = /nerd ?font/i;
const FONT_FILE = /\.(ttf|otf|ttc)$/i;
/** Distro packages nest fonts as fonts/truetype/<family>/; three levels covers them. */
const SCAN_DEPTH = 3;
/** Terminals that ship the Nerd Font symbols as a built-in fallback font. */
const BUNDLING_TERMINALS = new Map([["ghostty", "Ghostty"], ["wezterm", "WezTerm"]]);
const TRUETYPE_MAGIC = Buffer.from([0x00, 0x01, 0x00, 0x00]);

/**
 * @typedef {object} FontEnvironment
 * @property {string} [platform]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [home]
 */

/** @param {FontEnvironment} [options] */
function environment(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  return { platform, env, home };
}

/** Where a per-user font install goes on this platform. */
export function userFontDirectory(options = {}) {
  const { platform, env, home } = environment(options);
  if (platform === "darwin") return join(home, "Library", "Fonts");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Microsoft", "Windows", "Fonts");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "fonts");
}

/** Every directory a terminal's font fallback can draw from, user first. */
export function fontDirectories(options = {}) {
  const { platform, env, home } = environment(options);
  const user = userFontDirectory({ platform, env, home });
  if (platform === "darwin") return [user, "/Library/Fonts"];
  if (platform === "win32") return [user, join(env.SystemRoot ?? "C:\\Windows", "Fonts")];
  return [user, join(home, ".fonts"), "/usr/local/share/fonts", "/usr/share/fonts"];
}

/**
 * How Nerd Font glyphs would reach the screen: a terminal that bundles them,
 * or an installed Nerd Font (patched family or symbols-only). Undefined when
 * neither is present, in which case icons should fall back to plain glyphs.
 *
 * @param {FontEnvironment & { directories?: readonly string[] }} [options]
 * @returns {Promise<{ kind: "terminal", name: string } | { kind: "font", path: string } | undefined>}
 */
export async function detectNerdFont(options = {}) {
  const { platform, env, home } = environment(options);
  const terminal = BUNDLING_TERMINALS.get((env.TERM_PROGRAM ?? "").toLowerCase());
  if (terminal) return { kind: "terminal", name: terminal };
  for (const directory of options.directories ?? fontDirectories({ platform, env, home })) {
    const path = await findFontFile(directory, SCAN_DEPTH);
    if (path) return { kind: "font", path };
  }
  return undefined;
}

async function findFontFile(directory, depth) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const subdirectories = [];
  for (const entry of entries) {
    if (entry.isFile() && FONT_FILE.test(entry.name) && NERD_FONT_FILE.test(entry.name)) {
      return join(directory, entry.name);
    }
    if (entry.isDirectory()) subdirectories.push(entry.name);
  }
  if (depth <= 1) return undefined;
  for (const name of subdirectories) {
    const found = await findFontFile(join(directory, name), depth - 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Download the pinned Symbols Nerd Font Mono into the user's font directory.
 * Idempotent: an existing file is left alone. The download is verified
 * against the pinned checksum and TrueType header before it is renamed into
 * place, so a partial or substituted response never becomes a font.
 *
 * @param {FontEnvironment & { fetch?: typeof fetch, sha256?: string }} [options]
 * @returns {Promise<{ path: string, installed: boolean }>}
 */
export async function installSymbolsFont(options = {}) {
  const { platform, env, home } = environment(options);
  if (platform === "win32") {
    throw new Error(
      `Windows installs fonts through the registry; download ${SYMBOLS_FONT_URL} and install it with "Install for all users" from Explorer`,
    );
  }
  const directory = userFontDirectory({ platform, env, home });
  const path = join(directory, SYMBOLS_FONT_FILE);
  if (await exists(path)) return { path, installed: false };

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(SYMBOLS_FONT_URL);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText} for ${SYMBOLS_FONT_URL}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== (options.sha256 ?? SYMBOLS_FONT_SHA256)) {
    throw new Error(`download did not match the pinned ${SYMBOLS_FONT_VERSION} checksum; nothing was installed`);
  }
  if (!bytes.subarray(0, 4).equals(TRUETYPE_MAGIC)) {
    throw new Error("download is not a TrueType font; nothing was installed");
  }

  await mkdir(directory, { recursive: true });
  const partial = `${path}.part-${process.pid}`;
  try {
    await writeFile(partial, bytes, { mode: 0o644 });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
  if (platform === "linux") await refreshFontCache(directory);
  return { path, installed: true };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** fontconfig only notices new files after a cache refresh; its absence is not an error. */
function refreshFontCache(directory) {
  return new Promise((resolveResult) => {
    try {
      execFile("fc-cache", ["-f", directory], () => resolveResult(undefined));
    } catch {
      resolveResult(undefined);
    }
  });
}
