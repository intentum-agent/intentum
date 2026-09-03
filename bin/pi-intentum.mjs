#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_COLUMNS = 80;
const BIG_BANNER_COLUMNS = 113;
// The checked-in small lockup's longest line is 58 cells; the corrected
// specification and both renderers use that measured boundary.
const SMALL_BANNER_COLUMNS = 58;
const COMPACT_LOGO_COLUMNS = 21;
const SMALL_LOGO_COLUMNS = 12;
const SIGNAL_RED = "\u001b[31m";
const DEFAULT_FOREGROUND = "\u001b[39m";

const packageUrl = new URL("../package.json", import.meta.url);
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

async function showHelp(stdout, env) {
  const brand = await renderBrand({ stdout, env });
  writeLines(stdout, [
    ...brand,
    "",
    "Pi-native product-building harness",
    "",
    "Usage:",
    "  pi-intentum --help",
    "  pi-intentum --version",
    "",
    "Options:",
    "  -h, --help       Show this help",
    "  -v, -V, --version  Show the package version",
    "",
    "Local checkout: pi -e /path/to/pi-intentum",
    "Registry install after publication: pi install npm:pi-intentum",
    "Then run /intentum inside a Pi session.",
  ]);
}

async function showVersion(stdout, env) {
  const [brand, version] = await Promise.all([
    renderBrand({ stdout, env }),
    packageVersion(),
  ]);
  writeLines(stdout, [...brand, "", `pi-intentum v${version}`]);
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env } = {},
) {
  if (argv.length === 0 || (argv.length === 1 && ["-h", "--help"].includes(argv[0]))) {
    await showHelp(stdout, env);
    return 0;
  }

  if (argv.length === 1 && ["-v", "-V", "--version"].includes(argv[0])) {
    await showVersion(stdout, env);
    return 0;
  }

  stderr.write(`Unknown option: ${argv.join(" ")}\nRun pi-intentum --help for usage.\n`);
  return 1;
}

let invokedAsScript = false;
if (process.argv[1]) {
  try {
    // npm invokes bins through a symlink in node_modules/.bin. Compare resolved
    // paths so the installed shim still enters main, while test imports do not.
    invokedAsScript = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    invokedAsScript = false;
  }
}

if (invokedAsScript) {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi-intentum: ${message}\n`);
    process.exitCode = 1;
  }
}
