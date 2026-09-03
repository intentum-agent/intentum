import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { promisify } from "node:util";
import { runFile } from "../utils/process.js";

const execFileAsync = promisify(execFile);
const TRUSTED_BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"] as const;
const MAX_SANDBOX_STDOUT_BYTES = 10 * 1024 * 1024;
const SYSTEM_READ_ONLY_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc/alternatives",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/passwd",
  "/etc/group",
  "/etc/nsswitch.conf",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/localtime",
] as const;

/**
 * Build Worker tools that keep filesystem mutation inside the canonical
 * worktree. Bash receives a minimal bubblewrap filesystem, the worktree as its
 * only persistent writable bind, a minimal read-only system toolchain, no
 * shared Git common-dir, host home, or runtime sockets, a clean environment,
 * and private network/PID namespaces. If the host cannot enforce that
 * boundary, Worker creation fails before a Pi session is exposed as running.
 */
export async function createWorkerSandboxTools(
  worktreePath: string,
): Promise<ToolDefinition<any, any, any>[]> {
  const root = await realpath(worktreePath);
  await ensureControllerDirectory(root);
  const bwrap = await findTrustedBubblewrap();
  if (!bwrap) {
    throw new Error("Intentum Worker execution requires bubblewrap (bwrap) for a write-confined, network-isolated shell");
  }
  const runtimeRoot = await realpath(runtimeMountRoot(process.execPath));
  assertSafeDynamicMount(root, runtimeRoot);
  // Only the runtime's bin/ and lib/ are exposed. A prefix such as
  // N_PREFIX=$HOME/.local also holds share/ (pnpm store, container auth) that
  // the Worker must never read.
  const mountLayout = await existingMountLayout([
    ...SYSTEM_READ_ONLY_PATHS,
    ...RUNTIME_PREFIX_SUBDIRECTORIES.map((subdirectory) => join(runtimeRoot, subdirectory)),
  ]);
  const sandboxOptions: BubblewrapCommandOptions = {
    bwrap,
    command: ":",
    worktreePath: root,
    path: [`${runtimeRoot}/bin`, "/usr/bin", "/bin"].join(":"),
    readOnlyPaths: mountLayout.readOnlyPaths,
    symlinks: mountLayout.symlinks,
  };
  await assertBubblewrapUsable(buildBubblewrapCommand(sandboxOptions), root);
  const operationSignal = new AsyncLocalStorage<AbortSignal | undefined>();

  const runInSandbox = (command: string, input?: string | Uint8Array) => runSandboxedCommand(
    buildBubblewrapCommand({ ...sandboxOptions, command }),
    root,
    sanitizedHostEnvironment(process.env),
    input,
    operationSignal.getStore(),
  );
  const sandboxedWrite = async (path: string, content: string | Uint8Array): Promise<void> => {
    const safePath = await assertProspectiveMutablePath(root, path);
    await runInSandbox(`cat > ${shellQuote(safePath)}`, content);
    await assertExistingMutablePath(root, safePath);
  };

  const read = createReadToolDefinition(root, {
    operations: {
      readFile: async (path) => {
        const safePath = await assertExistingReadablePath(root, path);
        return runInSandbox(`cat -- ${shellQuote(safePath)}`);
      },
      access: async (path) => access(await assertExistingPath(root, path), constants.R_OK),
    },
  });
  const edit = createEditToolDefinition(root, {
    operations: {
      readFile: async (path) => {
        const safePath = await assertExistingMutablePath(root, path);
        return runInSandbox(`cat -- ${shellQuote(safePath)}`);
      },
      writeFile: async (path, content) => sandboxedWrite(await assertExistingMutablePath(root, path), content),
      access: async (path) => access(await assertExistingMutablePath(root, path), constants.R_OK | constants.W_OK),
    },
  });
  const write = createWriteToolDefinition(root, {
    operations: {
      mkdir: async (path) => {
        const safePath = await assertProspectiveMutablePath(root, path);
        await runInSandbox(`mkdir -p -- ${shellQuote(safePath)}`);
        await assertExistingMutablePath(root, safePath);
      },
      writeFile: sandboxedWrite,
    },
  });
  const bash = createBashToolDefinition(root, {
    exposeSessionEnvironment: false,
    spawnHook: ({ command, env }) => ({
      command: buildBubblewrapCommand({
        ...sandboxOptions,
        command,
        path: sandboxOptions.path,
      }),
      cwd: root,
      env: sanitizedHostEnvironment(env),
    }),
  });
  return [
    bindToolAbortSignal(read, operationSignal),
    bash,
    bindToolAbortSignal(edit, operationSignal),
    bindToolAbortSignal(write, operationSignal),
    createWorkerGitSnapshotTool(root),
  ];
}

