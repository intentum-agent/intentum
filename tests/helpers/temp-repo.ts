import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFile } from "../../src/utils/process.js";

export interface TempRepository {
  root: string;
  repo: string;
  cache: string;
  cleanup(): Promise<void>;
}

export async function createTempRepository(): Promise<TempRepository> {
  const root = await mkdtemp(join(tmpdir(), "intentum-test-"));
  const repo = join(root, "repo");
  const cache = join(root, "cache");
  await Promise.all([mkdir(repo), mkdir(cache)]);
  await runFile("git", ["init", "-b", "main"], repo);
  await runFile("git", ["config", "user.name", "intentum tests"], repo);
  await runFile("git", ["config", "user.email", "intentum@example.invalid"], repo);
  await writeFile(join(repo, "README.md"), "# Fixture\n\nbase\n", "utf8");
  await runFile("git", ["add", "README.md"], repo);
  await runFile("git", ["commit", "-m", "fixture: initial"], repo);
  return {
    root,
    repo,
    cache,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
