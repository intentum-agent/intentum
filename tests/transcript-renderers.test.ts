import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerBuiltinToolRenderers } from "../src/tools/transcript/builtin-renderers.js";
import { registerDesignerTools } from "../src/tools/designer-tools.js";
import { settleLiveTools } from "../src/tui/live-ticker.js";
import type { IntentumRuntime } from "../src/runtime/intentum-runtime.js";

/**
 * Renders the overrides the way Pi mounts them: through the real
 * `ToolExecutionComponent` with the real dark theme, so the frame shape,
 * widths, spinner, and call/result merging are exercised end-to-end.
 */

const WIDTH = 72;
const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (lines: readonly string[]) => lines.map((line) => line.replace(ANSI, ""));
/** Pi routes `context.invalidate()` to `ui.requestRender()`; async previews announce themselves through it. */
let renderRequested: (() => void) | undefined;
const ui = {
  requestRender() {
    renderRequested?.();
  },
};

let dir: string;
const tools = new Map<string, ToolDefinition>();
const pi = {
  registerTool(tool: ToolDefinition) {
    tools.set(tool.name, tool);
  },
} as unknown as ExtensionAPI;

beforeAll(async () => {
  initTheme("dark");
  dir = await mkdtemp(join(tmpdir(), "intentum-transcript-"));
  await writeFile(join(dir, "app.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  registerBuiltinToolRenderers(pi, dir);
  registerDesignerTools(pi, () => ({}) as unknown as IntentumRuntime);
});

afterAll(async () => {
  settleLiveTools();
  await rm(dir, { recursive: true, force: true });
});

function mount(name: string, args: unknown): ToolExecutionComponent {
  const definition = tools.get(name);
  if (!definition) throw new Error(`tool ${name} not registered`);
  return new ToolExecutionComponent(name, `call-${name}-${Math.random()}`, args, {}, definition, ui as never, dir);
}

function expectFramed(lines: readonly string[]): string[] {
  const rows = plain(lines).filter((line) => line !== "");
  expect(rows[0]?.startsWith("╭───")).toBe(true);
  expect(rows.at(-1)?.startsWith("╰───")).toBe(true);
  for (const line of lines) if (line) expect(visibleWidth(line)).toBe(WIDTH);
  return rows;
}

describe("built-in tool frames", () => {
  it("draws read as one merged frame that grows an output body when the result lands", () => {
    const component = mount("read", { path: "app.ts" });
    component.setArgsComplete();
    const pending = expectFramed(component.render(WIDTH));
    expect(pending[0]).toContain("○ Read: app.ts");
    expect(pending).toHaveLength(2);

    component.markExecutionStarted();
    const running = expectFramed(component.render(WIDTH));
    expect(running[0]).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Read: app\.ts/);

    component.updateResult({ content: [{ type: "text", text: "export const a = 1;\nexport const b = 2;\n\n[3 lines total]" }], isError: false }, false);
    const done = expectFramed(component.render(WIDTH));
    expect(done[0]).toContain("✔ Read: app.ts");
    expect(done.slice(1, -1).map((row) => row.replace(/\s+│$/, "").trimEnd())).toEqual(["│  1 export const a = 1;", "│  2 export const b = 2;", "│ [3 lines total]"]);
    // The call component yields to the result: exactly one frame, no duplicate header.
    expect(done.filter((row) => row.includes("Read: app.ts"))).toHaveLength(1);
  });

  it("draws bash with the command on top, a labeled Output section, and the outcome in the stats line", () => {
    const component = mount("bash", { command: "printf 'x\\ny\\n'; exit 3" });
    component.setArgsComplete();
    component.markExecutionStarted();
    component.updateResult({ content: [{ type: "text", text: "x\ny" }], isError: false }, true);
    const partial = expectFramed(component.render(WIDTH));
    expect(partial.find((row) => row.includes("$ printf"))).toBeDefined();
    expect(partial.find((row) => /running/.test(row))).toBeDefined();

    component.updateResult({ content: [{ type: "text", text: "x\ny\n\nCommand exited with code 3" }], isError: true }, false);
    const failed = expectFramed(component.render(WIDTH));
    expect(failed.some((row) => row.includes("├─── Output"))).toBe(true);
    expect(failed.some((row) => row.includes("Command exited"))).toBe(false);
    expect(failed.find((row) => row.includes("[Exit: 3"))).toBeDefined();
  });

  it("draws an edit diff preview from the file on disk before the tool runs", async () => {
    const component = mount("edit", { path: "app.ts", edits: [{ oldText: "b = 2", newText: "b = 20" }] });
    component.setArgsComplete();
    // The first render schedules the on-disk diff; the preview repaints through invalidate().
    // tsconfig targets ES2022, so the executor form stands in for Promise.withResolvers.
    const repainted = new Promise<void>((resolve) => {
      renderRequested = resolve;
    });
    component.render(WIDTH);
    await repainted;
    const preview = expectFramed(component.render(WIDTH));
    expect(preview[0]).toContain("○ Edit: app.ts");
    expect(preview.some((row) => row.includes("b = 20"))).toBe(true);
    component.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff: "-b = 2\n+b = 20", patch: "", firstChangedLine: 2 }, isError: false }, false);
    const done = expectFramed(component.render(WIDTH));
    expect(done[0]).toContain("✔ Edit: app.ts");
  });

  it("keeps the live edge of a streaming write visible and counts its lines", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const component = mount("write", { path: "notes.txt", content });
    const pending = expectFramed(component.render(WIDTH));
    expect(pending[0]).toContain("Write: notes.txt 30 lines");
    expect(pending.some((row) => row.includes("earlier lines"))).toBe(true);
    expect(pending.some((row) => row.includes("line 30"))).toBe(true);
  });

  it("summarizes grep and ls results in the header meta", () => {
    const grep = mount("grep", { pattern: "const", path: "." });
    grep.updateResult({ content: [{ type: "text", text: "app.ts:1:export const a\napp.ts:2:export const b" }], details: { matchLimitReached: 2 }, isError: false }, false);
    const rows = expectFramed(grep.render(WIDTH));
    expect(rows[0]).toContain("✔ Grep: /const/ in . 2 matches · limit 2 reached");
    const ls = mount("ls", {});
    ls.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false);
    expect(expectFramed(ls.render(WIDTH)).some((row) => row.includes("(empty)"))).toBe(true);
  });
});

