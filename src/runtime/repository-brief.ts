import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runFile } from "../utils/process.js";
import { assertRepositoryOwnedPath } from "../utils/safe-path.js";

export type RepositoryPosture = "existing-product" | "sparse" | "empty";

export interface RepositoryManifest {
  path: string;
  name?: string;
  description?: string;
  scripts?: string[];
}

export interface RepositoryBrief {
  posture: RepositoryPosture;
  branch?: string;
  headSubject?: string;
  trackedFileCount: number;
  topLevel: string[];
  manifests: RepositoryManifest[];
  readmeExcerpt?: string;
  notablePaths: string[];
}

const SKIP_TOP_LEVEL = new Set([".git", ".intentum", "node_modules", "dist", "vendor", ".venv"]);
const PRODUCT_LAYOUT = ["src", "app", "apps", "lib"] as const;
const NOTABLE_DIRECTORIES = [
  "src",
  "app",
  "apps",
  "lib",
  "tests",
  "test",
  "docs",
  "bin",
  "extensions",
  "skills",
  "packages",
] as const;
const README_CANDIDATES = ["README.md", "README", "readme.md"] as const;
const MAX_TOP_LEVEL = 40;
const MAX_NOTABLE = 16;
const MAX_README = 800;
const MAX_SCRIPTS = 12;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 240;
const GIT_TIMEOUT_MS = 8_000;
export const REPOSITORY_BRIEF_MAX_CHARS = 2_400;

/**
 * Best-effort snapshot of the working tree. Never throws; callers can always
 * inject a block without failing the Designer turn.
 */
export async function loadRepositoryEvidence(projectRoot: string): Promise<string> {
  try {
    return formatRepositoryBrief(await buildRepositoryBrief(projectRoot));
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}

export async function buildRepositoryBrief(projectRoot: string): Promise<RepositoryBrief> {
  const root = await assertRepositoryOwnedPath(projectRoot, resolve(projectRoot));
  const [topLevel, manifests, readmeExcerpt, notablePaths, git] = await Promise.all([
    listTopLevel(projectRoot, root),
    readManifests(projectRoot),
    readReadmeExcerpt(projectRoot),
    listNotablePaths(projectRoot),
    readGitFacts(projectRoot).catch(() => undefined),
  ]);
  const hasProductLayout = PRODUCT_LAYOUT.some((name) => notablePaths.includes(`${name}/`));
  const trackedFileCount = git?.trackedFileCount ?? filesystemFileHint(topLevel, manifests, readmeExcerpt);
  return {
    posture: classifyPosture({
      trackedFileCount,
      hasProductLayout,
      hasManifest: manifests.length > 0,
    }),
    ...(git?.branch ? { branch: git.branch } : {}),
    ...(git?.headSubject ? { headSubject: git.headSubject } : {}),
    trackedFileCount,
    topLevel,
    manifests,
    ...(readmeExcerpt ? { readmeExcerpt } : {}),
    notablePaths,
  };
}

export function formatRepositoryBrief(brief: RepositoryBrief): string {
  const payload: RepositoryBrief = {
    ...brief,
    manifests: brief.manifests.map((manifest) => ({ ...manifest })),
    topLevel: [...brief.topLevel],
    notablePaths: [...brief.notablePaths],
  };
  for (const shrink of [
    () => {
      delete payload.readmeExcerpt;
    },
    () => {
      payload.manifests = payload.manifests.map(({ path, name, description }) => ({
        path,
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
      }));
    },
    () => {
      payload.topLevel = payload.topLevel.slice(0, 8);
      payload.notablePaths = payload.notablePaths.slice(0, 6);
    },
    () => {
      payload.topLevel = [];
      payload.notablePaths = [];
      payload.manifests = payload.manifests.map(({ path, name }) => ({
        path,
        ...(name ? { name } : {}),
      }));
    },
  ]) {
    const text = JSON.stringify(payload);
    if (text.length <= REPOSITORY_BRIEF_MAX_CHARS) return text;
    shrink();
  }
  return JSON.stringify({
    posture: payload.posture,
    trackedFileCount: payload.trackedFileCount,
    ...(payload.branch ? { branch: payload.branch } : {}),
  }).slice(0, REPOSITORY_BRIEF_MAX_CHARS);
}

function classifyPosture(input: {
  trackedFileCount: number;
  hasProductLayout: boolean;
  hasManifest: boolean;
}): RepositoryPosture {
  if (input.trackedFileCount <= 0 && !input.hasProductLayout && !input.hasManifest) return "empty";
  if (input.hasProductLayout || input.hasManifest) return "existing-product";
  return "sparse";
}

function filesystemFileHint(
  topLevel: string[],
  manifests: RepositoryManifest[],
  readmeExcerpt: string | undefined,
): number {
  return Math.max(topLevel.length, manifests.length + (readmeExcerpt ? 1 : 0));
}

async function listTopLevel(projectRoot: string, root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (names.length >= MAX_TOP_LEVEL) break;
    if (SKIP_TOP_LEVEL.has(entry.name) || entry.isSymbolicLink()) continue;
    try {
      await assertRepositoryOwnedPath(projectRoot, join(root, entry.name));
    } catch {
      continue;
    }
    names.push(entry.name);
  }
  return names.sort((left, right) => left.localeCompare(right));
}

