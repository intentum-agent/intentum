#!/usr/bin/env node

import { spawn as nodeSpawn } from "node:child_process";
import { access, readFile, realpath as fsRealpath } from "node:fs/promises";
import { constants as fsConstants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_COLUMNS = 80;
const BIG_BANNER_COLUMNS = 113;
// The checked-in small lockup's longest line is 58 cells; the corrected
// specification and both renderers use that measured boundary.
const SMALL_BANNER_COLUMNS = 58;
const COMPACT_LOGO_COLUMNS = 21;
const SMALL_LOGO_COLUMNS = 12;
const SIGNAL_RED = "[31m";
const DEFAULT_FOREGROUND = "[39m";
const MINIMUM_NODE = [22, 19, 0];
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const DEFAULT_TUI_MODE = "fullscreen";
const TRUSTED_BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"];
const ACTIVE_PROJECT_PHASES = ["discovery", "direction", "architecture", "build", "verify", "review", "ship", "maintain"];
const ATTENTION_WORKER_STATUSES = new Set(["failed", "blocked", "interrupted", "completed", "integrated"]);

const WORKER_PRESENTATION = Object.freeze({
  queued: { glyph: "◌", label: "Queued" },
  starting: { glyph: "◔", label: "Starting" },
  working: { glyph: "●", label: "Working" },
  blocked: { glyph: "⚠", label: "Blocked" },
  pause_requested: { glyph: "◑", label: "Pausing" },
  paused: { glyph: "○", label: "Paused" },
  verifying: { glyph: "◐", label: "Verifying" },
  completed: { glyph: "✓", label: "Ready for review" },
  failed: { glyph: "✕", label: "Failed" },
  interrupted: { glyph: "!", label: "Interrupted" },
  integrated: { glyph: "✓", label: "Integrated" },
});

const packageUrl = new URL("../package.json", import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const asciiRootUrl = new URL("../brand/ascii/", import.meta.url);

function terminalColumns(stream) {
  const columns = Number(stream?.columns);
  return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : DEFAULT_COLUMNS;
}

function colorEnabled(stream, env) {
  if (Object.hasOwn(env, "NO_COLOR")) return false;
  if (env.FORCE_COLOR === "0") return false;
  if (Object.hasOwn(env, "FORCE_COLOR")) return true;
  return stream?.isTTY === true;
}

function splitAsset(contents) {
  return contents.replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n");
}

async function readAscii(name) {
  return splitAsset(await readFile(new URL(name, asciiRootUrl), "utf8"));
}

function colorPointCells(line, mask, point, enabled) {
  if (!enabled) return line;

  let result = "";
  let pointRun = false;
  for (let index = 0; index < line.length; index += 1) {
    const isPoint = mask[index] === point && line[index] === point;
    if (isPoint !== pointRun) {
      result += isPoint ? SIGNAL_RED : DEFAULT_FOREGROUND;
      pointRun = isPoint;
    }
    result += line[index];
  }
  if (pointRun) result += DEFAULT_FOREGROUND;
  return result;
}

async function loadLockup(size, enabled) {
  const point = size === "big" ? "@" : "o";
  const [banner, logo] = await Promise.all([
    readAscii(`banner-${size}.txt`),
    readAscii(`logo-${size}.txt`),
  ]);
  return banner.map((line, index) => colorPointCells(line, logo[index] ?? "", point, enabled));
}

async function loadCompactLogo(enabled) {
  const logo = await readAscii("logo-small.txt");
  const labelLine = Math.floor((logo.length - 1) / 2);
  return logo.map((line, index) => {
    const withLabel = index === labelLine ? `${line} intentum` : line;
    return colorPointCells(withLabel, line, "o", enabled);
  });
}

async function loadSmallLogo(enabled) {
  const logo = await readAscii("logo-small.txt");
  return logo.map((line) => colorPointCells(line, line, "o", enabled));
}

/**
 * Render the terminal brand from the shipped ASCII source files.
 * The optional stream/env arguments keep the executable testable without
 * changing the production process.stdout.columns selection rule.
 */
export async function renderBrand({ stdout = process.stdout, env = process.env } = {}) {
  const columns = terminalColumns(stdout);
  const enabled = colorEnabled(stdout, env);

  if (columns >= BIG_BANNER_COLUMNS) return loadLockup("big", enabled);
  if (columns >= SMALL_BANNER_COLUMNS) return loadLockup("small", enabled);
  if (columns >= COMPACT_LOGO_COLUMNS) return loadCompactLogo(enabled);
  if (columns >= SMALL_LOGO_COLUMNS) return loadSmallLogo(enabled);

  const promptMark = env.INTENTUM_ASCII_MARK === "1" ? ">•" : "⋗";
  return [`${promptMark} intentum`.slice(0, columns)];
}

async function packageVersion() {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json does not contain a version");
  }
  return packageJson.version;
}

function writeLines(stream, lines) {
  stream.write(`${lines.join("\n")}\n`);
}

function mark(env) {
  return env.INTENTUM_ASCII_MARK === "1" ? ">•" : "⋗";
}

async function showHelp(stdout, env) {
  const brand = await renderBrand({ stdout, env });
  writeLines(stdout, [
    ...brand,
    "",
    "Turn product intent into verified software, inside Pi.",
    "",
    "Usage:",
    "  intentum                   Open Pi in this repository with Intentum loaded",
    "  intentum init [name]       Open Pi and initialize this repository as a project",
    "  intentum status            Show the next step, attention, work, and project details",
    "  intentum doctor            Check Node, Git, Pi, and the Worker sandbox",
    "  intentum [pi options]      Anything else is passed to pi, e.g. --model sonnet",
    "  intentum --tui-mode regular  Keep Pi's inline mode instead of the fullscreen default",
    "",
    "Options:",
    "  -h, --help                 Show this help",
    "  -v, --version              Show the version",
    "",
    "Run it from the root of the Git repository you want Intentum to manage.",
    "Inside Pi, type /intentum to see the session commands.",
    "",
    "Install as a Pi package:  pi install npm:pi-intentum",
    "Local checkout:           pi -e /path/to/pi-intentum",
  ]);
}

async function showVersion(stdout, env) {
  const [brand, version] = await Promise.all([
    renderBrand({ stdout, env }),
    packageVersion(),
  ]);
  writeLines(stdout, [...brand, "", `intentum v${version}`]);
}

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if ((actual[index] ?? 0) > minimum[index]) return true;
    if ((actual[index] ?? 0) < minimum[index]) return false;
  }
  return true;
}