/**
 * A narrow host-side Git view replaces mounting the shared Git common-dir
 * (whose config/remotes may contain credentials) into the model's shell.
 */
export function createWorkerGitSnapshotTool(worktreePath: string): ToolDefinition<any, any, any> {
  const root = resolve(worktreePath);
  return defineTool({
    name: "intentum_git_snapshot",
    label: "intentum git snapshot",
    description: "Read a controller-bounded branch/HEAD/status/diff/log snapshot without exposing shared Git config.",
    promptSnippet: "Use intentum_git_snapshot instead of Git commands in the isolated bash shell.",
    executionMode: "sequential",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, signal) {
      signal?.throwIfAborted();
      const git = (args: readonly string[]) => runFile(
        "git",
        ["-c", "core.fsmonitor=false", ...args],
        root,
        { signal },
      ).then((result) => result.stdout);
      const [branch, head, status, diffStat, log] = await Promise.all([
        git(["branch", "--show-current"]),
        git(["rev-parse", "HEAD"]),
        git(["status", "--porcelain=v1", "--untracked-files=all"]),
        git(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--stat"]),
        git(["log", "-5", "--pretty=format:%h %s"]),
      ]);
      const details = { branch, head, status, diffStat, log };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
        terminate: false,
      };
    },
  });
}

export interface BubblewrapCommandOptions {
  bwrap: string;
  command: string;
  worktreePath: string;
  path: string;
  readOnlyPaths?: readonly string[];
  symlinks?: readonly SandboxSymlink[];
}

export interface SandboxSymlink {
  destination: string;
  target: string;
}

export function buildBubblewrapCommand(options: BubblewrapCommandOptions): string {
  if (!isAbsolute(options.worktreePath)) throw new Error("Worker sandbox worktree path must be absolute");
  const worktree = resolve(options.worktreePath);
  const readOnlyPaths = deduplicateMounts(options.readOnlyPaths ?? []);
  if (readOnlyPaths.includes("/")) {
    throw new Error("Worker sandbox refuses to mount the host filesystem root");
  }
  const symlinks = deduplicateSymlinks(options.symlinks ?? []);
  const args = [
    options.bwrap,
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--tmpfs", "/tmp",
    "--dir", "/tmp/intentum-home",
    "--dev", "/dev",
    "--proc", "/proc",
  ];
  const protectedPaths = [join(worktree, ".git"), join(worktree, ".intentum")];
  const destinations = [
    ...readOnlyPaths,
    ...symlinks.map((item) => item.destination),
    worktree,
    ...protectedPaths,
  ];
  for (const directory of requiredDestinationDirectories(destinations)) args.push("--dir", directory);
  // Preserve usrmerge aliases such as /bin -> usr/bin. Canonicalizing mount
  // sources without recreating these destinations leaves /bin/sh absent in
  // the otherwise empty bubblewrap root.
  for (const item of symlinks) args.push("--symlink", item.target, item.destination);
  for (const path of readOnlyPaths) args.push("--ro-bind", path, path);
  args.push(
    "--bind", worktree, worktree,
    ...protectedPaths.flatMap((path) => ["--ro-bind", path, path]),
    "--chdir", worktree,
    "--clearenv",
    "--setenv", "PATH", options.path,
    "--setenv", "HOME", "/tmp/intentum-home",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "LC_ALL", "C.UTF-8",
    "--setenv", "GIT_OPTIONAL_LOCKS", "0",
    "--", "/bin/sh", "-lc", options.command,
  );
  return args.map(shellQuote).join(" ");
}