async function listNotablePaths(projectRoot: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of NOTABLE_DIRECTORIES) {
    if (found.length >= MAX_NOTABLE) break;
    if (await isOwnedDirectory(projectRoot, name)) found.push(`${name}/`);
  }
  return found;
}

async function readManifests(projectRoot: string): Promise<RepositoryManifest[]> {
  const manifests: RepositoryManifest[] = [];
  const packageJson = await readOwnedText(projectRoot, "package.json", 8_000);
  if (packageJson) {
    const parsed = parsePackageJson(packageJson);
    if (parsed) manifests.push(parsed);
  }
  const pyproject = await readOwnedText(projectRoot, "pyproject.toml", 8_000);
  if (pyproject) manifests.push(parseTomlManifest("pyproject.toml", pyproject));
  const cargo = await readOwnedText(projectRoot, "Cargo.toml", 8_000);
  if (cargo) manifests.push(parseTomlManifest("Cargo.toml", cargo));
  const goMod = await readOwnedText(projectRoot, "go.mod", 2_000);
  if (goMod) {
    const moduleName = goMod.match(/^module\s+(\S+)/m)?.[1];
    manifests.push({
      path: "go.mod",
      ...(moduleName ? { name: untrustedField(moduleName, MAX_NAME) } : {}),
    });
  }
  return manifests;
}

function parsePackageJson(source: string): RepositoryManifest | undefined {
  try {
    const parsed = JSON.parse(source) as {
      name?: unknown;
      description?: unknown;
      scripts?: unknown;
    };
    const scripts = parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? Object.keys(parsed.scripts).slice(0, MAX_SCRIPTS)
      : undefined;
    return {
      path: "package.json",
      ...(typeof parsed.name === "string" ? { name: untrustedField(parsed.name, MAX_NAME) } : {}),
      ...(typeof parsed.description === "string"
        ? { description: untrustedField(parsed.description, MAX_DESCRIPTION) }
        : {}),
      ...(scripts?.length ? { scripts } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseTomlManifest(path: string, source: string): RepositoryManifest {
  const name = tomlStringField(source, "name");
  const description = tomlStringField(source, "description");
  return {
    path,
    ...(name ? { name: untrustedField(name, MAX_NAME) } : {}),
    ...(description ? { description: untrustedField(description, MAX_DESCRIPTION) } : {}),
  };
}

function tomlStringField(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`, "m"));
  const value = match?.[1] ?? match?.[2];
  return value?.trim() || undefined;
}

async function readReadmeExcerpt(projectRoot: string): Promise<string | undefined> {
  for (const candidate of README_CANDIDATES) {
    const text = await readOwnedText(projectRoot, candidate, MAX_README * 2);
    if (text) return untrustedMultiline(text, MAX_README);
  }
  return undefined;
}

async function readGitFacts(projectRoot: string): Promise<{
  branch?: string;
  headSubject?: string;
  trackedFileCount: number;
}> {
  const [branchResult, subjectResult, filesResult] = await Promise.all([
    runFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], projectRoot, { timeoutMs: GIT_TIMEOUT_MS }),
    runFile("git", ["log", "-1", "--pretty=%s"], projectRoot, { timeoutMs: GIT_TIMEOUT_MS }),
    runFile("git", ["ls-files", "--cached", "-z"], projectRoot, { timeoutMs: GIT_TIMEOUT_MS }),
  ]);
  const tracked = filesResult.stdout.split("\0").filter((path) => path && !isOrchestrationPath(path));
  const branch = untrustedField(branchResult.stdout, 80);
  const headSubject = untrustedField(subjectResult.stdout, 120);
  return {
    ...(branch ? { branch } : {}),
    ...(headSubject ? { headSubject } : {}),
    trackedFileCount: tracked.length,
  };
}

function isOrchestrationPath(path: string): boolean {
  return path === ".intentum" || path.startsWith(".intentum/");
}

async function isOwnedDirectory(projectRoot: string, relativePath: string): Promise<boolean> {
  try {
    const target = await assertRepositoryOwnedPath(projectRoot, join(projectRoot, relativePath));
    const metadata = await lstat(target);
    return metadata.isDirectory();
  } catch {
    return false;
  }
}

async function readOwnedText(projectRoot: string, relativePath: string, maxBytes: number): Promise<string | undefined> {
  try {
    const target = await assertRepositoryOwnedPath(projectRoot, join(projectRoot, relativePath));
    const metadata = await lstat(target);
    if (!metadata.isFile()) return undefined;
    const content = await readFile(target, "utf8");
    return content.length <= maxBytes ? content : content.slice(0, maxBytes);
  } catch {
    return undefined;
  }
}

function untrustedField(value: string, maximum: number): string {
  const singleLine = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return singleLine.length <= maximum ? singleLine : `${singleLine.slice(0, maximum - 1)}…`;
}

function untrustedMultiline(value: string, maximum: number): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}