async function fileExists(path, mode = fsConstants.F_OK) {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(name, env) {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (await fileExists(candidate, fsConstants.X_OK)) return candidate;
  }
  return undefined;
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Locate the Pi CLI. Order: INTENTUM_PI override, a `pi` executable on PATH
 * (the one the user already runs and authenticated), then the Pi package this
 * package resolves against (peer dependency or development checkout).
 */
export async function locatePi({ env = process.env } = {}) {
  if (env.INTENTUM_PI) {
    return { command: env.INTENTUM_PI, args: [], source: "INTENTUM_PI", version: undefined };
  }

  const onPath = await findOnPath("pi", env);
  if (onPath) return { command: onPath, args: [], source: "PATH", version: undefined };

  try {
    let directory = dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE)));
    let manifest;
    while (directory !== dirname(directory)) {
      manifest = await readJsonIfPresent(join(directory, "package.json"));
      if (manifest?.name === PI_PACKAGE) break;
      manifest = undefined;
      directory = dirname(directory);
    }
    const bin = typeof manifest?.bin === "string" ? manifest.bin : manifest?.bin?.pi;
    if (manifest && typeof bin === "string") {
      return {
        command: process.execPath,
        args: [join(directory, bin)],
        source: "package",
        version: manifest.version,
      };
    }
  } catch {
    // Not resolvable from here.
  }
  return undefined;
}

