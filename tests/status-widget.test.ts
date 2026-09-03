import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/state/schema.js";
import { renderStatusWidget } from "../src/tui/status-widget.js";

describe("intentum status branding", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the compact intentum identifier instead of replaying a banner", () => {
    const lines = renderStatusWidget(projectState());
    expect(lines[0]).toBe("⋗ intentum · Fixture Product    DISCOVERY");
    expect(lines.join("\n")).not.toMatch(/#{4}|@{2}|o{2}/);
  });

  it("supports the documented fallback when the preferred glyph is unavailable", () => {
    expect(renderStatusWidget(projectState(), { unicode: false })[0]).toBe(
      ">• intentum · Fixture Product    DISCOVERY",
    );
  });

  it("uses the environment fallback in normal status rendering", () => {
    vi.stubEnv("INTENTUM_ASCII_MARK", "1");
    expect(renderStatusWidget(projectState())[0]).toBe(
      ">• intentum · Fixture Product    DISCOVERY",
    );
  });
});

function projectState(): ProjectState {
  return {
    schemaVersion: 1,
    projectId: "fixture",
    projectName: "Fixture Product",
    phase: "discovery",
    autonomy: "guided",
    workers: {},
    pendingDecisions: [],
    schedulerPaused: false,
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}
