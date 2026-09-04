#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piBin = join(projectRoot, "node_modules", ".bin", "pi");
const fixtureRoot = await mkdtemp(join(tmpdir(), "intentum-rpc-smoke-"));
const fixtureRepo = join(fixtureRoot, "repo");
const agentDir = join(fixtureRoot, "pi-agent");

try {
  await Promise.all([
    mkdir(fixtureRepo, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
  ]);
  await git(["init", "-b", "main"], fixtureRepo);
  await git(["config", "user.name", "Intentum Smoke"], fixtureRepo);
  await git(["config", "user.email", "intentum-smoke@example.invalid"], fixtureRepo);
  await writeFile(join(fixtureRepo, "README.md"), "# Fixture\n", "utf8");
  await git(["add", "README.md"], fixtureRepo);
  await git(["commit", "-m", "fixture: initial commit"], fixtureRepo);

  const commands = [
    { id: "commands", type: "get_commands" },
    { id: "init", type: "prompt", message: "/intentum init RPC Smoke Project" },
    { id: "status", type: "prompt", message: "/intentum status" },
  ];

  // Pi 0.84.4's Node RPC reader does not explicitly resume an initially-empty stdin
  // stream. A producer pipe places one JSONL frame before startup completes and keeps
  // the pipe open while that local extension command finishes. Each command runs in a
  // separate process, so init/status ordering is based on process completion rather
  // than timing between concurrently-dispatched RPC handlers.
  const batches = [];
  for (const command of commands) batches.push(await runRpcCommand(command));
  const stdout = batches.map((batch) => batch.stdout).join("");
  const stderr = batches.map((batch) => batch.stderr).filter(Boolean).join("\n");

  const events = parseJsonLines(stdout);
  const initEvents = parseJsonLines(batches[1].stdout);
  const statusEvents = parseJsonLines(batches[2].stdout);
  const responses = new Map(
    events.filter((event) => event.type === "response" && event.id).map((event) => [event.id, event]),
  );
  for (const id of ["commands", "init", "status"]) {
    const response = responses.get(id);
    assert(response?.success === true,
      `Pi RPC command ${id} did not succeed: ${JSON.stringify(response)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  const commandRegistered = responses.get("commands").data.commands.some(
    (command) => command.name === "intentum" && command.source === "extension",
  );
  assert(commandRegistered, "the intentum extension command was not registered");

  const state = JSON.parse(await readFile(join(fixtureRepo, ".intentum", "state.json"), "utf8"));
  assert(state.schemaVersion === 1, "state schema version was not initialized");
  assert(state.projectName === "RPC Smoke Project", "project name was not stored by /intentum init");
  assert(state.phase === "discovery", "project did not begin in discovery phase");
  await Promise.all([
    readFile(join(fixtureRepo, ".intentum", "charter.md"), "utf8"),
    readFile(join(fixtureRepo, ".intentum", "architecture.md"), "utf8"),
  ]);

  assert(events.some((event) => event.type === "extension_ui_request" && event.method === "setWidget"),
    "the extension did not publish its compact widget");
  assert(
    initEvents.some((event) => event.type === "extension_ui_request"
      && event.method === "setWidget"
      && event.widgetKey === "intentum-welcome"
      && Array.isArray(event.widgetLines)
      && event.widgetLines.length > 0),
    "the init command did not publish a serializable one-time welcome banner",
  );
  assert(
    !statusEvents.some((event) => event.type === "extension_ui_request"
      && event.method === "setWidget"
      && event.widgetKey === "intentum-welcome"
      && Array.isArray(event.widgetLines)
      && event.widgetLines.length > 0),
    "the restored status command replayed the one-time welcome banner",
  );
  assert(events.some((event) => event.type === "extension_ui_request" && event.method === "setStatus"),
    "the extension did not publish its status line");
  assert(events.some((event) => event.type === "extension_ui_request" && event.method === "notify"
    && typeof event.message === "string" && event.message.includes("initialized RPC Smoke Project")),
    "the init command did not emit its UI notification");
  const statusNotification = statusEvents.find((event) => event.type === "extension_ui_request"
    && event.method === "notify" && event.notifyType === "info");
  assert(typeof statusNotification?.message === "string",
    "the status command did not emit its compact info notification");
  const statusLines = statusNotification.message.split("\n");
  assert(statusLines[0] === "RPC Smoke Project · DISCOVERY 1/8 · Feature: none yet · autonomy guided",
    `the status command emitted an unexpected compact heading: ${JSON.stringify(statusNotification.message)}`);
  assert(statusLines[1]?.startsWith("No Worker yet ·") && statusLines.length === 2,
    `the empty-project status should be a two-line compact summary: ${JSON.stringify(statusNotification.message)}`);
  assert(!/\u001b|\u009b/.test(statusNotification.message),
    "the RPC status notification contained an ANSI escape sequence");
  assert(!events.some((event) => event.type === "extension_error"), "Pi reported an extension_error event");
  assert(!events.some((event) => event.type === "agent_start"), "the command-only smoke unexpectedly invoked a model");

  const piPackage = JSON.parse(await readFile(
    join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    "utf8",
  ));
  const piVersion = piPackage.version;
  process.stdout.write(`${JSON.stringify({
    piVersion,
    commandRegistered,
    init: "PASS",
    status: "PASS",
    widget: "PASS",
    banner: "PASS",
    modelInvoked: false,
    fixture: process.env.INTENTUM_KEEP_SMOKE === "1" ? fixtureRepo : "removed",
  }, null, 2)}\n`);
} finally {
  if (process.env.INTENTUM_KEEP_SMOKE !== "1") await rm(fixtureRoot, { recursive: true, force: true });
}

function parseJsonLines(value) {
  return value.split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Pi RPC emitted invalid JSON: ${line}`, { cause: error });
    }
  });
}

async function runRpcCommand(command) {
  const commandPath = join(fixtureRoot, `${command.id}.command.jsonl`);
  const eventsPath = join(fixtureRoot, `${command.id}.events.jsonl`);
  const stderrPath = join(fixtureRoot, `${command.id}.stderr.log`);
  await writeFile(commandPath, `${JSON.stringify(command)}\n`, "utf8");
  const producer = `{ cat "$1"; sleep 1; } | "$2" --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --approve --offline -e "$3" > "$4" 2> "$5"`;
  await execFile(
    "/bin/sh",
    ["-c", producer, "intentum-rpc-smoke", commandPath, piBin, projectRoot, eventsPath, stderrPath],
    {
      cwd: fixtureRepo,
      env: cleanEnvironment(agentDir, fixtureRoot),
      maxBuffer: 4 * 1024 * 1024,
      timeout: 20_000,
      killSignal: "SIGKILL",
    },
  );
  const [stdout, stderr] = await Promise.all([
    readFile(eventsPath, "utf8"),
    readFile(stderrPath, "utf8"),
  ]);
  return { stdout, stderr };
}

function cleanEnvironment(configDir, home) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    PI_CODING_AGENT_DIR: configDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
}

async function git(args, cwd) {
  await execFile("git", args, { cwd });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
