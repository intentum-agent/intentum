import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolve a repository-owned path while rejecting every symlink component. */
export async function assertRepositoryOwnedPath(projectRoot: string, target: string): Promise<string> {
  const lexicalRoot = resolve(projectRoot);
  const lexicalTarget = resolve(target);
  const rel = relative(lexicalRoot, lexicalTarget);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Intentum controller path escapes the project root: ${lexicalTarget}`);
  }
  const canonicalRoot = await realpath(lexicalRoot);
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

export async function ensureRepositoryOwnedDirectory(projectRoot: string, target: string): Promise<string> {
  const safePath = await assertRepositoryOwnedPath(projectRoot, target);
  await mkdir(safePath, { recursive: true });
  const checked = await assertRepositoryOwnedPath(projectRoot, target);
  const metadata = await lstat(checked);
  if (!metadata.isDirectory()) throw new Error(`Intentum controller directory is not a directory: ${checked}`);
  return checked;
}
