import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import { loadRepositoryEvidence } from "../src/runtime/repository-brief.js";
import { runFile } from "../src/utils/process.js";
import { ScriptedWorkerFactory } from "./helpers/scripted-worker.js";
import { createTempRepository } from "./helpers/temp-repo.js";

describe("designerContext", () => {
  it("injects repository evidence and a repo-first protocol", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    try {
      await writeFile(join(fixture.repo, "package.json"), `${JSON.stringify({
        name: "evidence-app",
        description: "Users already live in this repository.",
      })}\n`, "utf8");
      await mkdir(join(fixture.repo, "src"));
      await writeFile(join(fixture.repo, "src", "index.ts"), "export {}\n", "utf8");
      await runFile("git", ["add", "package.json", "src/index.ts"], fixture.repo);
      await runFile("git", ["commit", "-m", "feat: evidence"], fixture.repo);
      await runtime.initialize("Evidence App");

      const context = await runtime.designerContext();
      expect(context).toContain("<repository_evidence>");
      expect(context).toContain("\"posture\":\"existing-product\"");
      expect(context).toContain("evidence-app");
      expect(context).toContain("# Fixture");
      expect(context).toContain("Do not treat an existing tree as a blank app");
      expect(context).toContain("Prefer confirming a draft over \"who is this for?\"");
      expect(context).toContain("Greenfield contracts are allowed only when the tree is empty");
      expect(context).toContain("<approved_charter>");
      expect(context).toContain("Infer from the repository; confirm only unresolved product decisions");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("keeps charter context when the tree is only sparse evidence", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    try {
      await runtime.initialize("Sparse App");
      expect(await loadRepositoryEvidence(join(fixture.root, "missing-tree"))).toBe(
        JSON.stringify({ unavailable: true }),
      );
      const context = await runtime.designerContext();
      expect(context).toContain("# intentum Designer mode");
      expect(context).toContain("<repository_evidence>");
      expect(context).toContain("\"posture\":\"sparse\"");
      expect(context).toContain("<approved_charter>");
      expect(context).toContain("<approved_architecture>");
      expect(context).toContain("# Fixture");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });
});
