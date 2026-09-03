import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderBrandLines } from "../src/tui/brand.js";

// The executable intentionally ships as plain ESM so Node can run it directly
// from an npm bin shim without a build step.
// @ts-expect-error the shipped .mjs executable has no separate declaration file
import { renderBrand, runCli } from "../bin/intentum.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const ansiPattern = /\u001b\[[0-9;]*m/g;

interface CaptureStream {
  columns?: number;
  isTTY?: boolean;
  output: string;
  write(chunk: string | Uint8Array): boolean;
}

function captureStream(columns?: number, isTTY = false): CaptureStream {
  const stream: CaptureStream = {
    isTTY,
    output: "",
    write(chunk) {
      this.output += String(chunk);
      return true;
    },
  };
  if (columns !== undefined) stream.columns = columns;
  return stream;
}

async function renderAt(columns?: number, color = false): Promise<string[]> {
  const stdout = captureStream(columns, color);
  const env = color ? { FORCE_COLOR: "1" } : { NO_COLOR: "1" };
  return renderBrand({ stdout, env });
}

function visible(line: string): string {
  return line.replace(ansiPattern, "");
}

describe("intentum terminal brand", () => {
  it("stays byte-for-byte aligned with the Pi TUI renderer at every layout boundary", async () => {
    for (const columns of [113, 112, 58, 57, 21, 20, 12, 11, 9]) {
      await expect(renderAt(columns)).resolves.toEqual(
        await renderBrandLines({ columns, unicode: true }),
      );
    }
  });

  it("uses the 80-column small lockup when stdout.columns is unknown", async () => {
    const lines = await renderAt();
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("####            _       _             _");
    expect(Math.max(...lines.map((line) => line.length))).toBe(58);
  });

  it.each([
    [113, 18, "big"],
    [112, 6, "small"],
    [58, 6, "small"],
    [57, 6, "compact"],
    [21, 6, "compact"],
    [20, 6, "logo"],
    [12, 6, "logo"],
    [11, 1, "label"],
    [9, 1, "label"],
  ] as const)("selects a width-safe %s-column layout", async (columns, lineCount, layout) => {
    const lines = await renderAt(columns);
    expect(lines).toHaveLength(lineCount);
    expect(Math.max(...lines.map((line) => visible(line).length))).toBeLessThanOrEqual(columns);

    if (layout === "big") expect(lines.join("\n")).toContain("@@@@@@");
    if (layout === "small") expect(lines[0]).toContain("_       _");
    if (layout === "compact") expect(lines.join("\n")).toContain("ooo intentum");
    if (layout === "logo") {
      expect(lines.join("\n")).toContain("ooo");
      expect(lines.join("\n")).not.toContain("intentum");
    }
    if (layout === "label") expect("⋗ intentum".startsWith(lines[0] ?? "")).toBe(true);
  });

  it.each([
    [58, "o"],
    [113, "@"],
  ] as const)("colors only signal-point cells at %s columns", async (columns, point) => {
    const colored = await renderAt(columns, true);
    const plain = await renderAt(columns);
    expect(colored.map(visible)).toEqual(plain);

    const coloredRuns = colored
      .flatMap((line) => [...line.matchAll(/\u001b\[31m([^\u001b]+)\u001b\[39m/g)])
      .map((match) => match[1]);
    expect(coloredRuns.length).toBeGreaterThan(0);
    expect(coloredRuns.every((run) => (
      run !== undefined && run.length > 0 && [...run].every((character) => character === point)
    ))).toBe(true);
  });

  it("supports an explicit ASCII fallback for the compact prompt mark", async () => {
    const stdout = captureStream(11);
    await expect(renderBrand({
      stdout,
      env: { NO_COLOR: "1", INTENTUM_ASCII_MARK: "1" },
    })).resolves.toEqual([">• intentum"]);
  });
});

describe("intentum CLI help and version", () => {
  it("prints branded help without creating project state or starting a provider", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const statePath = join(projectRoot, ".intentum", "state.json");
    const stateExistedBefore = existsSync(statePath);

    await expect(runCli(["--help"], {
      stdout,
      stderr,
      env: { NO_COLOR: "1" },
    })).resolves.toBe(0);
    expect(stderr.output).toBe("");
    expect(stdout.output).toContain("####            _");
    expect(stdout.output).toContain("Usage:");
    expect(stdout.output).toContain("pi install npm:pi-intentum");
    expect(stdout.output).toContain("intentum init [name]");
    expect(stdout.output).toContain("intentum doctor");
    expect(existsSync(statePath)).toBe(stateExistedBefore);
  });

  it("prints the package version and branded lockup", async () => {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const stdout = captureStream();
    const stderr = captureStream();
    await expect(runCli(["--version"], {
      stdout,
      stderr,
      env: { NO_COLOR: "1" },
    })).resolves.toBe(0);
    expect(stderr.output).toBe("");
    expect(stdout.output).toContain("####            _");
    expect(stdout.output).toContain(`intentum v${packageJson.version}`);
  });
});
