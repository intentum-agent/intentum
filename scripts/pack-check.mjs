#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "intentum-pack-check-"));
const userConfig = join(scratch, "empty-npmrc");
const reportPath = join(scratch, "pack-report.json");
const stderrPath = join(scratch, "npm.stderr.log");

try {
  await writeFile(userConfig, "", "utf8");
  const command = `"$1" pack --dry-run --json > "$2" 2> "$3"`;
  await execFile("/bin/sh", ["-c", command, "intentum-pack-check", "npm", reportPath, stderrPath], {
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      LANG: process.env.LANG ?? "C.UTF-8",
      npm_config_cache: join(scratch, "npm-cache"),
      npm_config_userconfig: userConfig,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 20_000,
  });
  const stdout = await readFile(reportPath, "utf8");
  const report = JSON.parse(stdout);
  const pack = Array.isArray(report) ? report[0] : Object.values(report)[0];
  if (!pack || !Array.isArray(pack.files)) throw new Error("npm pack did not return a file manifest");
  const paths = new Set(pack.files.map((file) => file.path));
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "intentum.md",
    "extensions/intentum.ts",
    "src/runtime/pi-worker-runtime.ts",
    "skills/intentum-designer/SKILL.md",
    "prompts/intentum-init.md",
  ]) {
    if (!paths.has(required)) throw new Error(`npm package is missing ${required}`);
  }
  process.stdout.write(`${JSON.stringify({
    name: pack.name,
    version: pack.version,
    filename: pack.filename,
    entryCount: pack.entryCount,
    unpackedSize: pack.unpackedSize,
    requiredFiles: "PASS",
  }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
