import { describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { IntentumModelPicker, type PickerModel } from "../src/tui/model-picker.js";

export function model(id: string, provider = "alpha", name = id): PickerModel {
  return {
    id, name, provider, api: "openai-completions", baseUrl: "https://example.test",
    reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 16_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
}

const fixtures = [model("sonnet", "alpha", "Claude Sonnet"), model("gpt", "beta", "GPT Example"), model("local", "local", "Local Model")];
const text = (picker: IntentumModelPicker, width = 100) => picker.render(width).map(stripTerminalSequences).join("\n");

describe("model picker", () => {
  it("preselects the current provider/id and previews its capabilities", () => {
    const picker = new IntentumModelPicker({ models: fixtures, current: fixtures[1], onSelect: vi.fn(), onCancel: vi.fn() });
    expect(picker.selectedModel).toBe(fixtures[1]);
    const output = text(picker);
    for (const value of ["intentum · Models", "Designer / current session", "MODEL DETAILS", "beta", "200k context", "16k output", "Reasoning", "Text + image", "● In use by Designer"]) expect(output).toContain(value);
  });

  it("searches names, IDs, and providers with fuzzy tokens, then selects the result", () => {
    const onSelect = vi.fn();
    const picker = new IntentumModelPicker({ models: fixtures, query: "beta/gpt", onSelect, onCancel: vi.fn() });
    expect(picker.selectedModel).toBe(fixtures[1]);
    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(fixtures[1]);
    picker.handleInput("z");
    expect(picker.query).toBe("beta/gptz");
    expect(picker.selectedModel).toBeUndefined();
    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledTimes(1);
    picker.handleInput("\x7f");
    expect(picker.selectedModel).toBe(fixtures[1]);
  });

  it("cycles provider filters in both directions and keeps the search query", () => {
    const picker = new IntentumModelPicker({ models: fixtures, query: "gpt", onSelect: vi.fn(), onCancel: vi.fn() });
    picker.handleInput("\t");
    expect(picker.selectedModel).toBeUndefined();
    picker.handleInput("\t");
    expect(picker.selectedModel).toBe(fixtures[1]);
    expect(picker.query).toBe("gpt");
    picker.handleInput("\x1b[Z");
    expect(picker.selectedModel).toBeUndefined();
    picker.handleInput("\x1b[Z");
    expect(picker.selectedModel).toBe(fixtures[1]);
  });

  it("keeps keyboard selection visible when paging and resizing", () => {
    const models = Array.from({ length: 50 }, (_, index) => model(`model-${String(index).padStart(2, "0")}`));
    const picker = new IntentumModelPicker({ models, onSelect: vi.fn(), onCancel: vi.fn() });
    picker.setHeight(19);
    picker.render(100);
    picker.handleInput("\x1b[6~");
    expect(picker.selectedModel?.id).toBe("model-10");
    for (let i = 0; i < 25; i++) picker.handleInput("\x1b[B");
    picker.setHeight(12);
    expect(text(picker, 48)).toContain("› model-35");
    picker.handleInput("\x1b[5~");
    expect(picker.selectedModel?.id).toBe("model-33");
  });

  it("handles paste, cancellation, and busy/error states without accidental changes", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new IntentumModelPicker({ models: fixtures, onSelect, onCancel });
    picker.handleInput("\x1b[200~beta/gpt\x1b[201~");
    expect(picker.selectedModel).toBe(fixtures[1]);
    picker.setBusy(true);
    picker.handleInput("\r");
    picker.handleInput("\x1b");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(text(picker)).toContain("Switching model");
    picker.setError("Reconnect with /login");
    expect(text(picker)).toContain("Reconnect with /login");
    picker.handleInput("\x1b");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("explains empty registries and distinguishes an empty search", () => {
    const picker = new IntentumModelPicker({ models: [], onSelect: vi.fn(), onCancel: vi.fn() });
    expect(text(picker)).toContain("No available models");
    expect(text(picker)).toContain("/login");
    const filtered = new IntentumModelPicker({ models: fixtures, query: "zzzzzz", onSelect: vi.fn(), onCancel: vi.fn() });
    expect(text(filtered)).toContain("No matching models");
  });

  it("browses the entire provider list with connected providers first, even in narrow terminals", () => {
    const onConnect = vi.fn();
    const availableKeys = new Set(["beta/gpt"]);
    const picker = new IntentumModelPicker({ models: fixtures, availableKeys, onSelect: vi.fn(), onConnect, onCancel: vi.fn() });
    expect(text(picker, 116)).toContain("1/3 providers ready");
    expect(text(picker, 116)).toContain("○ alpha");
    picker.handleInput("\x10");
    picker.handleInput("\x1b[B");
    expect(text(picker, 60)).toContain("› ☆ ● beta");
    picker.handleInput("\x1b[B");
    expect(text(picker, 60)).toContain("› ☆ ○ alpha");
    picker.handleInput("\r");
    expect(onConnect).toHaveBeenCalledExactlyOnceWith("alpha");
    picker.handleInput("\x1b");
    expect(text(picker, 60)).toContain("Claude Sonnet");
  });

  it("supports provider clicks, model preview, pin toggles, explicit apply, and close", () => {
    const onSelect = vi.fn();
    const onPin = vi.fn();
    const onCancel = vi.fn();
    const picker = new IntentumModelPicker({ models: fixtures, onSelect, onPin, onCancel });
    picker.setHeight(36);
    let lines = picker.render(140).map(stripTerminalSequences);
    expect(lines).toHaveLength(36);
    const beta = lines.findIndex((line) => line.includes("● beta"));
    picker.handleClick(12, beta);
    expect(picker.selectedModel).toBe(fixtures[1]);
    expect(onSelect).not.toHaveBeenCalled();
    lines = picker.render(140).map(stripTerminalSequences);
    const row = lines.findIndex((line) => line.includes("☆ ● beta"));
    picker.handleClick(4, row);
    expect(onPin).toHaveBeenCalledWith("beta", true);
    expect(onSelect).not.toHaveBeenCalled();
    lines = picker.render(140).map(stripTerminalSequences);
    expect(lines.some((line) => line.includes("★ ● beta"))).toBe(true);
    expect(picker.selectedModel).toBe(fixtures[1]);
    const applyRow = lines.findIndex((line) => line.includes("[ Use model ]"));
    picker.handleClick(4, applyRow);
    expect(onSelect).toHaveBeenCalledWith(fixtures[1]);
    picker.handleClick(136, 0);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("provider pins sort first and unpinning preserves both provider filter and model", () => {
    const picker = new IntentumModelPicker({ models: fixtures, pins: ["local"], onSelect: vi.fn(), onCancel: vi.fn() });
    expect(picker.selectedModel).toBe(fixtures[0]);
    const before = picker.render(140).map(stripTerminalSequences);
    expect(before.findIndex((line) => line.includes("★ ● local"))).toBeLessThan(before.findIndex((line) => line.includes("☆ ● alpha")));
    picker.handleInput("\t");
    expect(picker.selectedModel).toBe(fixtures[2]);
    picker.handleInput("\x06");
    expect(picker.selectedModel).toBe(fixtures[2]);
    const after = picker.render(140).map(stripTerminalSequences);
    expect(after.some((line) => line.includes("› ☆ ● local"))).toBe(true);
    expect(after.findIndex((line) => line.includes("☆ ● local"))).toBeGreaterThan(after.findIndex((line) => line.includes("☆ ● alpha")));
    expect(after.join("\n")).not.toContain("☆ Local Model");
  });

  it("can pin another provider without changing the current filter, query, or model", () => {
    const picker = new IntentumModelPicker({ models: fixtures, query: "gpt", onSelect: vi.fn(), onCancel: vi.fn() });
    picker.handleInput("\t");
    picker.handleInput("\t");
    const lines = picker.render(140).map(stripTerminalSequences);
    const localRow = lines.findIndex((line) => line.includes("☆ ● local"));
    picker.handleClick(4, localRow);
    expect(picker.query).toBe("gpt");
    expect(picker.selectedModel).toBe(fixtures[1]);
    expect(picker.render(140).map(stripTerminalSequences).some((line) => line.includes("› ☆ ● beta"))).toBe(true);
  });

  it("scrolls the pane beneath the pointer and drops old hit targets on resize", () => {
    const models = Array.from({ length: 40 }, (_, i) => model(`model-${String(i).padStart(2, "0")}`, "alpha"));
    const onSelect = vi.fn();
    const picker = new IntentumModelPicker({ models, onSelect, onCancel: vi.fn() });
    picker.setHeight(36);
    picker.render(140);
    picker.handleWheel(40, 7, 1);
    expect(picker.selectedModel?.id).toBe("model-03");
    picker.handleWheel(-1, -1, 1);
    expect(picker.selectedModel?.id).toBe("model-03");
    picker.setHeight(9);
    picker.render(28);
    expect(picker.handleClick(40, 34)).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("fits narrow and short viewports, including CJK, emoji, and terminal escapes", () => {
    const unsafe = model("very-long-id".repeat(15), "provider\nname", "模型 👩‍💻 é \x1b[31mred\x1b[0m\n".repeat(15));
    const picker = new IntentumModelPicker({ models: [unsafe], onSelect: vi.fn(), onCancel: vi.fn(), style: { accent: (value) => `\x1b[36m${value}\x1b[39m` } });
    for (const width of [1, 12, 31, 32, 48, 72, 87, 88, 100, 140]) {
      for (const height of [1, 5, 9, 10, 12, 16, 17, 23, 40]) {
        picker.setHeight(height);
        const lines = picker.render(width);
        expect(lines.length, `${width}x${height}`).toBeLessThanOrEqual(height);
        expect(lines.every((line) => visibleWidth(line) <= width && !line.includes("\n")), `${width}x${height}`).toBe(true);
        expect(lines.join("\n")).not.toContain("\x1b[31m");
      }
    }
  });
});
