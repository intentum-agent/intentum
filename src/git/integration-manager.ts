import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runFile } from "../utils/process.js";
import { withFileLock } from "../utils/file-lock.js";
import { assertRepositoryOwnedPath, ensureRepositoryOwnedDirectory } from "../utils/safe-path.js";
import { unrelatedGitStatus } from "./status.js";

const integrationTails = new Map<string, Promise<void>>();
const GIT_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
] as const;

export interface IntegrationRequest {
  workerId: string;
  resultCommit: string;
  workerBranch: string;
  targetBranch: string;
  expectedBaseCommit: string;
}

export interface IntegrationResult {
  commit: string;
}

export class IntegrationConflictError extends Error {
  override readonly name = "IntegrationConflictError";
}

export class IntegrationManager {
  constructor(private readonly projectRoot: string) {}

  async integrate(request: IntegrationRequest, signal?: AbortSignal): Promise<IntegrationResult> {
    signal?.throwIfAborted();
    const key = resolve(this.projectRoot);
    await ensureRepositoryOwnedDirectory(this.projectRoot, join(this.projectRoot, ".intentum"));
    const lockPath = await assertRepositoryOwnedPath(
      this.projectRoot,
      join(this.projectRoot, ".intentum", "integration.lock"),
    );
    const previous = integrationTails.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => withFileLock(
      lockPath,
      () => this.integrateUnlocked(request, signal),
      signal ? { signal } : {},
    ));
    const tail = operation.then(() => undefined, () => undefined);
    integrationTails.set(key, tail);
    void tail.then(() => {
      if (integrationTails.get(key) === tail) integrationTails.delete(key);
    });
    return operation;
  }

  private async integrateUnlocked(request: IntegrationRequest, signal?: AbortSignal): Promise<IntegrationResult> {
    signal?.throwIfAborted();
    const git = (args: readonly string[]) => runFile("git", args, this.projectRoot, { signal });
    const branch = (await git(["branch", "--show-current"])).stdout;
    if (branch !== request.targetBranch) {
      throw new Error(`integration target moved from ${request.targetBranch} to ${branch || "detached HEAD"}`);
    }

    await this.assertNoGitOperationInProgress(signal);
    await this.assertTargetClean(signal);
    await git(["cat-file", "-e", `${request.resultCommit}^{commit}`]);
    await git(["merge-base", "--is-ancestor", request.expectedBaseCommit, request.resultCommit]);
    const targetHead = (await git(["rev-parse", "HEAD"])).stdout;
    await git(["merge-base", "--is-ancestor", request.expectedBaseCommit, targetHead])
      .catch((error) => {
        throw new Error(
          `integration target ${request.targetBranch} no longer descends from the recorded Worker base; history may have been rewritten`,
          { cause: error },
        );
      });
    const changedFiles = (await git(
      ["diff", "--name-only", `${request.expectedBaseCommit}..${request.resultCommit}`],
    )).stdout.split("\n").filter(Boolean);
    if (changedFiles.some((file) => file === ".intentum" || file.startsWith(".intentum/"))) {
      throw new Error("integration result modifies controller-owned .intentum state");
    }
    const branchHead = (await git(["rev-parse", `refs/heads/${request.workerBranch}`])).stdout;
    if (branchHead !== request.resultCommit) {
      throw new Error(`worker branch ${request.workerBranch} moved after completion; integration stopped`);
    }
    // A merge may have committed successfully immediately before the
    // controller process crashed while persisting Worker status. Treat exact
    // ancestry as idempotent reconciliation after all identity/safety checks.
    if (await isAncestor(request.resultCommit, targetHead, this.projectRoot, signal)) {
      return { commit: targetHead };
    }

    try {
      await git(
        [
          "-c", "core.hooksPath=/dev/null",
          "-c", "commit.gpgSign=false",
          "merge", "--no-ff", request.resultCommit, "-m", `intentum: integrate ${request.workerId}`,
        ],
      );
    } catch (error) {
      // A lifecycle AbortSignal may have killed `git merge` after it created
      // MERGE_HEAD. Cleanup must use an independent bounded process context;
      // reusing the already-aborted signal would skip `merge --abort` and
      // leave the user's target worktree half-merged.
      const cleanupGit = (args: readonly string[]) => runFile("git", args, this.projectRoot);
      const unmerged = await cleanupGit(
        ["diff", "--name-only", "--diff-filter=U"],
      ).then((result) => result.stdout, () => "");
      const mergeInProgress = await this.gitOperationMarkerExists("MERGE_HEAD");
      if (mergeInProgress) {
        try {
          await cleanupGit(["-c", "core.hooksPath=/dev/null", "merge", "--abort"]);
          if (await this.gitOperationMarkerExists("MERGE_HEAD")) {
            throw new Error("MERGE_HEAD still exists after git merge --abort");
          }
          const [restoredHead, restoredBranch] = await Promise.all([
            cleanupGit(["rev-parse", "HEAD"]).then((result) => result.stdout),
            cleanupGit(["branch", "--show-current"]).then((result) => result.stdout),
          ]);
          if (restoredHead !== targetHead || restoredBranch !== request.targetBranch) {
            throw new Error("git merge --abort did not restore the original target branch and HEAD");
          }
        } catch (abortError) {
          throw new IntegrationConflictError(
            `integration failed for ${request.workerId}, and automatic merge abort did not restore the target; manual Git recovery is required`,
            { cause: abortError },
          );
        }
      }
      signal?.throwIfAborted();
      if (unmerged) {
        throw new IntegrationConflictError(
          mergeInProgress
            ? `integration failed for ${request.workerId}; its merge was aborted and the worker branch was preserved`
            : `integration failed for ${request.workerId} before an Intentum merge state was created; the worker branch was preserved`,
          { cause: error },
        );
      }
      throw new Error(
        mergeInProgress
          ? `integration command failed for ${request.workerId}; its merge state was aborted and the completed result remains retryable`
          : `integration command failed for ${request.workerId} before an Intentum merge state was created; the completed result remains retryable`,
        { cause: error },
      );
    }

    const commit = (await git(["rev-parse", "HEAD"])).stdout;
    const [currentBranch, parentLine] = await Promise.all([
      git(["branch", "--show-current"]).then((result) => result.stdout),
      git(["rev-list", "--parents", "-n", "1", commit]).then((result) => result.stdout),
    ]);
    const [, firstParent, ...otherParents] = parentLine.split(/\s+/);
    if (currentBranch !== request.targetBranch || firstParent !== targetHead || !otherParents.includes(request.resultCommit)) {
      throw new Error(`integration verification failed for ${request.workerId}; target merge ancestry did not match the approved heads`);
    }
    await this.assertNoGitOperationInProgress(signal);
    await this.assertTargetClean(signal);
    return { commit };
  }

  private async assertTargetClean(signal?: AbortSignal): Promise<void> {
    const status = await unrelatedGitStatus(this.projectRoot, signal);
    if (status) {
      throw new Error(`target worktree has unrelated changes; integration stopped:\n${status}`);
    }
  }

  private async assertNoGitOperationInProgress(signal?: AbortSignal): Promise<void> {
    const present: string[] = [];
    for (const marker of GIT_OPERATION_MARKERS) {
      if (await this.gitOperationMarkerExists(marker, signal)) present.push(marker);
    }
    if (present.length > 0) {
      throw new Error(`target repository already has an in-progress Git operation (${present.join(", ")}); integration stopped without changing it`);
    }
  }

  private async gitOperationMarkerExists(marker: string, signal?: AbortSignal): Promise<boolean> {
    const path = (await runFile("git", ["rev-parse", "--git-path", marker], this.projectRoot, { signal })).stdout;
    try {
      await access(resolve(this.projectRoot, path));
      return true;
    } catch {
      return false;
    }
  }
}

async function isAncestor(ancestor: string, descendant: string, cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runFile("git", ["merge-base", "--is-ancestor", ancestor, descendant], cwd, { signal });
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}
