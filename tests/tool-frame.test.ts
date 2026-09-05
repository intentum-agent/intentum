import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  capPreviewLines,
  formatDuration,
  liveSpinnerFrame,
  mergedCallComponent,
  renderJsonTreeLines,
  renderOutputBlock,
  renderStatusLine,
  shortenPath,
} from "../src/tui/tool-frame.js";
import { liveToolCount, settleLiveTools } from "../src/tui/live-ticker.js";
import { SYMBOL_SETS } from "../src/tui/symbols.mjs";
import { PLAIN_TRANSCRIPT_STYLE, PLAIN_TRANSCRIPT_THEME, type TranscriptTheme } from "../src/tui/transcript-style.js";

const MARKED: TranscriptTheme = {
  ...PLAIN_TRANSCRIPT_THEME,
  style: {
    ...PLAIN_TRANSCRIPT_STYLE,
    accent: (text) => `<a>${text}</a>`,
    dim: (text) => `<d>${text}</d>`,
    muted: (text) => `<m>${text}</m>`,
    error: (text) => `<e>${text}</e>`,
    success: (text) => `<s>${text}</s>`,
  },
};

describe("status line", () => {
  it("leads with the state icon and joins meta with the preset dot", () => {
    const line = renderStatusLine(
      { icon: "success", title: "Read", description: "src/app.ts:1-40", badge: { label: "cached", tone: "muted" }, meta: ["120 lines", "4.1KB"] },
      MARKED,
    );
    expect(line).toBe("<s>✔</s> <a>Read</a>: <m>src/app.ts:1-40</m> <m>[cached]</m> <d>120 lines · 4.1KB</d>");
  });

  it("draws the shared spinner frame for a running call and flattens newlines", () => {
    const line = renderStatusLine({ icon: "running", spinnerFrame: 3, title: "Bash", description: "a\nb" }, MARKED);
    expect(line).toBe(`<a>${SYMBOL_SETS.unicode.spinner[3]}</a> <a>Bash</a>: <m>a b</m>`);
    expect(renderStatusLine({ icon: "pending", title: "Write" }, PLAIN_TRANSCRIPT_THEME)).toBe("○ Write");
  });
});

describe("output block", () => {
  it("frames a header, labeled sections, and wrapped content at exactly the width", () => {
    const lines = renderOutputBlock(
      {
        header: "Bash",
        headerMeta: "1.2s",
        state: "success",
        sections: [{ lines: ["$ echo hi"] }, { label: "Output", lines: ["hi", "a much longer line that must wrap"] }],
        width: 24,
      },
      PLAIN_TRANSCRIPT_THEME,
    );
    expect(lines).toEqual([
      "╭─── Bash · 1.2s ──────╮",
      "│ $ echo hi            │",
      "├─── Output ───────────┤",
      "│ hi                   │",
      "│ a much longer line   │",
      "│ that must wrap       │",
      "╰──────────────────────╯",
    ]);
    for (const line of lines) expect(visibleWidth(line)).toBe(24);
  });

  it("colors only the border by state and never paints a row background", () => {
    const [top, body] = renderOutputBlock({ state: "error", sections: [{ lines: ["x\u001b[0my"] }], width: 12 }, MARKED);
    expect(top?.startsWith("<e>╭───</e>")).toBe(true);
    expect(body).toBe("<e>│</e> x\u001b[0my       <e>│</e>");
    const [pending] = renderOutputBlock({ state: "pending", width: 8 }, MARKED);
    expect(pending?.startsWith("<a>╭───</a>")).toBe(true);
    expect(pending).not.toMatch(/\u001b\[4[0-9]/);
  });

  it("truncates an overlong header label instead of overflowing", () => {
    const [top] = renderOutputBlock({ header: "a".repeat(40), width: 16 }, PLAIN_TRANSCRIPT_THEME);
    expect(visibleWidth(top ?? "")).toBe(16);
    expect(top).toContain("…");
  });
});

describe("previews", () => {
  it("keeps the tail visible behind an earlier-lines marker with the expand hint", () => {
    const lines = capPreviewLines(["1", "2", "3", "4", "5"], PLAIN_TRANSCRIPT_THEME, { max: 3 });
    expect(lines).toEqual(["… 3 earlier lines [ctrl+o: Expand]", "4", "5"]);
    expect(capPreviewLines(["1", "2"], PLAIN_TRANSCRIPT_THEME, { max: 3 })).toEqual(["1", "2"]);
    expect(capPreviewLines(["1", "2", "3"], PLAIN_TRANSCRIPT_THEME, { max: 2, expanded: true })).toHaveLength(3);
  });

  it("formats durations and shortens paths the way the user reads them", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(shortenPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(shortenPath("/elsewhere/a.ts", "/repo")).toBe("/elsewhere/a.ts");
    expect(shortenPath("src/a.ts", "/repo")).toBe("src/a.ts");
  });
});

describe("json tree and default card", () => {
  it("renders a bounded json tree with connectors", () => {
    const tree = renderJsonTreeLines({ id: "W-001", files: ["a", "b"], meta: { deep: { deeper: 1 } } }, PLAIN_TRANSCRIPT_THEME, 2, 20, 40);
    expect(tree.lines).toEqual([
      '├─ id: "W-001"',
      "├─ files",
      '│  ├─ [0]: "a"',
      '│  └─ [1]: "b"',
      "└─ meta",
      "   └─ deep",
      "      └─ …",
    ]);
    expect(tree.truncated).toBe(false);
  });
});

describe("live tool tracking", () => {
  it("registers only executing calls and settles them on the final result", () => {
    settleLiveTools();
    const state = {};
    const context = { toolCallId: "call-1", executionStarted: false, state, invalidate: () => {} };
    expect(liveSpinnerFrame(context, PLAIN_TRANSCRIPT_THEME, false, 1000)).toBeUndefined();
    expect(liveToolCount()).toBe(0);
    expect(liveSpinnerFrame({ ...context, executionStarted: true }, PLAIN_TRANSCRIPT_THEME, false, 1000)).toBeTypeOf("number");
    expect(liveToolCount()).toBe(1);
    expect(state).toEqual({ startedAt: 1000 });
    expect(liveSpinnerFrame({ ...context, executionStarted: true }, PLAIN_TRANSCRIPT_THEME, true, 2500)).toBeUndefined();
    expect(liveToolCount()).toBe(0);
    expect(state).toEqual({ startedAt: 1000, endedAt: 2500 });
  });

  it("hides the merged call component once the result owns the frame", () => {
    const state: { hasResult?: boolean } = {};
    const call = mergedCallComponent(state, () => ["call"]);
    expect(call.render(40)).toEqual(["call"]);
    state.hasResult = true;
    expect(call.render(40)).toEqual([]);
  });
});
