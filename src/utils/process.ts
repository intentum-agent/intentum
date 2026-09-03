import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, realpath } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface RunFileOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export async function runFile(
  command: string,
  args: readonly string[],
  cwd: string,
  options: RunFileOptions = {},
): Promise<ProcessResult> {
  try {
    const executable = command === "git" ? await trustedGitExecutable() : command;
    const result = await execFileAsync(executable, [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      signal: options.signal,
      timeout: options.timeoutMs ?? 60_000,
      env: options.env ?? {
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        PATH: "/usr/bin:/bin",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return { stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd() };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const detail = [failure.message, failure.stderr?.trim(), failure.stdout?.trim()].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`, { cause: error });
  }
}

let trustedGitPromise: Promise<string> | undefined;

function trustedGitExecutable(): Promise<string> {
  trustedGitPromise ??= (async () => {
    for (const candidate of ["/usr/bin/git", "/bin/git"] as const) {
      try {
        await access(candidate);
        const canonical = await realpath(candidate);
        if (canonical.startsWith("/usr/bin/") || canonical.startsWith("/bin/")) return canonical;
      } catch {
        // Try the next immutable system location.
      }
    }
    throw new Error("Intentum requires Git at a trusted system path (/usr/bin/git or /bin/git)");
  })();
  return trustedGitPromise;
}
