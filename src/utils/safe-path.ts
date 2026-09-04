import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolve a repository-owned path while rejecting every symlink component. */
export async function assertRepositoryOwnedPath(projectRoot: string, target: string): Promise<string> {
  const lexicalRoot = resolve(projectRoot);
  const lexicalTarget = resolve(target);
  const canonicalRoot = await realpath(lexicalRoot);
  // Callers pass both lexical paths and paths this function already
  // canonicalized (e.g. `${safeStatePath}.lock`). On macOS the project root
  // itself may sit under a symlinked prefix (/var -> /private/var), so accept
  // the target relative to either spelling of the root.
  let rel = relative(lexicalRoot, lexicalTarget);
  if (escapesRoot(rel)) rel = relative(canonicalRoot, lexicalTarget);
  if (escapesRoot(rel)) {
    throw new Error(`Intentum controller path escapes the project root: ${lexicalTarget}`);
  }
  const canonicalTarget = resolve(canonicalRoot, rel);
  let cursor = canonicalRoot;
  for (const component of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Intentum controller path contains a symbolic link: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return canonicalTarget;
}

function escapesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export async function ensureRepositoryOwnedDirectory(projectRoot: string, target: string): Promise<string> {
  const safePath = await assertRepositoryOwnedPath(projectRoot, target);
  await mkdir(safePath, { recursive: true });
  const checked = await assertRepositoryOwnedPath(projectRoot, target);
  const metadata = await lstat(checked);
  if (!metadata.isDirectory()) throw new Error(`Intentum controller directory is not a directory: ${checked}`);
  return checked;
}

/**
 * Repository-relative directories the Worker must never create, mutate, or
 * commit. `.intentum` is controller state; `.pi` configures Pi itself, and a
 * committed `.pi/extensions/*` would run as host code in the next
 * project-trusted Pi session.
 */
export const CONTROLLER_OWNED_REPOSITORY_PATHS = [".intentum", ".pi"] as const;

/** True when a repository-relative path is, or sits inside, a controller-owned directory. */
export function isControllerOwnedRepositoryPath(file: string): boolean {
  return CONTROLLER_OWNED_REPOSITORY_PATHS.some((owned) => file === owned || file.startsWith(`${owned}/`));
}
