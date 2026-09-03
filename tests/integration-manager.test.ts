import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { IntegrationManager, type IntegrationRequest } from "../src/git/integration-manager.js";
import { runFile } from "../src/utils/process.js";
import { createTempRepository } from "./helpers/temp-repo.js";

describe("IntegrationManager Git transaction boundaries", () => {
  it("leaves a pre-existing merge conflict untouched even when it only affects .intentum", async () => {
    const fixture = await createTempRepository();
    try {
      await commitFile(fixture.repo, ".intentum/state.json", "{\"owner\":\"base\"}\n", "fixture: track state");
      const base = await head(fixture.repo);
      const request = await createResultBranch(fixture.repo, base, "intentum/F-001/W-001", "result.txt", "result\n");

      await runFile("git", ["checkout", "-b", "preexisting-operation", base], fixture.repo);
      await commitFile(fixture.repo, ".intentum/state.json", "{\"owner\":\"side\"}\n", "side: state");
      await runFile("git", ["checkout", "main"], fixture.repo);
      await commitFile(fixture.repo, ".intentum/state.json", "{\"owner\":\"main\"}\n", "main: state");
      await expect(runFile("git", ["merge", "preexisting-operation"], fixture.repo)).rejects.toThrow();
      const originalMergeHead = (await runFile("git", ["rev-parse", "MERGE_HEAD"], fixture.repo)).stdout;

      await expect(new IntegrationManager(fixture.repo).integrate(request)).rejects.toThrow("in-progress Git operation");
      expect((await runFile("git", ["rev-parse", "MERGE_HEAD"], fixture.repo)).stdout).toBe(originalMergeHead);
      expect((await runFile("git", ["status", "--porcelain=v1"], fixture.repo)).stdout).toContain("UU .intentum/state.json");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a target branch rewritten behind the recorded Worker base", async () => {
    const fixture = await createTempRepository();
    try {
      const original = await head(fixture.repo);
      await commitFile(fixture.repo, "foundation.txt", "approved base\n", "main: approved foundation");
      const recordedBase = await head(fixture.repo);
      const request = await createResultBranch(
        fixture.repo,
        recordedBase,
        "intentum/F-001/W-001",
        "result.txt",
        "result\n",
      );
      await runFile("git", ["reset", "--hard", original], fixture.repo);

      await expect(new IntegrationManager(fixture.repo).integrate(request)).rejects.toThrow(
        "no longer descends from the recorded Worker base",
      );
      expect(await head(fixture.repo)).toBe(original);
      await expect(access(join(fixture.repo, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("reconciles an already-merged result after a hypothetical state-write crash", async () => {
    const fixture = await createTempRepository();
    try {
      const base = await head(fixture.repo);
      const request = await createResultBranch(fixture.repo, base, "intentum/F-001/W-001", "result.txt", "result\n");
      const manager = new IntegrationManager(fixture.repo);
      const first = await manager.integrate(request);
      const second = await manager.integrate(request);

      expect(second.commit).toBe(first.commit);
      expect(await isAncestor(request.resultCommit, second.commit, fixture.repo)).toBe(true);
      expect((await runFile("git", ["status", "--porcelain=v1"], fixture.repo)).stdout).toBe("");
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes non-conflicting integrations across manager instances", async () => {
    const fixture = await createTempRepository();
    try {
      const base = await head(fixture.repo);
      const first = await createResultBranch(fixture.repo, base, "intentum/F-001/W-001", "first.txt", "first\n");
      const second = await createResultBranch(fixture.repo, base, "intentum/F-002/W-002", "second.txt", "second\n");

      const outcomes = await Promise.all([
        new IntegrationManager(fixture.repo).integrate(first),
        new IntegrationManager(fixture.repo).integrate(second),
      ]);
      const finalHead = await head(fixture.repo);
      expect(outcomes).toHaveLength(2);
      expect(await isAncestor(first.resultCommit, finalHead, fixture.repo)).toBe(true);
      expect(await isAncestor(second.resultCommit, finalHead, fixture.repo)).toBe(true);
      expect((await runFile("git", ["status", "--porcelain=v1"], fixture.repo)).stdout).toBe("");
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createResultBranch(
  repo: string,
  base: string,
  workerBranch: string,
  file: string,
  content: string,
): Promise<IntegrationRequest> {
  await runFile("git", ["checkout", "-b", workerBranch, base], repo);
  await commitFile(repo, file, content, `worker: ${file}`);
  const resultCommit = await head(repo);
  await runFile("git", ["checkout", "main"], repo);
  return {
    workerId: workerBranch.split("/").at(-1) ?? "W-001",
    resultCommit,
    workerBranch,
    targetBranch: "main",
    expectedBaseCommit: base,
  };
}

async function commitFile(repo: string, file: string, content: string, message: string): Promise<void> {
  const path = join(repo, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  await runFile("git", ["add", "--", file], repo);
  await runFile("git", ["commit", "-m", message], repo);
}

async function head(repo: string): Promise<string> {
  return (await runFile("git", ["rev-parse", "HEAD"], repo)).stdout;
}

async function isAncestor(ancestor: string, descendant: string, repo: string): Promise<boolean> {
  try {
    await runFile("git", ["merge-base", "--is-ancestor", ancestor, descendant], repo);
    return true;
  } catch {
    return false;
  }
}
