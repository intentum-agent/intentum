import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import {
  assertSafeDynamicMount,
  assertWorkerMutablePath,
  buildBubblewrapCommand,
  createWorkerGitSnapshotTool,
  runSandboxedCommand,
} from "../src/runtime/worker-sandbox.js";
import { runFile } from "../src/utils/process.js";
import { createTempRepository } from "./helpers/temp-repo.js";

describe("Worker sandbox boundary", () => {
  it("builds a minimal isolated mount layout and preserves usrmerge aliases", () => {
    const command = buildBubblewrapCommand({
      bwrap: "/usr/bin/bwrap",
      command: "printf ok",
      worktreePath: "/fixture/worktree",
      path: "/usr/bin:/bin",
      readOnlyPaths: ["/usr", "/etc/ssl"],
      symlinks: [
        { destination: "/bin", target: "usr/bin" },
        { destination: "/lib64", target: "usr/lib64" },
      ],
    });

    expect(command).toContain("'--unshare-all'");
    expect(command).toContain("'--clearenv'");
    expect(command).toContain("'--bind' '/fixture/worktree' '/fixture/worktree'");
    expect(command).toContain("'--ro-bind' '/fixture/worktree/.git' '/fixture/worktree/.git'");
    expect(command).toContain("'--ro-bind' '/fixture/worktree/.intentum' '/fixture/worktree/.intentum'");
    expect(command).toContain("'--ro-bind' '/fixture/worktree/.pi' '/fixture/worktree/.pi'");
    expect(command).toContain("'--symlink' 'usr/bin' '/bin'");
    expect(command).toContain("'--' '/bin/sh' '-lc' 'printf ok'");
    expect(command).not.toContain("'--ro-bind' '/' '/'");
    expect(() => buildBubblewrapCommand({
      bwrap: "/usr/bin/bwrap",
      command: ":",
      worktreePath: "/fixture/worktree",
      path: "/usr/bin:/bin",
      readOnlyPaths: ["/"],
    })).toThrow("refuses to mount the host filesystem root");
  });

  it("refuses runtime mounts that would expose a shallow home subtree", () => {
    const home = homedir();
    expect(() => assertSafeDynamicMount("/work", home)).toThrow("broad dynamic runtime mount");
    expect(() => assertSafeDynamicMount("/work", join(home, ".local"))).toThrow("close to the host home");
    expect(() => assertSafeDynamicMount("/work", join(home, "node"))).toThrow("close to the host home");
    expect(() => assertSafeDynamicMount("/work", join(home, ".nvm", "versions", "node", "v22.19.0"))).not.toThrow();
    expect(() => assertSafeDynamicMount("/work", "/opt/homebrew/Cellar/node/26.7.0")).not.toThrow();
    expect(() => assertSafeDynamicMount("/work", join(home, ".ssh", "nested", "runtime", "v1"))).toThrow("protected host path");
  });

  it("rejects controller paths, lexical escapes, and dangling symlink writes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "intentum-sandbox-")));
    const worktree = join(root, "worktree");
    const outside = join(root, "outside");
    const outsideTarget = join(outside, "created.txt");
    await Promise.all([mkdir(worktree), mkdir(outside)]);

    try {
      expect(await assertWorkerMutablePath(worktree, "src/new.ts")).toBe(join(worktree, "src/new.ts"));
      await expect(assertWorkerMutablePath(worktree, "../outside/created.txt")).rejects.toThrow("escapes");
      await expect(assertWorkerMutablePath(worktree, ".intentum/state.json")).rejects.toThrow("controller-owned");
      // A committed .pi/extensions entry would run as host code in the next
      // project-trusted Pi session, so .pi is controller-owned too.
      await expect(assertWorkerMutablePath(worktree, ".pi/extensions/x.ts")).rejects.toThrow("controller-owned");
      await expect(assertWorkerMutablePath(worktree, ".pi/settings.json")).rejects.toThrow("controller-owned");

      // Model the exact cross-tool attack: isolated bash can create a dangling
      // absolute symlink, but the host-side write boundary rejects that path
      // before any file is opened. The actual write operation also runs inside
      // the mount namespace, providing a second OS-enforced boundary.
      await symlink(outsideTarget, join(worktree, "escape"));
      await expect(assertWorkerMutablePath(worktree, "escape")).rejects.toThrow("symbolic link");
      await expect(access(outsideTarget)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an early-closing write sink instead of emitting an unhandled EPIPE", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentum-sandbox-pipe-"));
    try {
      await expect(runSandboxedCommand(
        "exit 7",
        root,
        { PATH: process.env.PATH },
        Buffer.alloc(16 * 1024 * 1024, 0x61),
      )).rejects.toThrow("sandboxed filesystem operation failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("kills an in-flight sandboxed filesystem child when its tool signal aborts", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentum-sandbox-abort-"));
    const controller = new AbortController();
    try {
      const startedAt = Date.now();
      const operation = runSandboxedCommand(
        "sleep 30",
        root,
        { PATH: "/usr/bin:/bin" },
        undefined,
        controller.signal,
      );
      setTimeout(() => controller.abort(), 25);
      await expect(operation).rejects.toThrow("was aborted");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses trusted host Git even when the project prepends a malicious PATH shim", async () => {
    const fixture = await createTempRepository();
    const shimDir = join(fixture.repo, "node_modules", ".bin");
    const sentinel = join(fixture.root, "escaped-via-git-shim");
    const originalPath = process.env.PATH;
    try {
      await mkdir(shimDir, { recursive: true });
      const shim = join(shimDir, "git");
      await writeFile(shim, `#!/bin/sh\nprintf escaped > '${sentinel}'\nexec /usr/bin/git \"$@\"\n`, "utf8");
      await chmod(shim, 0o755);
      process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
      expect((await runFile("git", ["--version"], fixture.repo)).stdout).toMatch(/^git version /);
      await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.env.PATH = originalPath;
      await fixture.cleanup();
    }
  });

  it("exposes bounded Git facts without leaking a tokenized repository remote", async () => {
    const fixture = await createTempRepository();
    const token = "TOKEN_SHOULD_NOT_REACH_THE_WORKER";
    try {
      await runFile("git", ["remote", "add", "origin", `https://${token}@example.invalid/project.git`], fixture.repo);
      await writeFile(join(fixture.repo, "untracked.txt"), "visible status fact\n", "utf8");
      const tool = createWorkerGitSnapshotTool(fixture.repo);
      const result = await tool.execute(
        "snapshot-call",
        {},
        new AbortController().signal,
        () => undefined,
        {} as never,
      );
      const text = result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
      expect(text).toContain("untracked.txt");
      expect(text).not.toContain(token);
      expect(text).not.toContain("example.invalid");
    } finally {
      await fixture.cleanup();
    }
  });
});
