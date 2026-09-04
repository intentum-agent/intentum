import { runFile } from "../utils/process.js";

// Runtime state and decision artifacts may be intentionally version-controlled,
// but their controller-authored updates must not be mistaken for unrelated user
// edits when creating or integrating a Worker worktree.
const NON_ORCHESTRATION_PATHSPEC = [
  ".",
  ":(exclude).intentum",
  ":(exclude).intentum/**",
] as const;

export async function unrelatedGitStatus(projectRoot: string, signal?: AbortSignal): Promise<string> {
  return (await runFile(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...NON_ORCHESTRATION_PATHSPEC],
    projectRoot,
    { signal },
  )).stdout;
}

export interface WorkingTreeCounts {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
}

/**
 * Footer counts from `git status --porcelain=v1`. A path both staged and
 * modified again counts once in each column, as `git status` itself reports.
 */
export function countWorkingTree(porcelain: string): WorkingTreeCounts {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of porcelain.split("\n")) {
    if (line.length < 2) continue;
    const index = line[0];
    const worktree = line[1];
    if (index === "?" && worktree === "?") {
      untracked++;
      continue;
    }
    if (index === "!" && worktree === "!") continue;
    if (index !== " ") staged++;
    if (worktree !== " ") unstaged++;
  }
  return { staged, unstaged, untracked };
}

/** Counts for the session footer; a non-repository or failing git yields undefined. */
export async function workingTreeCounts(root: string, signal?: AbortSignal): Promise<WorkingTreeCounts | undefined> {
  try {
    const porcelain = (await runFile(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      root,
      { signal, timeoutMs: 10_000 },
    )).stdout;
    return countWorkingTree(porcelain);
  } catch {
    return undefined;
  }
}
