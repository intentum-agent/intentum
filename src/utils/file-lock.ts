import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface FileLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  incompleteOwnerGraceMs?: number;
  signal?: AbortSignal;
}

export interface FileLease {
  readonly path: string;
  release(): Promise<void>;
}

/**
 * Cross-process mutex implemented with an atomically-created directory.
 * Owner PID metadata lets a later process recover locks left by a crash.
 */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const lease = await acquireFileLease(lockPath, options);
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

export async function acquireFileLease(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<FileLease> {
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retryMs = options.retryMs ?? 20;
  const graceMs = options.incompleteOwnerGraceMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  options.signal?.throwIfAborted();
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    options.signal?.throwIfAborted();
    try {
      await mkdir(lockPath);
      try {
        await writeFile(`${lockPath}/owner.json`, `${JSON.stringify(owner)}\n`, "utf8");
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isStaleLock(lockPath, graceMs)) {
        const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
        try {
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        } catch (staleError) {
          if (!["ENOENT", "EEXIST"].includes((staleError as NodeJS.ErrnoException).code ?? "")) throw staleError;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for Intentum process lock: ${lockPath}`);
      }
      await delay(retryMs, undefined, { signal: options.signal });
    }
  }

  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      await releaseOwnedLock(lockPath, owner.token);
    },
  };
}

async function isStaleLock(lockPath: string, graceMs: number): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8")) as Partial<LockOwner>;
    if (!Number.isInteger(parsed.pid) || typeof parsed.token !== "string") return false;
    try {
      process.kill(parsed.pid!, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch (error) {
    try {
      const metadata = await stat(lockPath);
      return Date.now() - metadata.mtimeMs >= graceMs;
    } catch {
      return false;
    }
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8")) as Partial<LockOwner>;
    if (parsed.token !== token) return;
    const releasePath = `${lockPath}.release-${process.pid}-${randomUUID()}`;
    await rename(lockPath, releasePath);
    await rm(releasePath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
