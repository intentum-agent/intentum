import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/git/worktree-manager.js";
import { runFile } from "../src/utils/process.js";
import { createTempRepository } from "./helpers/temp-repo.js";

async function commitAll(cwd: string, message: string): Promise<void> {
  await runFile("git", ["add", "-A"], cwd);
  await runFile("git", ["-c", "commit.gpgSign=false", "commit", "-m", message], cwd);
}

describe("worktree provisioning failures", () => {
  it("removes the branch git created before a failed checkout", async () => {
    const fixture = await createTempRepository();
    // The worktree parent exists but cannot be written into, so `git worktree
    // add` fails during checkout — after it has already created the branch.
    const worktreeParent = join(fixture.cache, "P-1", "worktrees");
    try {
      await mkdir(worktreeParent, { recursive: true });
      await chmod(worktreeParent, 0o500);
      const manager = new WorktreeManager(fixture.repo, fixture.cache);
      await expect(manager.create("P-1", "F-001", "W-001")).rejects.toThrow();
      const branches = (await runFile("git", ["branch", "--list", "intentum/F-001/W-001"], fixture.repo)).stdout;
      expect(branches.trim()).toBe("");
    } finally {
      await chmod(worktreeParent, 0o700).catch(() => undefined);
      await fixture.cleanup();
    }
  });
});

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

  it("sees a rename that moves controller state out of .intentum", async () => {
    const fixture = await createTempRepository();
    try {
      // Rename detection reports only the destination of a rename, so a
      // deletion of a tracked `.intentum/*` file would otherwise be invisible.
      await mkdir(join(fixture.repo, ".intentum"), { recursive: true });
      await writeFile(join(fixture.repo, ".intentum", "state.json"), `${"x".repeat(400)}\n`, "utf8");
      await commitAll(fixture.repo, "chore: track controller state");
      const manager = new WorktreeManager(fixture.repo, fixture.cache);
      const record = await manager.create("P-1", "F-001", "W-001");
      await runFile("git", ["mv", ".intentum/state.json", "notes.md"], record.path);
      await commitAll(record.path, "chore: move controller state out");
      await expect(manager.assertCompletedWorktree(record.path, record.baseCommit, record.branch))
        .rejects.toThrow("controller-owned state (.intentum, .pi)");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a result that commits Pi's own .pi configuration directory", async () => {
    const fixture = await createTempRepository();
    try {
      const manager = new WorktreeManager(fixture.repo, fixture.cache);
      const record = await manager.create("P-1", "F-001", "W-001");
      // A committed .pi/extensions entry would run as host code in the next
      // project-trusted Pi session.
      await mkdir(join(record.path, ".pi", "extensions"), { recursive: true });
      await writeFile(join(record.path, ".pi", "extensions", "x.ts"), "export default () => {};\n", "utf8");
      await commitAll(record.path, "chore: add a pi extension");
      await expect(manager.assertCompletedWorktree(record.path, record.baseCommit, record.branch))
        .rejects.toThrow("controller-owned state (.intentum, .pi)");
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
        .rejects.toThrow("controller-owned state (.intentum, .pi)");
    } finally {
      await fixture.cleanup();
    }
  });
});
