import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { clipHeadToCellWidth, clipSingleLine, clipToCellWidth, padToCellWidth, singleLine, wrapToCellWidth } from "../src/tui/text-layout.js";

describe("terminal text layout", () => {
  it("clips CJK by cells instead of JavaScript string length", () => {
    expect(clipToCellWidth("产品设计审阅", 7)).toBe("产品设…");
    expect(visibleWidth(clipToCellWidth("产品设计审阅", 7))).toBe(7);
  });

  it("never splits a joined emoji grapheme", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(clipToCellWidth(`A${family}BC`, 4)).toBe(`A${family}…`);
    expect(clipToCellWidth(`A${family}BC`, 2)).toBe("A…");
  });

  it("keeps the tail of a path and never splits a wide grapheme at the cut", () => {
    expect(clipHeadToCellWidth("~/dev/app", 9)).toBe("~/dev/app");
    expect(clipHeadToCellWidth("~/very/long/path/leaf", 9)).toBe("…ath/leaf");
    expect(clipHeadToCellWidth("目录/产品设计/审阅", 8)).toBe("…计/审阅");
    expect(clipHeadToCellWidth("目录/产品设计/审阅", 7)).toBe("…/审阅");
  });

  it("collapses copy before clipping and pads by visible cells", () => {
    expect(singleLine(" first\n\tsecond  third ")).toBe("first second third");
    expect(singleLine("\u001b[31mred\u001b[0m\u0000 text")).toBe("red text");
    expect(clipSingleLine("一行\n二行", 7)).toBe("一行 …");
    expect(padToCellWidth("中文", 6)).toBe("中文  ");
  });

  it("wraps without breaking emoji or exceeding ordinary cell widths", () => {
    const family = "👨‍👩‍👧‍👦";
    const lines = wrapToCellWidth(`中文${family}abc`, 4);
    expect(lines).toEqual(["中文", `${family}ab`, "c"]);
    expect(lines.every((line) => visibleWidth(line) <= 4)).toBe(true);
  });

  it("wraps English at word boundaries before falling back to graphemes", () => {
    expect(wrapToCellWidth("Keep shaping the product with a targeted instruction.", 18)).toEqual([
      "Keep shaping the",
      "product with a",
      "targeted",
      "instruction.",
    ]);
  });
});
