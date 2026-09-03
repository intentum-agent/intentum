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
      env,
      cwd: repo.repo,
      spawn: recordingSpawn(launches),
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(launches).toEqual([{
      command: "/fake/pi",
      args: ["-e", projectRoot, "--model", "sonnet"],
      cwd: repo.repo,
    }]);
    expect(stderr.output).toBe("");
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
    expect(launches[0]?.args).toEqual(["-e", projectRoot, "--no-session", "--", "/intentum init My Product"]);
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
    expect(launches[0]?.args).toEqual([]);
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
    expect(launches[0]?.args.slice(1)).toEqual(["-e", projectRoot]);
  });

  it("warns, but still launches, outside a Git repository and off Linux", async () => {
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
    expect(stderr.output).toContain("Workers need Linux with Bubblewrap");
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
});

describe("intentum status", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "intentum-status-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prints the project summary and Workers from state.json without starting Pi", async () => {
    await mkdir(join(root, ".intentum"));
    await writeFile(join(root, ".intentum", "state.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "p1",
      projectName: "Status Fixture",
      phase: "building",
      autonomy: "balanced",
      activeFeatureId: "F-001",
      workers: {
        "W-001": { id: "W-001", status: "working", objective: "Ship it", progressSummary: "Tests green" },
      },
      pendingDecisions: [{}],
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
    expect(stdout.output).toContain("⋗ intentum · Status Fixture");
    expect(stdout.output).toContain("phase       building (paused)");
    expect(stdout.output).toContain("autonomy    balanced");
    expect(stdout.output).toContain("feature     F-001");
    expect(stdout.output).toContain("decisions   1 pending");
    expect(stdout.output).toContain("W-001  working  Tests green");
  });

  it("tells the user to initialize when there is no project", async () => {
    const stderr = captureStream();
    const code = await runCli(["status"], {
      stdout: captureStream(),
      stderr,
      env: { NO_COLOR: "1" },
      cwd: root,
    });
    expect(code).toBe(1);
    expect(stderr.output).toContain("intentum init [name]");
  });
});