async function assertBubblewrapUsable(command: string, cwd: string): Promise<void> {
  try {
    await execFileAsync("/bin/sh", ["-lc", command], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      env: sanitizedHostEnvironment(process.env),
    });
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    const detail = failure.stderr?.trim() || failure.message;
    throw new Error(`Intentum Worker sandbox preflight failed; no Worker session was started: ${detail}`, { cause: error });
  }
}

export async function runSandboxedCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string | Uint8Array,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    signal?.throwIfAborted();
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stderr = "";
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stdinError: Error | undefined;
    let settled = false;
    let aborted = false;
    const killProcessGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const onAbort = () => {
      aborted = true;
      killProcessGroup();
    };
    const timer = setTimeout(killProcessGroup, 30_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolvePromise(Buffer.concat(stdout));
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_SANDBOX_STDOUT_BYTES) {
        stdinError ??= new Error(`sandboxed filesystem output exceeded ${MAX_SANDBOX_STDOUT_BYTES} bytes`);
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.once("error", (error) => {
      cleanup();
      rejectOnce(error);
    });
    child.once("close", (code, closeSignal) => {
      cleanup();
      if (aborted) {
        rejectOnce(new Error("sandboxed filesystem operation was aborted"));
      } else if (code === 0 && !stdinError) resolveOnce();
      else rejectOnce(new Error(
        `sandboxed filesystem operation failed (${closeSignal ?? `exit ${code ?? "unknown"}`}): ${stderr.trim() || stdinError?.message || "unknown error"}`,
        stdinError ? { cause: stdinError } : undefined,
      ));
    });
    // A sandboxed sink can exit before a large write finishes. Consuming EPIPE
    // here prevents an unhandled stream error from terminating the Pi host.
    child.stdin.on("error", (error) => {
      stdinError = error;
    });
    try {
      child.stdin.end(input);
    } catch (error) {
      stdinError = error as Error;
    }
  });
}

function bindToolAbortSignal(
  tool: ToolDefinition<any, any, any>,
  storage: AsyncLocalStorage<AbortSignal | undefined>,
): ToolDefinition<any, any, any> {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return storage.run(signal, () => execute(toolCallId, params, signal, onUpdate, ctx));
    },
  };
}

async function assertExistingPath(root: string, path: string): Promise<string> {
  const candidate = await realpath(resolveToolPath(root, path));
  assertInside(root, candidate);
  return candidate;
}

async function assertExistingReadablePath(root: string, path: string): Promise<string> {
  const candidate = await assertProspectiveMutablePath(root, path);
  await access(candidate, constants.R_OK);
  return candidate;
}

async function assertExistingMutablePath(root: string, path: string): Promise<string> {
  const candidate = await assertProspectiveMutablePath(root, path);
  await access(candidate, constants.F_OK);
  assertNotControllerPath(root, candidate);
  return candidate;
}

async function assertProspectiveMutablePath(root: string, path: string): Promise<string> {
  const absolute = resolveToolPath(root, path);
  assertInside(root, absolute);
  assertNotControllerPath(root, absolute);

  const rel = relative(root, absolute);
  let cursor = root;
  for (const component of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Worker mutation path contains a symbolic link: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return absolute;
}

/** Exposed for boundary regression tests without constructing a shell. */
export async function assertWorkerMutablePath(root: string, path: string): Promise<string> {
  return assertProspectiveMutablePath(await realpath(root), path);
}

async function ensureControllerDirectory(root: string): Promise<void> {
  const path = join(root, ".intentum");
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Worker worktree .intentum path must be a real directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: false });
  }
}

function assertNotControllerPath(root: string, candidate: string): void {
  const first = relative(root, candidate).split(sep)[0];
  if (first === ".git" || first === ".intentum") {
    throw new Error(`Worker tools cannot mutate controller-owned ${first} paths`);
  }
}

