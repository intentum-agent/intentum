import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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
  // macOS places tmpdir under a symlinked prefix (/var -> /private/var);
  // canonicalize so path assertions against realpath()ed values hold.
  const root = await realpath(await mkdtemp(join(tmpdir(), "intentum-test-")));
  const repo = join(root, "repo");
  const cache = join(root, "cache");
  await Promise.all([mkdir(repo), mkdir(cache)]);
  await runFile("git", ["init", "-b", "main"], repo);
  // Fixture git runs through runFile, which forwards HOME, so the developer's
  // own ~/.gitconfig applies. Commit signing or a global hooksPath would fail
  // every fixture commit and turn the whole suite red for an unrelated reason;
  // repository-local settings override the global ones.
  for (const [key, value] of [
    ["user.name", "intentum tests"],
    ["user.email", "intentum@example.invalid"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.hooksPath", "/dev/null"],
  ] as const) {
    await runFile("git", ["config", key, value], repo);
  }
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
