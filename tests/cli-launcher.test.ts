import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempRepository, type TempRepository } from "./helpers/temp-repo.js";

// @ts-expect-error the shipped .mjs executable has no separate declaration file
import { intentumRegisteredInPi, runCli } from "../bin/intentum.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

interface CaptureStream {
  columns?: number;
  isTTY?: boolean;
  output: string;
  write(chunk: string | Uint8Array): boolean;
}

function captureStream(): CaptureStream {
  return {
    isTTY: false,
    output: "",
    write(chunk) {
      this.output += String(chunk);
      return true;
    },
  };
}

interface RecordedLaunch {
  command: string;
  args: string[];
  cwd: string | undefined;
}

/**
 * Real git calls go through Node's spawn; the Pi launch itself is recorded and
 * completed immediately so no interactive process starts under the test runner.
 */
function recordingSpawn(launches: RecordedLaunch[], exitCode = 0) {
  return (command: string, args: string[], options: { cwd?: string }) => {
    if (command === "git") return nodeSpawn(command, args, options as never);
    launches.push({ command, args, cwd: options.cwd });
    const child = new EventEmitter() as EventEmitter & { kill(): void };
    child.kill = () => {};
    queueMicrotask(() => {
      child.emit("exit", exitCode, null);
      child.emit("close", exitCode, null);
    });
    return child;
  };
}