function assertInside(root: string, candidate: string): void {
  if (!isInside(root, candidate)) throw new Error(`Worker tool path escapes the canonical worktree: ${candidate}`);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolveToolPath(root: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function runtimeMountRoot(execPath: string): string {
  const normalized = resolve(execPath);
  const nodeMarker = `${sep}bin${sep}node`;
  return normalized.endsWith(nodeMarker) ? dirname(dirname(normalized)) : dirname(normalized);
}

function requiredDestinationDirectories(paths: readonly string[]): string[] {
  const result = new Set<string>();
  for (const path of paths) {
    let cursor = dirname(resolve(path));
    while (cursor !== "/") {
      result.add(cursor);
      cursor = dirname(cursor);
    }
  }
  return [...result].sort((left, right) => left.split(sep).length - right.split(sep).length);
}

function deduplicateMounts(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths.map((path) => resolve(path)))].sort((left, right) => left.length - right.length);
  return sorted.filter((path, index) => !sorted.slice(0, index).some((parent) => isInside(parent, path)));
}

function deduplicateSymlinks(symlinks: readonly SandboxSymlink[]): SandboxSymlink[] {
  const byDestination = new Map<string, SandboxSymlink>();
  for (const item of symlinks) {
    const destination = resolve(item.destination);
    if (!byDestination.has(destination)) byDestination.set(destination, { ...item, destination });
  }
  return [...byDestination.values()];
}

async function findTrustedBubblewrap(): Promise<string | undefined> {
  for (const candidate of TRUSTED_BWRAP_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      const canonical = await realpath(candidate);
      if (canonical === "/usr/bin/bwrap" || canonical === "/bin/bwrap") return canonical;
    } catch {
      // Continue through fixed system locations only.
    }
  }
  return undefined;
}

const RUNTIME_PREFIX_SUBDIRECTORIES = ["bin", "lib"] as const;

/**
 * Version managers install Node at least three levels below $HOME
 * (~/.nvm/versions/node/vX, ~/.asdf/installs/nodejs/X, ~/.volta/tools/image/node/X).
 * A shallower prefix (~/.local, ~/node) is a general-purpose user directory.
 */
const MIN_HOME_RUNTIME_DEPTH = 3;

export function assertSafeDynamicMount(worktree: string, mount: string): void {
  const candidate = resolve(mount);
  const home = resolve(homedir());
  if (candidate === "/" || candidate === home) {
    throw new Error(`Worker sandbox refuses broad dynamic runtime mount: ${candidate}`);
  }
  if (isInside(home, candidate)) {
    const depth = relative(home, candidate).split(sep).filter(Boolean).length;
    if (depth < MIN_HOME_RUNTIME_DEPTH) {
      throw new Error(`Worker sandbox refuses a runtime mount this close to the host home: ${candidate}`);
    }
  }
  const sensitive = [
    worktree,
    join(homedir(), ".ssh"),
    join(homedir(), ".aws"),
    join(homedir(), ".config", "gh"),
    join(homedir(), ".docker"),
    join(homedir(), ".kube"),
    join(homedir(), ".pi"),
    join(homedir(), ".codex"),
  ];
  if (sensitive.some((path) => isInside(candidate, path) || isInside(path, candidate))) {
    throw new Error(`Worker sandbox runtime mount overlaps a protected host path: ${candidate}`);
  }
}

async function existingMountLayout(paths: readonly string[]): Promise<{
  readOnlyPaths: string[];
  symlinks: SandboxSymlink[];
}> {
  const readOnlyPaths: string[] = [];
  const symlinks: SandboxSymlink[] = [];
  for (const path of paths) {
    try {
      const destination = resolve(path);
      const metadata = await lstat(destination);
      if (metadata.isSymbolicLink()) {
        symlinks.push({ destination, target: await readlink(destination) });
      } else {
        readOnlyPaths.push(destination);
      }
    } catch {
      // Absent runtime paths need no bind.
    }
  }
  return { readOnlyPaths: deduplicateMounts(readOnlyPaths), symlinks: deduplicateSymlinks(symlinks) };
}

function sanitizedHostEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const name of ["LANG", "LC_ALL", "TERM"] as const) {
    if (env[name]) result[name] = env[name];
  }
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
