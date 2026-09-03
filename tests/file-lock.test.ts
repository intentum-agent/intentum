import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { acquireFileLease, withFileLock } from "../src/utils/file-lock.js";

const execFileAsync = promisify(execFile);
// Node 26 strips types by default and rejects the older transform flag.
const TYPESCRIPT_NODE_FLAGS = process.allowedNodeEnvironmentFlags.has("--experimental-transform-types")
  ? ["--no-warnings", "--experimental-transform-types"]
  : ["--no-warnings"];

describe("cross-process file lock", () => {
  it("serializes mutations from independent Node processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentum-lock-"));
    const lockPath = join(root, "state.lock");
    const counterPath = join(root, "counter.txt");
    await writeFile(counterPath, "0\n", "utf8");
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "utils", "file-lock.ts")).href;
    const script = `
      import { readFile, writeFile } from "node:fs/promises";
      import { setTimeout as delay } from "node:timers/promises";
      import { withFileLock } from ${JSON.stringify(moduleUrl)};
      const [lockPath, counterPath] = process.argv.slice(1);
      await withFileLock(lockPath, async () => {
        const current = Number((await readFile(counterPath, "utf8")).trim());
        await delay(60);
        await writeFile(counterPath, String(current + 1) + "\\n", "utf8");
      });
    `;
    try {
      await Promise.all(Array.from({ length: 4 }, () => execFileAsync(
        process.execPath,
        [...TYPESCRIPT_NODE_FLAGS, "--input-type=module", "-e", script, lockPath, counterPath],
        { cwd: process.cwd(), timeout: 10_000 },
      )));
      expect(await readFile(counterPath, "utf8")).toBe("4\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets concurrent waiters reclaim one dead-owner lock without double acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentum-stale-race-"));
    const lockPath = join(root, "state.lock");
    const counterPath = join(root, "counter.txt");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-owner",
      acquiredAt: "2026-09-03T00:00:00.000Z",
    }), "utf8");
    await writeFile(counterPath, "0\n", "utf8");
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "utils", "file-lock.ts")).href;
    const script = `
      import { readFile, writeFile } from "node:fs/promises";
      import { setTimeout as delay } from "node:timers/promises";
      import { withFileLock } from ${JSON.stringify(moduleUrl)};
      const [lockPath, counterPath] = process.argv.slice(1);
      await withFileLock(lockPath, async () => {
        const current = Number((await readFile(counterPath, "utf8")).trim());
        await delay(40);
        await writeFile(counterPath, String(current + 1) + "\\n", "utf8");
      }, { timeoutMs: 10_000 });
    `;
    try {
      await Promise.all(Array.from({ length: 6 }, () => execFileAsync(
        process.execPath,
        [...TYPESCRIPT_NODE_FLAGS, "--input-type=module", "-e", script, lockPath, counterPath],
        { cwd: process.cwd(), timeout: 15_000 },
      )));
      expect(await readFile(counterPath, "utf8")).toBe("6\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a lease as lost once its lock directory disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentum-lost-lease-"));
    const lockPath = join(root, "controller.lease");
    try {
      const lease = await acquireFileLease(lockPath, { timeoutMs: 1_000 });
      await expect(lease.assertHeld()).resolves.toBeUndefined();
      await rm(lockPath, { recursive: true, force: true });
      await expect(lease.assertHeld()).rejects.toThrow("no longer held");
      await expect(lease.release()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an owner lock left by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentum-stale-lock-"));
    const lockPath = join(root, "state.lock");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-owner",
      acquiredAt: "2026-09-03T00:00:00.000Z",
    }), "utf8");
    try {
      const value = await withFileLock(lockPath, async () => "recovered", { timeoutMs: 1_000 });
      expect(value).toBe("recovered");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
