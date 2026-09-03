import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkContractStore, assertWorkContract, type WorkContract } from "../src/work/contract.js";
import { createTempRepository } from "./helpers/temp-repo.js";

const VALID: WorkContract = {
  id: "W-001",
  featureId: "F-001",
  title: "Validated contract",
  objective: "Validate every persisted contract field.",
  why: "Corrupt durable input should fail at its boundary.",
  userVisibleResult: "Invalid contracts are rejected clearly.",
  scope: { inScope: ["validation"], outOfScope: [] },
  interfaces: [],
  constraints: [],
  acceptanceCriteria: ["invalid arrays are rejected"],
  dependencies: [],
  touchHints: [],
  risk: "low",
  preferredWorkerKind: "implementation",
  contextFiles: [],
};

describe("WorkContract validation", () => {
  it("validates every array and enum instead of trusting TypeScript at runtime", () => {
    expect(() => assertWorkContract(VALID)).not.toThrow();
    expect(() => assertWorkContract({ ...VALID, dependencies: [""] })).toThrow("dependencies");
    expect(() => assertWorkContract({ ...VALID, acceptanceCriteria: [] })).toThrow("acceptanceCriteria");
    expect(() => assertWorkContract({ ...VALID, preferredWorkerKind: "microtask" } as unknown as WorkContract)).toThrow(
      "preferredWorkerKind",
    );
  });

  it("revalidates contracts read from durable JSON", async () => {
    const fixture = await createTempRepository();
    try {
      const directory = join(fixture.repo, ".intentum", "features", "F-001");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "work.json"), JSON.stringify({
        schemaVersion: 1,
        work: [{ ...VALID, constraints: "not-an-array" }],
      }), "utf8");
      await expect(new WorkContractStore(fixture.repo).get("F-001", "W-001")).rejects.toThrow("constraints");
    } finally {
      await fixture.cleanup();
    }
  });
});
