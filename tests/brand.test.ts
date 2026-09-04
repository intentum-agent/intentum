import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ansi31,
  intentumLabel,
  loadBrandAssets,
  normalizeTerminalColumns,
  renderBrandFrame,
  renderBrandLines,
  selectBrandLayout,
  styleBrandFrame,
} from "../src/tui/brand.js";

describe("terminal brand renderer", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("loads the canonical 7-bit assets without trailing whitespace or ANSI", async () => {
    const assets = await loadBrandAssets();
    for (const lines of Object.values(assets)) {
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toMatch(/[\t ]$/);
        expect(line).not.toContain("\u001b");
        expect([...line].every((character) => character.charCodeAt(0) <= 0x7f)).toBe(true);
      }
    }
    expect(Math.max(...assets.bannerBig.map((line) => line.length))).toBe(113);
    // Source-of-truth measurement: the shipped file is 58, not the prose's old 57.
    expect(Math.max(...assets.bannerSmall.map((line) => line.length))).toBe(58);
  });

  it("chooses only layouts that fit real asset widths", () => {
    expect(selectBrandLayout(113)).toBe("banner-big");
    expect(selectBrandLayout(112)).toBe("banner-small");
    expect(selectBrandLayout(58)).toBe("banner-small");
    expect(selectBrandLayout(57)).toBe("compact");
    expect(selectBrandLayout(21)).toBe("compact");
    expect(selectBrandLayout(20)).toBe("logo-small");
    expect(selectBrandLayout(12)).toBe("logo-small");
    expect(selectBrandLayout(11)).toBe("label");
  });

  it("uses 80 columns when detection is unavailable or invalid", () => {
    expect(normalizeTerminalColumns(undefined)).toBe(80);
    expect(normalizeTerminalColumns(null)).toBe(80);
    expect(normalizeTerminalColumns(Number.NaN)).toBe(80);
    expect(normalizeTerminalColumns(0)).toBe(80);
    expect(normalizeTerminalColumns(58.9)).toBe(58);
    expect(selectBrandLayout(undefined)).toBe("banner-small");
  });

  it.each([1, 5, 9, 10, 11, 12, 20, 21, 57, 58, 112, 113, 140])(
    "never emits a raw line wider than %i columns",
    async (columns) => {
      const brandFrame = await renderBrandFrame({ columns });
      expect(brandFrame.width).toBeLessThanOrEqual(columns);
      expect(brandFrame.lines.every((line) => line.length <= columns)).toBe(true);
    },
  );

  it("composes the compact wordmark from the small mark without redrawing it", async () => {
    const assets = await loadBrandAssets();
    const compact = await renderBrandFrame({ columns: 57 });
    expect(compact.layout).toBe("compact");
    expect(compact.lines).toHaveLength(assets.logoSmall.length);
    expect(compact.lines.filter((line) => line.includes("intentum"))).toHaveLength(1);
    expect(compact.lines.map((line) => line.slice(0, 12).trimEnd())).toEqual(assets.logoSmall);
  });

  it("styles point cells only and leaves the wordmark/default foreground untouched", async () => {
    const brandFrame = await renderBrandFrame({ columns: 58 });
    const styled = styleBrandFrame(brandFrame, (point) => `<red>${point}</red>`);
    const styledText = styled.join("\n");

    expect(styledText).toContain("<red>ooo</red>");
    expect(styledText).not.toContain("<red>intentum");
    expect(styledText.replaceAll(/<\/?red>/g, "")).toBe(brandFrame.lines.join("\n"));
    expect(styledText.match(/<red>/g)).toHaveLength(2);
  });

  it("uses @ as the big point mask and supports the ANSI 31 convenience renderer", async () => {
    const brandFrame = await renderBrandFrame({ columns: 113 });
    const styled = await renderBrandLines({ columns: 113, colorSignal: ansi31 });

    expect(brandFrame.layout).toBe("banner-big");
    expect(styled.join("\n")).toContain("\u001b[31m@@@@@@\u001b[39m");
    expect(styled.join("\n").replaceAll(/\u001b\[(?:31|39)m/g, "")).toBe(brandFrame.lines.join("\n"));
  });

  it("provides the compact post-banner identity in every glyph preset", async () => {
    expect(intentumLabel()).toBe("⋗ intentum");
    expect(intentumLabel("my-app")).toBe("⋗ intentum · my-app");
    expect(intentumLabel("intentum")).toBe("⋗ intentum");
    expect(intentumLabel("my-app", { symbols: "ascii" })).toBe(">• intentum · my-app");
    expect(intentumLabel("my-app", { symbols: "nerd" })).toBe("\u{F08C9} intentum · my-app");

    expect((await renderBrandFrame({ columns: 11 })).lines).toEqual(["⋗ intentum"]);
    expect((await renderBrandFrame({ columns: 5 })).lines).toEqual(["⋗ int"]);
  });

  it("measures the Nerd Font mark as one cell although it is a surrogate pair", async () => {
    const frame = await renderBrandFrame({ columns: 10, symbols: "nerd" });
    expect(frame.lines).toEqual(["\u{F08C9} intentum"]);
    expect(frame.width).toBe(10);
  });

  it("follows INTENTUM_SYMBOLS when no preset is given", () => {
    vi.stubEnv("INTENTUM_SYMBOLS", "ascii");
    expect(intentumLabel("my-app")).toBe(">• intentum · my-app");
  });
});
