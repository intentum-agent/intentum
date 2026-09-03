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
