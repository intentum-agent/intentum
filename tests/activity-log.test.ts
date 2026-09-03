import { mkdir, readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ActivityLog } from "../src/state/activity-log.js";
import { createTempRepository } from "./helpers/temp-repo.js";

describe("ActivityLog", () => {
  it("serializes concurrent appends as complete JSONL entries", async () => {
    const fixture = await createTempRepository();
    try {
      const activity = new ActivityLog(fixture.repo);
      const eventCount = 40;

      await Promise.all(
        Array.from({ length: eventCount }, (_, sequence) =>
          activity.append({
            type: "concurrent_event",
            sequence,
            time: `2026-09-03T00:00:${String(sequence).padStart(2, "0")}.000Z`,
          }),
        ),
      );

      const entries = (await readFile(activity.path, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; sequence: number; time: string });

      expect(entries).toHaveLength(eventCount);
      expect(entries.map((entry) => entry.sequence)).toEqual(
        Array.from({ length: eventCount }, (_, sequence) => sequence),
      );
      expect(entries.every((entry) => entry.type === "concurrent_event")).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("resolves failed writes and keeps later appends usable", async () => {
    const fixture = await createTempRepository();
    try {
      const activity = new ActivityLog(fixture.repo);

      // A directory at the log file path makes appendFile fail with EISDIR on
      // every supported platform without relying on permission bits/root rules.
      await mkdir(activity.path, { recursive: true });
      await expect(
        activity.append({ type: "write_that_cannot_be_persisted", time: "2026-09-03T00:00:00.000Z" }),
      ).resolves.toBeUndefined();

      await rm(activity.path, { recursive: true });
      await expect(
        activity.append({ type: "write_after_failure", time: "2026-09-03T00:00:01.000Z" }),
      ).resolves.toBeUndefined();

      const entries = (await readFile(activity.path, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      expect(entries).toEqual([{ type: "write_after_failure", time: "2026-09-03T00:00:01.000Z" }]);
    } finally {
      await fixture.cleanup();
    }
  });
});
