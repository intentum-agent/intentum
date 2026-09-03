import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import intentumExtension from "../extensions/intentum.js";
import { splitArguments } from "../src/tools/commands.js";

describe("intentum extension registration", () => {
  it("registers the narrow Phase 1/2 surface without doing work in the factory", () => {
    const commands: string[] = [];
    const tools: string[] = [];
    const events: string[] = [];
    const fake = {
      registerCommand(name: string) {
        commands.push(name);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      on(event: string) {
        events.push(event);
      },
    } as unknown as ExtensionAPI;

    intentumExtension(fake);
    expect(commands).toEqual(["intentum"]);
    expect(tools).toEqual([
      "intentum_project",
      "intentum_create_work",
      "intentum_worker",
      "intentum_integrate",
    ]);
    expect(events).toEqual(["session_start", "before_agent_start", "session_shutdown"]);
  });

  it("parses quoted command arguments without invoking a shell", () => {
    expect(splitArguments("steer W-001 \"keep the name stable\"")).toEqual([
      "steer",
      "W-001",
      "keep the name stable",
    ]);
  });
});
