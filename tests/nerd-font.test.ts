import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectNerdFont, installSymbolsFont, SYMBOLS_FONT_FILE, SYMBOLS_FONT_URL, userFontDirectory } from "../src/tui/nerd-font.mjs";
import { resolveSymbolPreset, symbolPreset } from "../src/tui/symbols.mjs";

const TRUETYPE = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(64, 7)]);

function fetchReturning(body: Buffer, status = 200): typeof fetch {
  return (async () => new Response(new Uint8Array(body), { status })) as unknown as typeof fetch;
}

describe("Nerd Font detection", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "intentum-fonts-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("finds a patched family or the symbols font nested under a font directory, ignoring other fonts", async () => {
    const fonts = join(home, "fonts");
    await mkdir(join(fonts, "truetype", "jetbrains"), { recursive: true });
    await writeFile(join(fonts, "DejaVuSansMono.ttf"), TRUETYPE);
    await writeFile(join(fonts, "truetype", "jetbrains", "JetBrainsMonoNerdFont-Regular.ttf"), TRUETYPE);
    await writeFile(join(fonts, "Nerd Font notes.txt"), "not a font");
    expect(await detectNerdFont({ env: {}, directories: [join(home, "missing"), fonts] })).toEqual({
      kind: "font",
      path: join(fonts, "truetype", "jetbrains", "JetBrainsMonoNerdFont-Regular.ttf"),
    });
    expect(await detectNerdFont({ env: {}, directories: [join(home, "missing")] })).toBeUndefined();
  });

  it("trusts terminals that bundle the symbols before looking at font files", async () => {
    expect(await detectNerdFont({ env: { TERM_PROGRAM: "ghostty" }, directories: [] })).toEqual({ kind: "terminal", name: "Ghostty" });
    expect(await detectNerdFont({ env: { TERM_PROGRAM: "iTerm.app" }, directories: [] })).toBeUndefined();
  });

  it("scans the platform's user font directory under the given home", async () => {
    await mkdir(join(home, "Library", "Fonts"), { recursive: true });
    await writeFile(join(home, "Library", "Fonts", "SymbolsNerdFontMono-Regular.ttf"), TRUETYPE);
    expect(await detectNerdFont({ platform: "darwin", env: {}, home })).toEqual({
      kind: "font",
      path: join(home, "Library", "Fonts", "SymbolsNerdFontMono-Regular.ttf"),
    });
    expect(userFontDirectory({ platform: "linux", env: { XDG_DATA_HOME: "/xdg" }, home })).toBe("/xdg/fonts");
    expect(userFontDirectory({ platform: "linux", env: {}, home })).toBe(join(home, ".local", "share", "fonts"));
  });

  it("uses bundled symbols automatically and honours explicit presets", async () => {
    expect(await resolveSymbolPreset({ env: { INTENTUM_SYMBOLS: "ascii", TERM_PROGRAM: "ghostty" } })).toBe("ascii");
    expect(await resolveSymbolPreset({ env: { TERM_PROGRAM: "wezterm" }, home })).toBe("nerd");
    expect(await resolveSymbolPreset({ env: {}, home, platform: "linux" })).toBe("unicode");
  });

  it("falls back when a font is installed but terminal support is unconfirmed", async () => {
    await mkdir(join(home, "Library", "Fonts"), { recursive: true });
    await writeFile(join(home, "Library", "Fonts", "SymbolsNerdFontMono-Regular.ttf"), TRUETYPE);
    const options = { platform: "darwin", home, env: { TERM_PROGRAM: "iTerm.app" } };
    expect(await detectNerdFont(options)).toMatchObject({ kind: "font" });
    expect(await resolveSymbolPreset({ env: { TERM_PROGRAM: "ghostty" } })).toBe("nerd");
    expect(await resolveSymbolPreset(options)).toBe("unicode");
    expect(symbolPreset({})).toBe("unicode");
    expect(await resolveSymbolPreset({ ...options, env: { INTENTUM_SYMBOLS: "nerd" } })).toBe("nerd");
    expect(symbolPreset({})).toBe("nerd");
    expect(await resolveSymbolPreset(options)).toBe("unicode");
  });
});

describe("Symbols Nerd Font install", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "intentum-fonts-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("writes the verified download into the user font directory and is idempotent", async () => {
    const sha256 = createHash("sha256").update(TRUETYPE).digest("hex");
    let downloads = 0;
    const fetchImpl: typeof fetch = async (url) => {
      downloads += 1;
      expect(String(url)).toBe(SYMBOLS_FONT_URL);
      return new Response(new Uint8Array(TRUETYPE));
    };
    const first = await installSymbolsFont({ platform: "darwin", env: {}, home, fetch: fetchImpl, sha256 });
    expect(first).toEqual({ path: join(home, "Library", "Fonts", SYMBOLS_FONT_FILE), installed: true });
    expect(await readFile(first.path)).toEqual(TRUETYPE);
    expect(await readdir(join(home, "Library", "Fonts"))).toEqual([SYMBOLS_FONT_FILE]);

    const second = await installSymbolsFont({ platform: "darwin", env: {}, home, fetch: fetchImpl, sha256 });
    expect(second).toEqual({ path: first.path, installed: false });
    expect(downloads).toBe(1);
  });

  it("refuses a download that fails, mismatches the pinned checksum, or is not a font", async () => {
    const directory = join(home, "Library", "Fonts");
    await expect(installSymbolsFont({ platform: "darwin", env: {}, home, fetch: fetchReturning(TRUETYPE, 503) }))
      .rejects.toThrow("download failed: 503");
    await expect(installSymbolsFont({ platform: "darwin", env: {}, home, fetch: fetchReturning(TRUETYPE) }))
      .rejects.toThrow("did not match the pinned");
    const html = Buffer.from("<html>rate limited</html>");
    const sha256 = createHash("sha256").update(html).digest("hex");
    await expect(installSymbolsFont({ platform: "darwin", env: {}, home, fetch: fetchReturning(html), sha256 }))
      .rejects.toThrow("not a TrueType font");
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not pretend to install on Windows", async () => {
    await expect(installSymbolsFont({ platform: "win32", env: {}, home })).rejects.toThrow("registry");
  });
});