async function probeVersion(pi, cwd, spawn) {
  if (pi.version) return pi.version;
  return new Promise((resolveResult) => {
    let output = "";
    let child;
    try {
      child = spawn(pi.command, [...pi.args, "--version"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolveResult(undefined);
      return;
    }
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.on("error", () => resolveResult(undefined));
    child.on("close", () => resolveResult(parseVersion(output)?.join(".")));
  });
}

function settingsPackageSources(settings) {
  const packages = Array.isArray(settings?.packages) ? settings.packages : [];
  return packages
    .map((entry) => (typeof entry === "string" ? entry : entry?.source))
    .filter((source) => typeof source === "string");
}

/**
 * Report whether Pi's own settings already load Intentum, in which case the
 * launcher must not add a second copy through `-e`.
 */
export async function intentumRegisteredInPi({ cwd, env = process.env } = {}) {
  const home = env.HOME ?? homedir();
  const files = [join(home, ".pi", "agent", "settings.json"), join(cwd, ".pi", "settings.json")];
  const ownRoot = await fsRealpath(packageRoot).catch(() => packageRoot);
  for (const file of files) {
    for (const source of settingsPackageSources(await readJsonIfPresent(file))) {
      if (/(^|[/:])pi-intentum(@|$)/.test(source) || /\/intentum(\.git)?(@[^/]*)?$/.test(source)) return source;
      if (source.startsWith("/") || source.startsWith(".") || source.startsWith("~")) {
        const localPath = source.startsWith("~")
          ? join(home, source.slice(1))
          : resolve(dirname(file), source);
        const canonical = await fsRealpath(localPath).catch(() => undefined);
        if (canonical === ownRoot) return source;
      }
    }
  }
  return undefined;
}

async function runGit(args, cwd, spawn) {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolveResult({ ok: false, stdout: "", stderr: "git could not be started" });
      return;
    }
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolveResult({ ok: false, stdout, stderr: error.message }));
    child.on("close", (code) => resolveResult({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/**
 * Describe the Git repository at cwd the way the controller will judge it:
 * an existing commit on a named branch is required before a Worker can start.
 */
export async function inspectRepository(cwd, { env = process.env, spawn = nodeSpawn } = {}) {
  const git = await findOnPath("git", env);
  if (!git) return { git: false };
  const top = await runGit(["rev-parse", "--show-toplevel"], cwd, spawn);
  if (!top.ok) return { git: true, repository: false };
  const [root, actual] = await Promise.all([
    fsRealpath(top.stdout).catch(() => top.stdout),
    fsRealpath(cwd).catch(() => cwd),
  ]);
  const head = await runGit(["rev-parse", "--verify", "-q", "HEAD"], cwd, spawn);
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd, spawn);
  return {
    git: true,
    repository: true,
    root,
    atRoot: root === actual,
    hasHead: head.ok,
    branch: branch.ok && branch.stdout !== "HEAD" ? branch.stdout : undefined,
  };
}

async function readProjectState(cwd) {
  const path = join(cwd, ".intentum", "state.json");
  if (!(await fileExists(path))) return { exists: false, path };
  try {
    return { exists: true, path, state: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    return { exists: true, path, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * State fields can contain repository-authored text. Keep the companion
 * command plain, single-line, and safe to paste into logs without splitting
 * grapheme clusters or allowing terminal escape sequences through.
 */
function plainStatusText(value, fallback) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)?/gu, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001B[()][0-2A-Z0-9]/gu, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim() || fallback;
}

function statusObjects(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.values(value).filter((item) => item && typeof item === "object")
    : [];
}

function sortedStatusWorkers(state) {
  return statusObjects(state.workers).sort((left, right) => {
    const byTime = plainStatusText(right.updatedAt, "").localeCompare(plainStatusText(left.updatedAt, ""));
    return byTime || plainStatusText(left.id, "?").localeCompare(plainStatusText(right.id, "?"));
  });
}

function statusDecisions(state) {
  return Array.isArray(state.pendingDecisions)
    ? state.pendingDecisions.filter((item) => item && typeof item === "object")
    : [];
}

function statusPhaseLabel(state) {
  if (state.phase === "paused") {
    const before = ACTIVE_PROJECT_PHASES.includes(state.phaseBeforePause) ? state.phaseBeforePause : undefined;
    if (!before) return "PAUSED";
    return `PAUSED (${before} ${ACTIVE_PROJECT_PHASES.indexOf(before) + 1}/${ACTIVE_PROJECT_PHASES.length})`;
  }
  const phase = plainStatusText(state.phase, "unknown");
  const index = ACTIVE_PROJECT_PHASES.indexOf(phase);
  return index >= 0 ? `${phase.toUpperCase()} ${index + 1}/${ACTIVE_PROJECT_PHASES.length}` : phase.toUpperCase();
}

function workerPresentation(worker) {
  const status = plainStatusText(worker.status, "unknown");
  return WORKER_PRESENTATION[status] ?? { glyph: "?", label: status === "unknown" ? "Unknown" : status };
}

function workerStatusLine(worker) {
  const presentation = workerPresentation(worker);
  const id = plainStatusText(worker.id, "?");
  const detail = plainStatusText(worker.blocker ?? worker.progressSummary ?? worker.objective, "No update yet");
  return `  ${presentation.glyph} ${id} · ${presentation.label} · ${detail}`;
}

function decisionStatusLine(decision) {
  const blocking = decision.blocking === true;
  const id = plainStatusText(decision.id, "?");
  const title = plainStatusText(decision.title, "Untitled decision");
  return `  ${blocking ? "◆" : "◇"} ${id} · ${blocking ? "Decision required" : "Open decision"} · ${title}`;
}

function statusNextStep(state, workers, decisions) {
  if (state.phase === "paused") return "Project is paused. Resume it when you are ready.";

  const blocking = decisions.find((decision) => decision.blocking === true);
  if (blocking) return `Answer decision ${plainStatusText(blocking.id, "?")} so blocked work can continue.`;

  const risk = workers.find((worker) => worker.status === "failed")
    ?? workers.find((worker) => worker.status === "blocked")
    ?? workers.find((worker) => worker.status === "interrupted");
  if (risk?.status === "failed") return `${plainStatusText(risk.id, "?")} failed. Inspect the evidence before retrying or replacing the work.`;
  if (risk?.status === "blocked") return `${plainStatusText(risk.id, "?")} is blocked. Resolve the blocker or give it a targeted instruction.`;
  if (risk?.status === "interrupted") return `${plainStatusText(risk.id, "?")} was interrupted. Inspect preserved work before resuming it.`;

  const completed = workers.find((worker) => worker.status === "completed");
  if (completed) return `Review ${plainStatusText(completed.id, "?")}'s result and integrate it when the evidence is sufficient.`;

  const verifying = workers.find((worker) => worker.status === "verifying");
  if (verifying) return `${plainStatusText(verifying.id, "?")} is verifying its result. Review the evidence when verification completes.`;

  const active = workers.find((worker) => ["starting", "working", "pause_requested"].includes(worker.status));
  if (active) {
    const label = workerPresentation(active).label.toLowerCase();
    return `${plainStatusText(active.id, "?")} is ${label}. Keep shaping the product or steer it with a targeted instruction.`;
  }

  const paused = workers.find((worker) => worker.status === "paused");
  if (paused) {
    return `${plainStatusText(paused.id, "?")} is paused. Resume it or give it a targeted instruction.`;
  }

  if (state.phase === "discovery") {
    return "Shape the charter from repository evidence, then confirm only the decisions the code cannot answer.";
  }
  return "Describe the next outcome in chat; the Designer will turn it into focused work.";
}

async function showStatus({ stdout, stderr, env, cwd }) {
  const { exists, path, state, error } = await readProjectState(cwd);
  const prefix = mark(env);
  if (!exists) {
    stderr.write([
      `${prefix} intentum · no project in ${plainStatusText(cwd, "this directory")}`,
      "Run `intentum init [name]` from the repository root to create one.",
      "",
    ].join("\n"));
    return 1;
  }
  if (error || !state || typeof state !== "object") {
    stderr.write(`${prefix} intentum · ${plainStatusText(path, ".intentum/state.json")} could not be read: ${plainStatusText(error, "not a JSON object")}\n`);
    return 1;
  }

  const workers = sortedStatusWorkers(state);
  const decisions = statusDecisions(state);
  const attentionWorkers = workers.filter((worker) => ATTENTION_WORKER_STATUSES.has(worker.status));
  const work = workers.filter((worker) => !ATTENTION_WORKER_STATUSES.has(worker.status));
  const blockingDecisions = decisions.filter((decision) => decision.blocking === true);
  const openDecisions = decisions.filter((decision) => decision.blocking !== true);
  const attention = [
    ...blockingDecisions.map(decisionStatusLine),
    ...attentionWorkers.filter((worker) => worker.status === "failed").map(workerStatusLine),
    ...attentionWorkers.filter((worker) => worker.status === "blocked").map(workerStatusLine),
    ...attentionWorkers.filter((worker) => worker.status === "interrupted").map(workerStatusLine),
    ...attentionWorkers.filter((worker) => worker.status === "completed").map(workerStatusLine),
    ...attentionWorkers.filter((worker) => worker.status === "integrated").map(workerStatusLine),
    ...openDecisions.map(decisionStatusLine),
  ];
  const lines = [
    `${prefix} intentum · ${plainStatusText(state.projectName, "unnamed project")}`,
    "",
    "NEXT",
    `  ${statusNextStep(state, workers, decisions)}`,
    "",
    "ATTENTION & RESULTS",
    ...(attention.length ? attention : ["  None."]),
    "",
    "WORK",
    ...(work.length ? work.map(workerStatusLine) : ["  No work in progress."]),
    "",
    "PROJECT",
    `  Phase: ${statusPhaseLabel(state)}`,
    `  Feature: ${plainStatusText(state.activeFeatureId, "none")}`,
    `  Autonomy: ${plainStatusText(state.autonomy, "unknown")}`,
    `  Updated: ${plainStatusText(state.updatedAt, "unknown")}`,
    "",
    "Run `intentum` to continue in Pi.",
  ];
  writeLines(stdout, lines);
  return 0;
}

function checkLine(status, label, detail) {
  const icon = status === "ok" ? "✓" : status === "warn" ? "!" : status === "fail" ? "✗" : "·";
  return `  ${icon} ${label.padEnd(16)} ${detail}`;
}

async function runDoctor({ stdout, env, cwd, spawn, platform, nodeVersion }) {
  const lines = [];
  let failures = 0;
  let warnings = 0;
  const note = (status, label, detail) => {
    if (status === "fail") failures += 1;
    if (status === "warn") warnings += 1;
    lines.push(checkLine(status, label, detail));
  };

  const node = parseVersion(nodeVersion);
  if (node && versionAtLeast(node, MINIMUM_NODE)) note("ok", "Node.js", nodeVersion);
  else note("fail", "Node.js", `${nodeVersion} found, ${MINIMUM_NODE.join(".")} or newer required`);

  const pi = await locatePi({ env });
  if (!pi) {
    note("fail", "Pi", "not found. Install it with `npm install -g @earendil-works/pi-coding-agent`");
  } else {
    const where = pi.source === "package" ? pi.args[0] : pi.command;
    const version = await probeVersion(pi, cwd, spawn);
    note("ok", "Pi", `${version ? `v${version} ` : ""}(${where})`);
  }

  const registered = await intentumRegisteredInPi({ cwd, env });
  if (registered) note("ok", "Pi package", `registered in Pi settings as ${registered}`);
  else note("ok", "Pi package", `not in Pi settings; the launcher loads ${packageRoot}`);

  const repo = await inspectRepository(cwd, { env, spawn });
  if (!repo.git) note("fail", "Git", "git is not on PATH");
  else if (!repo.repository) note("fail", "Git repository", `${cwd} is not inside a Git repository. Run git init first`);
  else if (!repo.atRoot) note("fail", "Git repository", `run intentum from the repository root: ${repo.root}`);
  else if (!repo.hasHead) note("fail", "Git repository", "no commits yet. Intentum needs an existing commit before a Worker can start");
  else if (!repo.branch) note("fail", "Git repository", "HEAD is detached. Check out a named branch");
  else note("ok", "Git repository", `${repo.root} on ${repo.branch}`);

  if (platform !== "linux") {
    note("warn", "Worker sandbox", `Bubblewrap is Linux-only (this is ${platform}). Designer conversation and init work; Workers cannot start here`);
  } else {
    let bwrap;
    for (const candidate of TRUSTED_BWRAP_CANDIDATES) {
      if (await fileExists(candidate, fsConstants.X_OK)) { bwrap = candidate; break; }
    }
    if (bwrap) note("ok", "Worker sandbox", bwrap);
    else note("warn", "Worker sandbox", "bubblewrap not found at /usr/bin/bwrap or /bin/bwrap. Install it before starting a Worker");
  }

  const project = await readProjectState(cwd);
  if (!project.exists) note("info", "Project", "not initialized. Run `intentum init [name]`");
  else if (project.error) note("fail", "Project", `${project.path} is unreadable: ${project.error}`);
  else note("ok", "Project", `${project.state.projectName ?? "unnamed"} · ${project.state.phase ?? "unknown"} phase`);

  const summary = failures
    ? `${failures} problem${failures === 1 ? "" : "s"} to fix before running intentum.`
    : warnings
      ? "Ready to start. Warnings above limit what Workers can do on this machine."
      : "Everything looks good.";
  writeLines(stdout, [`${mark(env)} intentum doctor`, "", ...lines, "", summary]);
  return failures ? 1 : 0;
}

function waitForExit(child) {
  return new Promise((resolveResult, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolveResult({ code, signal }));
  });
}

async function launchPi({ piArgs, initialMessage, stderr, env, cwd, spawn }) {
  const pi = await locatePi({ env });
  if (!pi) {
    stderr.write([
      "intentum: Pi is not installed or not on PATH.",
      "  Install it:     npm install -g @earendil-works/pi-coding-agent",
      "  Or point at it: INTENTUM_PI=/path/to/pi intentum",
      "",
    ].join("\n"));
    return 1;
  }

  const repo = await inspectRepository(cwd, { env, spawn });
  const hints = [];
  if (!repo.git) hints.push("git is not on PATH; /intentum init will fail until it is installed.");
  else if (!repo.repository) hints.push(`${cwd} is not a Git repository; run git init and make a first commit before /intentum init.`);
  else if (!repo.atRoot) hints.push(`starting from a subdirectory; Intentum manages the repository root ${repo.root}. Run it from there.`);
  else if (!repo.hasHead) hints.push("this repository has no commits yet; make a first commit before starting a Worker.");
  else if (!repo.branch) hints.push("HEAD is detached; check out a named branch before starting a Worker.");
  // Platform limits are reported by `intentum doctor`, not on every launch.
  for (const hint of hints) stderr.write(`${mark(env)} intentum: ${hint}\n`);

  const registered = await intentumRegisteredInPi({ cwd, env });
  const args = [...pi.args];
  if (!registered) args.push("-e", packageRoot);
  // Pi's alternate-screen mode: the session fills the terminal, the shell's
  // earlier output stays hidden, and there is no scrollback to fall out of.
  if (!piArgs.includes("--tui-mode")) args.push("--tui-mode", DEFAULT_TUI_MODE);
  args.push(...piArgs);
  if (initialMessage) args.push("--", initialMessage);

  const child = spawn(pi.command, args, { cwd, env, stdio: "inherit" });
  const forward = (signal) => { try { child.kill(signal); } catch { /* already gone */ } };
  const ignore = () => {};
  // The terminal delivers Ctrl+C to the whole foreground group; Pi handles it
  // itself, so the launcher must not exit first and leave Pi orphaned.
  process.on("SIGINT", ignore);
  process.on("SIGTERM", forward);
  try {
    const { code, signal } = await waitForExit(child);
    if (signal) {
      stderr.write(`intentum: pi exited on ${signal}\n`);
      return 1;
    }
    return code ?? 0;
  } finally {
    process.off("SIGINT", ignore);
    process.off("SIGTERM", forward);
  }
}

function splitPassthrough(args) {
  const separator = args.indexOf("--");
  return separator === -1
    ? { own: args, passthrough: [] }
    : { own: args.slice(0, separator), passthrough: args.slice(separator + 1) };
}

export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    cwd = process.cwd(),
    spawn = nodeSpawn,
    platform = process.platform,
    nodeVersion = process.version,
  } = {},
) {
  const [first = "", ...rest] = argv;
  const context = { stdout, stderr, env, cwd, spawn, platform, nodeVersion };

  if (["-h", "--help", "help"].includes(first)) {
    await showHelp(stdout, env);
    return 0;
  }
  if (["-v", "-V", "--version", "version"].includes(first)) {
    await showVersion(stdout, env);
    return 0;
  }
  if (first === "status") return showStatus(context);
  if (first === "doctor") return runDoctor(context);
  if (first === "init") {
    const { own, passthrough } = splitPassthrough(rest);
    const name = own.join(" ").trim();
    return launchPi({
      ...context,
      piArgs: passthrough,
      initialMessage: name ? `/intentum init ${name}` : "/intentum init",
    });
  }
  return launchPi({ ...context, piArgs: argv, initialMessage: undefined });
}

/**
 * Run the CLI when this module is the executable Node started. Bin shims
 * are symlinks, so compare resolved paths; test imports never match.
 */
export async function main(moduleUrl, programName) {
  let invokedAsScript = false;
  if (process.argv[1]) {
    try {
      invokedAsScript = realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);
    } catch {
      invokedAsScript = false;
    }
  }
  if (!invokedAsScript) return;

  try {
    process.exitCode = await runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${programName}: ${message}\n`);
    process.exitCode = 1;
  }
}

await main(import.meta.url, "intentum");