describe("intentum launcher", () => {
  let repo: TempRepository;
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    repo = await createTempRepository();
    home = await realpath(await mkdtemp(join(tmpdir(), "intentum-home-")));
    env = { PATH: process.env.PATH, HOME: home, NO_COLOR: "1", INTENTUM_PI: "/fake/pi" };
  });

  afterEach(async () => {
    await Promise.all([repo.cleanup(), rm(home, { recursive: true, force: true })]);
  });

  it("launches pi with the package loaded and passes extra options through", async () => {
    const launches: RecordedLaunch[] = [];
    const stderr = captureStream();
    const code = await runCli(["--model", "sonnet"], {
      stdout: captureStream(),
      stderr,
      env: { ...env, INTENTUM_SYMBOLS: "unicode" },
      cwd: repo.repo,
      spawn: recordingSpawn(launches),
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(launches).toEqual([{
      command: "/fake/pi",
      args: ["-e", projectRoot, "--tui-mode", "fullscreen", "--model", "sonnet"],
      cwd: repo.repo,
    }]);
    expect(stderr.output).toBe("");
  });

  it("nudges toward `intentum fonts install` only while no Nerd Font is reachable and no preset is chosen", async () => {
    const stderr = captureStream();
    await runCli([], { stdout: captureStream(), stderr, env, cwd: repo.repo, spawn: recordingSpawn([]), platform: "linux" });
    expect(stderr.output).toBe("⋗ intentum: no Nerd Font found, so the status line uses plain glyphs. `intentum fonts install` adds the icons; INTENTUM_SYMBOLS=unicode silences this.\n");

    const bundled = captureStream();
    await runCli([], { stdout: captureStream(), stderr: bundled, env: { ...env, TERM_PROGRAM: "WezTerm" }, cwd: repo.repo, spawn: recordingSpawn([]), platform: "linux" });
    expect(bundled.output).toBe("");
  });

  it("keeps an explicit --tui-mode instead of forcing fullscreen", async () => {
    const launches: RecordedLaunch[] = [];
    const code = await runCli(["--tui-mode", "regular"], {
      stdout: captureStream(),
      stderr: captureStream(),
      env,
      cwd: repo.repo,
      spawn: recordingSpawn(launches),
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(launches[0]?.args).toEqual(["-e", projectRoot, "--tui-mode", "regular"]);
  });

  it("normalises --tui-mode=<value>, which Pi's own parser does not accept", async () => {
    const launches: RecordedLaunch[] = [];
    const code = await runCli(["--tui-mode=regular"], {
      stdout: captureStream(),
      stderr: captureStream(),
      env,
      cwd: repo.repo,
      spawn: recordingSpawn(launches),
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(launches[0]?.args).toEqual(["-e", projectRoot, "--tui-mode", "regular"]);
  });

  it("stops the init project name at the first pi option instead of absorbing it", async () => {
    const launches: RecordedLaunch[] = [];
    const code = await runCli(["init", "My", "Product", "--model", "sonnet"], {
      stdout: captureStream(),
      stderr: captureStream(),
      env,
      cwd: repo.repo,
      spawn: recordingSpawn(launches),
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(launches[0]?.args).toEqual([
      "-e", projectRoot, "--tui-mode", "fullscreen", "--model", "sonnet", "--", "/intentum init My Product",
    ]);
  });

  it("reads Pi settings from PI_CODING_AGENT_DIR so the package is not loaded twice", async () => {
    const agentDir = join(home, "pi-config");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-intentum"] }), "utf8");
    const scoped = { ...env, PI_CODING_AGENT_DIR: agentDir };
    await expect(intentumRegisteredInPi({ cwd: repo.repo, env: scoped })).resolves.toBe("npm:pi-intentum");

    const launches: RecordedLaunch[] = [];
    const code = await runCli([], {
      stdout: captureStream(),
      stderr: captureStream(),
      env: scoped,
      cwd: repo.repo,
      spawn: recordingSpawn(launches),
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(launches[0]?.args).toEqual(["--tui-mode", "fullscreen"]);
  });

  it("turns `intentum init <name>` into the /intentum init command and forwards pi options after --", async () => {
    const launches: RecordedLaunch[] = [];
    const code = await runCli(["init", "My", "Product", "--", "--no-session"], {
      stdout: captureStream(),
      stderr: captureStream(),
      env,
      cwd: repo.repo,
      spawn: recordingSpawn(launches),
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(launches[0]?.args).toEqual(["-e", projectRoot, "--tui-mode", "fullscreen", "--no-session", "--", "/intentum init My Product"]);
  });

  it("returns pi's exit status", async () => {
    const code = await runCli([], {
      stdout: captureStream(),
      stderr: captureStream(),
      env,
      cwd: repo.repo,
      spawn: recordingSpawn([], 3),
      platform: "linux",
    });
    expect(code).toBe(3);
  });

  it("does not load the package twice when Pi settings already register it", async () => {
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ packages: ["npm:pi-intentum"] }),
      "utf8",
    );
    await expect(intentumRegisteredInPi({ cwd: repo.repo, env })).resolves.toBe("npm:pi-intentum");

    const launches: RecordedLaunch[] = [];
    await runCli([], {
      stdout: captureStream(),
      stderr: captureStream(),
      env,
      cwd: repo.repo,
      spawn: recordingSpawn(launches),
      platform: "linux",
    });
    expect(launches[0]?.args).toEqual(["--tui-mode", "fullscreen"]);
  });

  it("recognizes a project-local path entry that points at this checkout", async () => {
    await mkdir(join(repo.repo, ".pi"), { recursive: true });
    await writeFile(
      join(repo.repo, ".pi", "settings.json"),
      JSON.stringify({ packages: [{ source: projectRoot }] }),
      "utf8",
    );
    await expect(intentumRegisteredInPi({ cwd: repo.repo, env })).resolves.toBe(projectRoot);
  });

  it("falls back to the Pi package this checkout resolves against when pi is not on PATH", async () => {
    const launches: RecordedLaunch[] = [];
    const code = await runCli([], {
      stdout: captureStream(),
      stderr: captureStream(),
      env: { ...env, INTENTUM_PI: undefined, PATH: "/nonexistent" },
      cwd: repo.repo,
      spawn: recordingSpawn(launches),
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(launches[0]?.command).toBe(process.execPath);
    expect(launches[0]?.args[0]).toMatch(/pi-coding-agent[\/]dist[\/]bundle[\/]cli\.js$/);
    expect(launches[0]?.args.slice(1)).toEqual(["-e", projectRoot, "--tui-mode", "fullscreen"]);
  });

  it("warns about the repository, but not the platform, and still launches", async () => {
    const launches: RecordedLaunch[] = [];
    const stderr = captureStream();
    const code = await runCli([], {
      stdout: captureStream(),
      stderr,
      env,
      cwd: repo.root,
      spawn: recordingSpawn(launches),
      platform: "darwin",
    });
    expect(code).toBe(0);
    expect(launches).toHaveLength(1);
    expect(stderr.output).toContain("not a Git repository");
    expect(stderr.output).not.toContain("Bubblewrap");
  });
});

describe("intentum doctor", () => {
  let repo: TempRepository;
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    repo = await createTempRepository();
    home = await realpath(await mkdtemp(join(tmpdir(), "intentum-home-")));
    env = { PATH: process.env.PATH, HOME: home, NO_COLOR: "1", INTENTUM_PI: "/fake/pi" };
  });

  afterEach(async () => {
    await Promise.all([repo.cleanup(), rm(home, { recursive: true, force: true })]);
  });

  it("passes with warnings in a committed repository on a non-Linux host", async () => {
    const stdout = captureStream();
    const code = await runCli(["doctor"], {
      stdout,
      stderr: captureStream(),
      env,
      cwd: repo.repo,
      spawn: recordingSpawn([]),
      platform: "darwin",
      nodeVersion: "v22.19.0",
    });
    expect(code).toBe(0);
    expect(stdout.output).toContain("✓ Node.js");
    expect(stdout.output).toContain(`✓ Git repository   ${repo.repo} on main`);
    expect(stdout.output).toContain("! Worker sandbox");
    expect(stdout.output).toContain("not initialized");
    expect(stdout.output).toContain("Ready to start");
  });

  it("fails on an old Node and when run from a subdirectory", async () => {
    const stdout = captureStream();
    const nested = join(repo.repo, "src");
    await mkdir(nested);
    const code = await runCli(["doctor"], {
      stdout,
      stderr: captureStream(),
      env,
      cwd: nested,
      spawn: recordingSpawn([]),
      platform: "linux",
      nodeVersion: "v20.10.0",
    });
    expect(code).toBe(1);
    expect(stdout.output).toContain("✗ Node.js          v20.10.0 found, 22.19.0 or newer required");
    expect(stdout.output).toContain(`run intentum from the repository root: ${repo.repo}`);
    expect(stdout.output).toContain("2 problems to fix");
  });

  it("reports an initialized project", async () => {
    await mkdir(join(repo.repo, ".intentum"));
    await writeFile(join(repo.repo, ".intentum", "state.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "p1",
      projectName: "Doctor Fixture",
      phase: "discovery",
      autonomy: "guided",
      workers: {},
      pendingDecisions: [],
      schedulerPaused: false,
      updatedAt: "2026-09-03T00:00:00.000Z",
    }), "utf8");
    const stdout = captureStream();
    await runCli(["doctor"], {
      stdout,
      stderr: captureStream(),
      env,
      cwd: repo.repo,
      spawn: recordingSpawn([]),
      platform: "linux",
    });
    expect(stdout.output).toContain("Doctor Fixture · discovery phase");
  });

  it("reports Nerd Font availability and honours an explicit symbol preset", async () => {
    const stdout = captureStream();
    await runCli(["doctor"], {
      stdout,
      stderr: captureStream(),
      env: { ...env, INTENTUM_SYMBOLS: "unicode" },
      cwd: repo.repo,
      spawn: recordingSpawn([]),
      platform: "linux",
    });
    expect(stdout.output).toContain("✓ Nerd Font        unicode glyphs (INTENTUM_SYMBOLS)");

    await mkdir(join(home, "Library", "Fonts"), { recursive: true });
    await writeFile(join(home, "Library", "Fonts", "HackNerdFontMono-Regular.ttf"), Buffer.from([0, 1, 0, 0]));
    const detected = captureStream();
    await runCli(["doctor"], { stdout: detected, stderr: captureStream(), env, cwd: repo.repo, spawn: recordingSpawn([]), platform: "darwin" });
    expect(detected.output).toContain(`✓ Nerd Font        ${join(home, "Library", "Fonts", "HackNerdFontMono-Regular.ttf")}; icons enabled`);
  });
});

describe("intentum fonts", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "intentum-home-")));
    env = { PATH: process.env.PATH, HOME: home, NO_COLOR: "1", INTENTUM_PI: "/fake/pi" };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("installs the symbols font for the user through the launcher and reports failures", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const rejected = await runCli(["fonts", "install"], {
      stdout,
      stderr,
      env,
      platform: "darwin",
      fetch: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    expect(rejected).toBe(1);
    expect(stderr.output).toContain("intentum fonts: download failed: 404");
    expect(stdout.output).toBe("");

    const status = captureStream();
    expect(await runCli(["fonts"], { stdout: status, stderr: captureStream(), env, platform: "darwin" })).toBe(0);
    expect(status.output).toContain("· Nerd Font        not found");
    expect(status.output).toContain("intentum fonts install");
    expect(await runCli(["fonts", "remove"], { stdout: captureStream(), stderr: captureStream(), env, platform: "darwin" })).toBe(1);
  });
});

describe("intentum status", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "intentum-status-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prints next steps, attention, work, and project details without ANSI or broken CJK text", async () => {
    await mkdir(join(root, ".intentum"));
    await writeFile(join(root, ".intentum", "state.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "p1",
      projectName: "状态中心 🚀",
      phase: "build",
      autonomy: "balanced",
      activeFeatureId: "F-001",
      workers: {
        "W-001": {
          id: "W-001",
          status: "working",
          objective: "实现登录",
          progressSummary: "正在实现登录 👩‍💻\n  核心流程已完成",
          updatedAt: "2026-09-03T01:00:00.000Z",
        },
        "W-002": {
          id: "W-002",
          status: "completed",
          objective: "验证登录",
          progressSummary: "3 项测试通过 ✅",
          updatedAt: "2026-09-03T02:00:00.000Z",
        },
        "W-003": {
          id: "W-003",
          status: "failed",
          objective: "发布登录",
          progressSummary: "构建日志已保留",
          updatedAt: "2026-09-03T03:00:00.000Z",
        },
      },
      pendingDecisions: [{ id: "D-001", title: "\u001b[31m身份验证方式\u001b[0m", blocking: true }],
      schedulerPaused: false,
      updatedAt: "2026-09-03T00:00:00.000Z",
    }), "utf8");
    const stdout = captureStream();
    const code = await runCli(["status"], {
      stdout,
      stderr: captureStream(),
      env: { FORCE_COLOR: "1", INTENTUM_SYMBOLS: "unicode" },
      cwd: root,
    });
    expect(code).toBe(0);
    expect(stdout.output).toContain("⋗ intentum · 状态中心 🚀");
    expect(stdout.output).toContain("NEXT\n  Answer decision D-001 so blocked work can continue.");
    expect(stdout.output).toContain([
      "ATTENTION & RESULTS",
      "  ◆ D-001 · Decision required · 身份验证方式",
      "  ✕ W-003 · Failed · 构建日志已保留",
      "  ✓ W-002 · Ready for review · 3 项测试通过 ✅",
    ].join("\n"));
    expect(stdout.output).toContain("WORK\n  ● W-001 · Working · 正在实现登录 👩‍💻 核心流程已完成");
    expect(stdout.output).toContain("PROJECT\n  Phase: BUILD 4/8\n  Feature: F-001\n  Autonomy: balanced");
    expect(stdout.output).not.toMatch(/\u001b|\u009b/);
  });

  it("uses the canonical neutral paused phase and next-step wording", async () => {
    await mkdir(join(root, ".intentum"));
    await writeFile(join(root, ".intentum", "state.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "p1",
      projectName: "Paused Fixture",
      phase: "paused",
      phaseBeforePause: "build",
      autonomy: "guided",
      workers: {
        "W-001": {
          id: "W-001",
          status: "pause_requested",
          objective: "Stop safely",
          updatedAt: "2026-09-03T00:00:00.000Z",
        },
      },
      pendingDecisions: [{ id: "D-001", title: "Deferred choice", blocking: true }],
      schedulerPaused: true,
      updatedAt: "2026-09-03T00:00:00.000Z",
    }), "utf8");
    const stdout = captureStream();
    const code = await runCli(["status"], {
      stdout,
      stderr: captureStream(),
      env: { NO_COLOR: "1" },
      cwd: root,
    });
    expect(code).toBe(0);
    expect(stdout.output).toContain("NEXT\n  Project is paused. Resume it when you are ready.");
    expect(stdout.output).toContain("Phase: PAUSED (build 4/8)");
    expect(stdout.output).not.toContain("warning");
  });

  it("puts failed work before a result awaiting review", async () => {
    await mkdir(join(root, ".intentum"));
    await writeFile(join(root, ".intentum", "state.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "p1",
      projectName: "Priority Fixture",
      phase: "build",
      autonomy: "balanced",
      workers: {
        "W-001": { id: "W-001", status: "completed", objective: "Completed result", updatedAt: "2026-09-03T01:00:00.000Z" },
        "W-002": { id: "W-002", status: "failed", objective: "Failed work", updatedAt: "2026-09-03T02:00:00.000Z" },
      },
      pendingDecisions: [],
      schedulerPaused: false,
      updatedAt: "2026-09-03T00:00:00.000Z",
    }), "utf8");
    const stdout = captureStream();
    await runCli(["status"], { stdout, stderr: captureStream(), env: { NO_COLOR: "1" }, cwd: root });
    expect(stdout.output).toContain("NEXT\n  W-002 failed. Inspect the evidence before retrying or replacing the work.");
  });

  it("tells the user to initialize when there is no project, with the terminal's mark", async () => {
    const stderr = captureStream();
    const code = await runCli(["status"], {
      stdout: captureStream(),
      stderr,
      env: { NO_COLOR: "1", TERM_PROGRAM: "ghostty" },
      cwd: root,
    });
    expect(code).toBe(1);
    expect(stderr.output).toContain("\u{F08C9} intentum · no project in ");
    expect(stderr.output).toContain("intentum init [name]");
  });
});
