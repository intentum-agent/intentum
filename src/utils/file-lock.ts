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
  /** Throw if the lock directory no longer records this lease as its owner. */
  assertHeld(): Promise<void>;
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
      const stale = await readStaleOwner(lockPath, graceMs);
      if (stale && await reclaimStaleLock(lockPath, stale, graceMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for Intentum process lock: ${lockPath}`);
      }
      await delay(retryMs, undefined, { signal: options.signal });
    }
  }

  let released = false;
  return {
    path: lockPath,
    async assertHeld() {
      if (released) throw new Error(`Intentum process lock was already released: ${lockPath}`);
      const current = await readOwner(lockPath);
      if (current?.token !== owner.token) {
        throw new Error(`Intentum process lock is no longer held by this process: ${lockPath}`);
      }
    },
    async release() {
      if (released) return;
      released = true;
      await releaseOwnedLock(lockPath, owner.token);
    },
  };
}

type StaleOwner = { kind: "dead"; token: string } | { kind: "incomplete" };

async function readOwner(lockPath: string): Promise<Partial<LockOwner> | undefined> {
  try {
    return JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8")) as Partial<LockOwner>;
  } catch {
    return undefined;
  }
}

/**
 * Report whether the current lock holder is recoverable: either its owner
 * process is gone, or the owner metadata never got written and the directory
 * has outlived the grace period.
 */
async function readStaleOwner(lockPath: string, graceMs: number): Promise<StaleOwner | undefined> {
  const parsed = await readOwner(lockPath);
  if (parsed) {
    if (!Number.isInteger(parsed.pid) || typeof parsed.token !== "string") return undefined;
    try {
      process.kill(parsed.pid!, 0);
      return undefined;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? { kind: "dead", token: parsed.token } : undefined;
    }
  }
  try {
    const metadata = await stat(lockPath);
    return Date.now() - metadata.mtimeMs >= graceMs ? { kind: "incomplete" } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove a stale lock directory. Reclamation is serialized through a sibling
 * `.reclaim` directory so two waiters that both observed the same dead owner
 * cannot each rename away a lock that the other has already re-acquired:
 * only the reclaim holder renames, and it re-reads the owner first.
 */
async function reclaimStaleLock(lockPath: string, observed: StaleOwner, graceMs: number): Promise<boolean> {
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    await mkdir(reclaimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A reclaimer that crashed mid-way leaves the guard behind; expire it.
    try {
      const metadata = await stat(reclaimPath);
      if (Date.now() - metadata.mtimeMs >= graceMs) await rm(reclaimPath, { recursive: true, force: true });
    } catch {
      // Another process finished reclaiming; retry from the acquire loop.
    }
    return false;
  }
  try {
    const current = await readStaleOwner(lockPath, graceMs);
    const unchanged = current !== undefined
      && current.kind === observed.kind
      && (current.kind !== "dead" || observed.kind !== "dead" || current.token === observed.token);
    if (!unchanged) return false;
    const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    await rm(stalePath, { recursive: true, force: true });
    return true;
  } finally {
    await rm(reclaimPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  try {
    const parsed = await readOwner(lockPath);
    if (parsed?.token !== token) return;
    const releasePath = `${lockPath}.release-${process.pid}-${randomUUID()}`;
    await rename(lockPath, releasePath);
    await rm(releasePath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