describe("designer tool frames", () => {
  it("frames create-work with its objective and acceptance tree", () => {
    const component = mount("intentum_create_work", {
      featureId: "F-1",
      title: "Frames",
      objective: "Ship the frames.",
      acceptanceCriteria: ["Widths exact", "Errors red"],
      risk: "low",
      preferredWorkerKind: "implementation",
    });
    const rows = expectFramed(component.render(WIDTH));
    expect(rows[0]).toContain("Create work: F-1 · Frames");
    expect(rows.some((row) => row.includes("├─── Acceptance"))).toBe(true);
    expect(rows.some((row) => row.includes("└─ Errors red"))).toBe(true);
    component.updateResult({ content: [{ type: "text", text: "W-001 started in /tmp/wt on intentum/F-1/W-001." }], isError: false }, false);
    expect(expectFramed(component.render(WIDTH)).some((row) => row.includes("W-001 started"))).toBe(true);
  });

  it("renders a worker error in the error frame", () => {
    const component = mount("intentum_worker", { action: "pause", workerId: "W-009" });
    component.updateResult({ content: [{ type: "text", text: "Error: unknown Worker W-009" }], isError: true }, false);
    const rows = expectFramed(component.render(WIDTH));
    expect(rows[0]).toContain("✘ Worker: pause W-009");
    expect(rows.some((row) => row.includes("unknown Worker W-009"))).toBe(true);
  });
});
