import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { assertSafeId } from "../utils/ids.js";
import { CONTROLLER_OWNED_REPOSITORY_PATHS, isControllerOwnedRepositoryPath } from "../utils/safe-path.js";
import { runFile } from "../utils/process.js";

export interface WorktreeRecord {
  path: string;
  branch: string;
  targetBranch: string;
  baseCommit: string;
}

export class WorktreeManager {
  readonly cacheRoot: string;

  constructor(
    readonly projectRoot: string,
    cacheRoot = process.env.XDG_CACHE_HOME
      ? join(process.env.XDG_CACHE_HOME, "intentum")
      : join(homedir(), ".cache", "intentum"),
  ) {
    this.cacheRoot = resolve(cacheRoot);
    const rel = relative(resolve(projectRoot), this.cacheRoot);
    if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
      throw new Error("intentum cache root must be outside the target repository");
    }
  }

  async create(
    projectId: string,
    featureId: string,
    workerId: string,
    onPlanned?: (record: WorktreeRecord) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<WorktreeRecord> {
    signal?.throwIfAborted();
    assertSafeId(projectId, "project id");
    assertSafeId(featureId, "feature id");
    assertSafeId(workerId, "worker id");
    const projectPath = await this.assertRepository();
    // The new worktree starts from committed HEAD with its own index. Local
    // staged, unstaged, and untracked changes stay in the target worktree;
    // only integration needs that worktree to be clean.
    const baseCommit = (await runFile("git", ["rev-parse", "HEAD"], this.projectRoot)).stdout;
    const targetBranch = (await runFile("git", ["branch", "--show-current"], this.projectRoot)).stdout;
    if (!targetBranch) throw new Error("intentum requires the target repository to be on a named branch");

    const branch = `intentum/${featureId}/${workerId}`;
    await mkdir(this.cacheRoot, { recursive: true });
    const canonicalCache = await realpath(this.cacheRoot);
    if (isInside(projectPath, canonicalCache)) {
      throw new Error("intentum cache root resolves inside the target repository");
    }
    const parentCandidate = join(this.cacheRoot, projectId, "worktrees");
    await mkdir(parentCandidate, { recursive: true });
    const canonicalParent = await realpath(parentCandidate);
    assertInside(canonicalCache, canonicalParent, "worktree parent");
    if (isInside(projectPath, canonicalParent)) {
      throw new Error("intentum worktree parent resolves inside the target repository");
    }
    const path = join(canonicalParent, workerId);
    const record = { path, branch, targetBranch, baseCommit };
    // Persist deterministic provisioning metadata before the external Git
    // side effect. A crash after `git worktree add` can then be recovered by
    // identity instead of leaving an unreferenced registered worktree.
    await onPlanned?.(record);
    signal?.throwIfAborted();
    const branchExisted = Boolean((await runFile(
      "git",
      ["branch", "--list", branch],
      this.projectRoot,
      { signal },
    )).stdout.trim());
    try {
      await runFile(
        "git",
        ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", branch, path, baseCommit],
        this.projectRoot,
        { signal },
      );
      signal?.throwIfAborted();
    } catch (error) {
      // Git creates the branch before it checks the worktree out, so any
      // failure here — abort, timeout, missing content filter, full disk —
      // can leave both a registered worktree and an `intentum/*` branch
      // behind. Clean up on every failure path, not only on abort.
      // The cleanup context is deliberately independent: the lifecycle signal
      // may already be aborted, which would skip these bounded commands.
      // These are exclusively planned Intentum resources.
      await runFile("git", ["worktree", "remove", "--force", path], this.projectRoot).catch(() => undefined);
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      await this.removeWorktreeAdminEntry(path).catch(() => undefined);
      if (!branchExisted) {
        await runFile("git", ["branch", "-D", branch], this.projectRoot).catch(() => undefined);
      }
      const [remainingWorktrees, remainingBranch] = await Promise.all([
        runFile("git", ["worktree", "list", "--porcelain"], this.projectRoot)
          .then((result) => parseWorktreeList(result.stdout), () => [] as ParsedWorktreeRecord[]),
        runFile("git", ["branch", "--list", branch], this.projectRoot)
          .then((result) => result.stdout.trim(), () => ""),
      ]);
      if (remainingWorktrees.some((item) => resolve(item.path) === resolve(path))
        || (!branchExisted && remainingBranch)) {
        throw new Error(
          `Worker provisioning could not be fully cleaned up for ${workerId}; inspect ${path} and ${branch} before recovery`,
          { cause: error },
        );
      }
      throw error;
    }
    return record;
  }

  async head(worktreePath: string): Promise<string> {
    const managedPath = await this.assertManagedPath(worktreePath);
    return this.headAt(managedPath);
  }

  async assertCompletedWorktree(
    worktreePath: string,
    baseCommit: string,
    expectedBranch: string,
    signal?: AbortSignal,
  ): Promise<{ head: string; files: string[] }> {
    const managedPath = await this.assertManagedPath(worktreePath);
    const status = (await runFile(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      managedPath,
      { signal },
    )).stdout;
    if (status) throw new Error(`worker worktree has uncommitted changes:\n${status}`);
    const branch = (await runFile("git", ["branch", "--show-current"], managedPath, { signal })).stdout;
    if (branch !== expectedBranch) {
      throw new Error(`worker worktree moved from ${expectedBranch} to ${branch || "detached HEAD"}`);
    }
    const head = await this.headAt(managedPath, signal);
    if (head === baseCommit) throw new Error("worker completed without creating a result commit");
    await runFile("git", ["merge-base", "--is-ancestor", baseCommit, head], managedPath, { signal });
    // -z keeps non-ASCII names literal; the default core.quotePath C-quoting
    // would let ".intentum/<non-ascii>" slip past the prefix check below.
    // --no-renames keeps the source path of a rename visible: with rename
    // detection on, `git mv .intentum/state.json notes.md` would report only
    // the destination and slip past the controller-owned check.
    const files = (await runFile(
      "git",
      ["diff", "-z", "--no-renames", "--name-only", `${baseCommit}..${head}`],
      managedPath,
      { signal },
    )).stdout
      .split("\0")
      .filter(Boolean);
    if (files.length === 0) throw new Error("worker result commit does not change any files");
    if (files.some(isControllerOwnedRepositoryPath)) {
      throw new Error(`worker result modifies controller-owned state (${CONTROLLER_OWNED_REPOSITORY_PATHS.join(", ")})`);
    }
    return { head, files };
  }

  async assertRecoverableWorktree(
    projectId: string,
    workerId: string,
    path: string,
    expectedBranch: string,
    baseCommit: string,
    signal?: AbortSignal,
  ): Promise<string> {
    assertSafeId(projectId, "project id");
    assertSafeId(workerId, "Worker id");
    const managedPath = await this.assertManagedPath(path);
    const expectedPath = await realpath(join(this.cacheRoot, projectId, "worktrees", workerId)).catch(() => undefined);
    if (!expectedPath || managedPath !== expectedPath) {
      throw new Error(`Worker ${workerId} worktree path does not match its canonical project/Worker location`);
    }

    const records = parseWorktreeList((await runFile(
      "git",
      ["worktree", "list", "--porcelain"],
      this.projectRoot,
      { signal },
    )).stdout);
    const registered = records.find((record) => resolve(record.path) === managedPath);
    if (!registered) throw new Error(`Worker ${workerId} path is not a registered worktree of the target repository`);
    if (registered.branch !== `refs/heads/${expectedBranch}`) {
      throw new Error(`Worker ${workerId} registered worktree is on ${registered.branch ?? "detached HEAD"}, expected ${expectedBranch}`);
    }

    const [workerCommonDirRaw, projectCommonDirRaw, branch, head] = await Promise.all([
      runFile("git", ["rev-parse", "--git-common-dir"], managedPath, { signal }).then((result) => result.stdout),
      runFile("git", ["rev-parse", "--git-common-dir"], this.projectRoot, { signal }).then((result) => result.stdout),
      runFile("git", ["branch", "--show-current"], managedPath, { signal }).then((result) => result.stdout),
      this.headAt(managedPath, signal),
    ]);
    const [workerCommonDir, projectCommonDir] = await Promise.all([
      realpath(resolve(managedPath, workerCommonDirRaw)),
      realpath(resolve(this.projectRoot, projectCommonDirRaw)),
    ]);
    if (workerCommonDir !== projectCommonDir) {
      throw new Error(`Worker ${workerId} worktree belongs to a different Git repository`);
    }
    if (branch !== expectedBranch) {
      throw new Error(`Worker ${workerId} worktree moved from ${expectedBranch} to ${branch || "detached HEAD"}`);
    }
    if (registered.head && registered.head !== head) {
      throw new Error(`Worker ${workerId} registered HEAD does not match its worktree HEAD`);
    }
    await runFile("git", ["merge-base", "--is-ancestor", baseCommit, head], managedPath, { signal });
    return managedPath;
  }

  async commitChanges(
    projectId: string,
    workerId: string,
    path: string,
    expectedBranch: string,
    baseCommit: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<{ commit: string; files: string[] }> {
    signal?.throwIfAborted();
    if (!message.trim() || message.length > 200) {
      throw new Error("Worker commit message must contain 1 to 200 characters");
    }
    const managedPath = await this.assertRecoverableWorktree(
      projectId,
      workerId,
      path,
      expectedBranch,
      baseCommit,
      signal,
    );
    const controllerChanges = (await runFile(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "--", ...CONTROLLER_OWNED_REPOSITORY_PATHS],
      managedPath,
      { signal },
    )).stdout;
    if (controllerChanges) {
      throw new Error(`Worker changes include controller-owned paths (${CONTROLLER_OWNED_REPOSITORY_PATHS.join(", ")})`);
    }
    const status = (await runFile(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      managedPath,
      { signal },
    )).stdout;
    if (!status) throw new Error("Worker worktree has no changes to commit");

    await runFile("git", ["add", "-A", "--", "."], managedPath, { signal });
    const files = (await runFile(
      "git",
      ["diff", "-z", "--no-renames", "--cached", "--name-only"],
      managedPath,
      { signal },
    )).stdout
      .split("\0")
      .filter(Boolean);
    if (files.length === 0) throw new Error("Worker worktree has no staged changes to commit");
    if (files.some(isControllerOwnedRepositoryPath)) {
      throw new Error(`Worker commit would modify controller-owned state (${CONTROLLER_OWNED_REPOSITORY_PATHS.join(", ")})`);
    }
    await runFile(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", message.trim()],
      managedPath,
      { signal },
    );
    const commit = await this.headAt(managedPath, signal);
    await this.assertRecoverableWorktree(projectId, workerId, managedPath, expectedBranch, baseCommit, signal);
    return { commit, files };
  }

  /**
   * Remove only the `.git/worktrees/<name>` admin entry that points at `path`.
   * `git worktree prune` would also unregister unrelated user worktrees whose
   * directories are merely unreachable — an unmounted volume, a moved folder —
   * and that admin data holds their index and HEAD.
   */
  private async removeWorktreeAdminEntry(path: string): Promise<void> {
    const target = resolve(path);
    const commonDir = (await runFile("git", ["rev-parse", "--git-common-dir"], this.projectRoot)).stdout;
    const adminRoot = resolve(this.projectRoot, commonDir, "worktrees");
    for (const entry of await readdir(adminRoot).catch(() => [] as string[])) {
      const recorded = await readFile(join(adminRoot, entry, "gitdir"), "utf8").catch(() => undefined);
      if (!recorded) continue;
      // `gitdir` records `<worktree>/.git`.
      if (resolve(dirname(recorded.trim())) !== target) continue;
      await rm(join(adminRoot, entry), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async assertManagedPath(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error("intentum worktree path must be absolute");
    const [canonicalCache, canonicalPath, canonicalProject] = await Promise.all([
      realpath(this.cacheRoot),
      realpath(path),
      realpath(this.projectRoot),
    ]);
    assertInside(canonicalCache, canonicalPath, "worktree path");
    if (isInside(canonicalProject, canonicalPath)) {
      throw new Error(`worktree path resolves inside the target repository: ${path}`);
    }
    return canonicalPath;
  }

  private async assertRepository(): Promise<string> {
    const top = (await runFile("git", ["rev-parse", "--show-toplevel"], this.projectRoot)).stdout;
    const [actual, expected] = await Promise.all([realpath(top), realpath(this.projectRoot)]);
    if (actual !== expected) {
      throw new Error(`intentum must run at the repository root: ${actual}`);
    }
    return actual;
  }

  private async headAt(worktreePath: string, signal?: AbortSignal): Promise<string> {
    return (await runFile("git", ["rev-parse", "HEAD"], worktreePath, { signal })).stdout;
  }
}

interface ParsedWorktreeRecord {
  path: string;
  head?: string;
  branch?: string;
}

function parseWorktreeList(value: string): ParsedWorktreeRecord[] {
  return value
    .split(/\n\n+/)
    .map((block) => {
      const fields = new Map(
        block.split("\n").filter(Boolean).map((line) => {
          const separator = line.indexOf(" ");
          return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
        }),
      );
      const head = fields.get("HEAD");
      const branch = fields.get("branch");
      return {
        path: fields.get("worktree") ?? "",
        ...(head ? { head } : {}),
        ...(branch ? { branch } : {}),
      };
    })
    .filter((record) => Boolean(record.path));
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertInside(parent: string, candidate: string, label: string): void {
  if (!isInside(parent, candidate) || parent === candidate) {
    throw new Error(`${label} is outside the canonical intentum cache root: ${candidate}`);
  }
}
