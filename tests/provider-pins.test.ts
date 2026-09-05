import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderPinStore } from "../src/state/provider-pins.js";

describe("provider pin persistence", () => {
  it("seeds at most three real choices, preserves explicit unpins, and merges concurrent toggles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentum-pins-"));
    try {
      const path = join(directory, "pins.json");
      const first = new ProviderPinStore(path);
      expect(await first.load(["alpha", "beta", "alpha", "gamma", "delta"])).toEqual(["alpha", "beta", "gamma"]);
      await Promise.all([first.setPinned("alpha", false), new ProviderPinStore(path).setPinned("delta", true)]);
      expect(await new ProviderPinStore(path).load(["alpha"])).toEqual(["beta", "gamma", "delta"]);
      for (const key of ["beta", "gamma", "delta"]) await first.setPinned(key, false);
      expect(await first.load(["alpha"])).toEqual([]);
      await writeFile(path, "broken");
      await expect(first.load()).rejects.toThrow();
      await expect(first.setPinned("alpha", true)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe("broken");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
