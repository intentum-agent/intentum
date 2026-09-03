import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/git/worktree-manager.js";
import { runFile } from "../src/utils/process.js";
import { createTempRepository } from "./helpers/temp-repo.js";

async function commitAll(cwd: string, message: string): Promise<void> {
  await runFile("git", ["add", "-A"], cwd);
  await runFile("git", ["-c", "commit.gpgSign=false", "commit", "-m", message], cwd);
}

describe("worktree verification with non-ASCII paths", () => {
  it("reports non-ASCII file names literally instead of C-quoted", async () => {
    const fixture = await createTempRepository();
    try {
      const manager = new WorktreeManager(fixture.repo, fixture.cache);
      const record = await manager.create("P-1", "F-001", "W-001");
      await writeFile(join(record.path, "café.txt"), "hello\n", "utf8");
      await commitAll(record.path, "feat: add café");
      const verified = await manager.assertCompletedWorktree(record.path, record.baseCommit, record.branch);
      expect(verified.files).toEqual(["café.txt"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("still rejects controller-owned .intentum paths when git would quote them", async () => {
    const fixture = await createTempRepository();
    try {
      const manager = new WorktreeManager(fixture.repo, fixture.cache);
      const record = await manager.create("P-1", "F-001", "W-001");
      await mkdir(join(record.path, ".intentum"), { recursive: true });
      await writeFile(join(record.path, ".intentum", "café.json"), "{}\n", "utf8");
      await commitAll(record.path, "chore: touch controller state");
      await expect(manager.assertCompletedWorktree(record.path, record.baseCommit, record.branch))
        .rejects.toThrow("controller-owned .intentum state");
    } finally {
      await fixture.cleanup();
    }
  });
});
