#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "intentum-pack-check-"));
const userConfig = join(scratch, "empty-npmrc");
const installRoot = join(scratch, "installed");
const npmCache = join(scratch, "npm-cache");
const packReportPath = join(scratch, "pack-report.json");
const packStderrPath = join(scratch, "pack.stderr.log");
const installStdoutPath = join(scratch, "install.stdout.log");
const installStderrPath = join(scratch, "install.stderr.log");

const npmEnv = {
  PATH: process.env.PATH ?? "",
  HOME: scratch,
  LANG: process.env.LANG ?? "C.UTF-8",
  npm_config_cache: npmCache,
  npm_config_userconfig: userConfig,
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};

async function runRedirected(script, positionalArgs, cwd, timeout = 30_000, extraEnv = {}) {
  return execFile("/bin/sh", ["-c", script, "intentum-pack-check", ...positionalArgs], {
    cwd,
    env: { ...npmEnv, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
  });
}

// npm drops these from every tarball even when their directory is listed in
// "files". Requiring them in the manifest would fail the check on a stray
// Finder or editor artefact while the published package is perfectly correct.
const NEVER_PACKED = [/^\.DS_Store$/, /^\._/, /\.orig$/, /\.rej$/, /^\..*\.swp$/, /^npm-debug\.log$/];

function alwaysExcludedByNpm(name) {
  return NEVER_PACKED.some((pattern) => pattern.test(name));
}

try {
  await writeFile(userConfig, "", "utf8");

  // Build a real tarball. A dry-run manifest alone cannot prove that the bin
  // shim or its runtime-relative brand assets survive installation.
  await runRedirected(
    '"$1" pack --json --pack-destination "$2" > "$3" 2> "$4"',
    ["npm", scratch, packReportPath, packStderrPath],
    projectRoot,
  );
  const report = JSON.parse(await readFile(packReportPath, "utf8"));
  const pack = Array.isArray(report) ? report[0] : Object.values(report)[0];
  if (!pack || !Array.isArray(pack.files) || typeof pack.filename !== "string") {
    throw new Error("npm pack did not return a file manifest");
  }

  const paths = new Set(pack.files.map((file) => file.path));
  const requiredFiles = [
    "package.json",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "intentum.md",
    "bin/intentum.mjs",
    "bin/pi-intentum.mjs",
    "brand/README.md",
    "brand/intentum-logo.svg",
    "brand/ascii/logo-big.txt",
    "brand/ascii/logo-small.txt",
    "brand/ascii/text-big.txt",
    "brand/ascii/text-small.txt",
    "brand/ascii/banner-big.txt",
    "brand/ascii/banner-small.txt",
    "extensions/intentum.ts",
    "src/runtime/pi-worker-runtime.ts",
    "src/tui/brand.ts",
    "skills/intentum-designer/SKILL.md",
    "prompts/intentum-init.md",
  ];
  for (const required of requiredFiles) {
    if (!paths.has(required)) throw new Error(`npm package is missing ${required}`);
  }
  const sourceBrandFiles = await listFiles(join(projectRoot, "brand"), "brand");
  for (const brandFile of sourceBrandFiles) {
    if (!paths.has(brandFile)) throw new Error(`npm package is missing source brand asset ${brandFile}`);
  }

  const tarball = join(scratch, pack.filename);
  const tarballStat = await stat(tarball);
  if (!tarballStat.isFile() || tarballStat.size === 0) {
    throw new Error("npm pack did not create a non-empty tarball");
  }

  await mkdir(installRoot, { recursive: true });
  await writeFile(join(installRoot, "package.json"), JSON.stringify({ private: true }), "utf8");
  await runRedirected(
    '"$1" install --offline --ignore-scripts --legacy-peer-deps --no-package-lock --no-save "$2" > "$3" 2> "$4"',
    ["npm", tarball, installStdoutPath, installStderrPath],
    installRoot,
    60_000,
  );

  const installedBin = join(installRoot, "node_modules", ".bin", "intentum");
  const installedCompanionBin = join(installRoot, "node_modules", ".bin", "pi-intentum");
  const installedPackage = JSON.parse(await readFile(
    join(installRoot, "node_modules", "pi-intentum", "package.json"),
    "utf8",
  ));
  if (installedPackage.version !== pack.version) {
    throw new Error("installed package version does not match the tarball manifest");
  }

  const versionStdoutPath = join(scratch, "version.stdout.log");
  const versionStderrPath = join(scratch, "version.stderr.log");
  const helpStdoutPath = join(scratch, "help.stdout.log");
  const helpStderrPath = join(scratch, "help.stderr.log");
  const companionStdoutPath = join(scratch, "companion.stdout.log");
  const companionStderrPath = join(scratch, "companion.stderr.log");
  await Promise.all([
    runRedirected('"$1" --version > "$2" 2> "$3"', [
      installedBin,
      versionStdoutPath,
      versionStderrPath,
    ], installRoot, 10_000, { NO_COLOR: "1" }),
    runRedirected('"$1" --help > "$2" 2> "$3"', [
      installedBin,
      helpStdoutPath,
      helpStderrPath,
    ], installRoot, 10_000, { NO_COLOR: "1" }),
    runRedirected('"$1" --version > "$2" 2> "$3"', [
      installedCompanionBin,
      companionStdoutPath,
      companionStderrPath,
    ], installRoot, 10_000, { NO_COLOR: "1" }),
  ]);
  const [versionStdout, helpStdout, companionStdout] = await Promise.all([
    readFile(versionStdoutPath, "utf8"),
    readFile(helpStdoutPath, "utf8"),
    readFile(companionStdoutPath, "utf8"),
  ]);
  if (!versionStdout.includes(`intentum v${pack.version}`)) {
    throw new Error("installed intentum --version did not report the package version");
  }
  if (!companionStdout.includes(`intentum v${pack.version}`)) {
    throw new Error("installed pi-intentum --version did not report the package version");
  }
  if (!helpStdout.includes("intentum init [name]")) {
    throw new Error("installed intentum --help did not describe the launcher commands");
  }
  if (!versionStdout.startsWith("####            _") || !helpStdout.includes("Usage:")) {
    throw new Error("installed CLI did not load the packaged 80-column brand/help output");
  }

  process.stdout.write(`${JSON.stringify({
    name: pack.name,
    version: pack.version,
    filename: pack.filename,
    entryCount: pack.entryCount,
    packedSize: tarballStat.size,
    unpackedSize: pack.unpackedSize,
    brandFiles: `${sourceBrandFiles.length}/${sourceBrandFiles.length} PASS`,
    requiredFiles: "PASS",
    temporaryInstall: "PASS",
    installedCli: "PASS",
  }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

async function listFiles(directory, prefix) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (alwaysExcludedByNpm(entry.name)) continue;
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await listFiles(join(directory, entry.name), relative));
    else if (entry.isFile()) paths.push(relative);
  }
  return paths.sort();
}
