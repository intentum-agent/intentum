import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertSafeId } from "../utils/ids.js";
import { withFileLock } from "../utils/file-lock.js";
import { assertRepositoryOwnedPath, ensureRepositoryOwnedDirectory } from "../utils/safe-path.js";

export interface WorkContract {
  id: string;
  featureId: string;
  title: string;
  objective: string;
  why: string;
  userVisibleResult: string;
  scope: {
    inScope: string[];
    outOfScope: string[];
  };
  interfaces: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  touchHints: string[];
  risk: "low" | "medium" | "high";
  preferredWorkerKind: "implementation" | "fix" | "integration";
  contextFiles: string[];
}

export function assertWorkContract(contract: WorkContract): void {
  if (!contract || typeof contract !== "object") throw new Error("WorkContract must be an object");
  assertSafeId(contract.id, "work id");
  assertSafeId(contract.featureId, "feature id");
  for (const [name, value] of [
    ["title", contract.title],
    ["objective", contract.objective],
    ["why", contract.why],
    ["userVisibleResult", contract.userVisibleResult],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`WorkContract ${name} must not be empty`);
  }
  for (const [name, value, requireNonEmpty] of [
    ["scope.inScope", contract.scope?.inScope, false],
    ["scope.outOfScope", contract.scope?.outOfScope, false],
    ["interfaces", contract.interfaces, false],
    ["constraints", contract.constraints, false],
    ["acceptanceCriteria", contract.acceptanceCriteria, true],
    ["dependencies", contract.dependencies, false],
    ["touchHints", contract.touchHints, false],
    ["contextFiles", contract.contextFiles, false],
  ] as const) {
    if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)
      || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`WorkContract ${name} must be ${requireNonEmpty ? "a non-empty" : "an"} array of non-empty strings`);
    }
  }
  if (!(["low", "medium", "high"] as const).includes(contract.risk)) {
    throw new Error(`invalid WorkContract risk: ${contract.risk}`);
  }
  if (!(["implementation", "fix", "integration"] as const).includes(contract.preferredWorkerKind)) {
    throw new Error(`invalid WorkContract preferredWorkerKind: ${String(contract.preferredWorkerKind)}`);
  }
}

interface WorkFile {
  schemaVersion: 1;
  work: WorkContract[];
}

// Pi can rebuild the extension runtime while an older lifecycle is unwinding.
// Coordinate every read-modify-write by canonical artifact path so those
// generations cannot overwrite each other's contracts.
const contractMutationTails = new Map<string, Promise<void>>();

export class WorkContractStore {
  constructor(private readonly projectRoot: string) {}

  async save(contract: WorkContract): Promise<void> {
    assertWorkContract(contract);
    const path = await assertRepositoryOwnedPath(this.projectRoot, this.pathFor(contract.featureId));
    await assertRepositoryOwnedPath(this.projectRoot, `${path}.lock`);
    await withContractMutationLock(path, async () => {
      await ensureRepositoryOwnedDirectory(this.projectRoot, dirname(path));
      const current = await this.readFile(contract.featureId);
      const existing = current.work.find((item) => item.id === contract.id);
      if (existing) throw new Error(`WorkContract already exists: ${contract.id}`);
      current.work.push(structuredClone(contract));
      await writeJsonAtomic(path, current);
    });
  }

  async get(featureId: string, workId: string): Promise<WorkContract> {
    assertSafeId(featureId, "feature id");
    assertSafeId(workId, "work id");
    const item = (await this.readFile(featureId)).work.find((contract) => contract.id === workId);
    if (!item) throw new Error(`unknown WorkContract: ${workId}`);
    return structuredClone(item);
  }

  private pathFor(featureId: string): string {
    assertSafeId(featureId, "feature id");
    return join(this.projectRoot, ".intentum", "features", featureId, "work.json");
  }

  private async readFile(featureId: string): Promise<WorkFile> {
    const path = await assertRepositoryOwnedPath(this.projectRoot, this.pathFor(featureId));
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as WorkFile;
      if (value.schemaVersion !== 1 || !Array.isArray(value.work)) {
        throw new Error(`unsupported WorkContract file: ${path}`);
      }
      const ids = new Set<string>();
      for (const contract of value.work) {
        assertWorkContract(contract);
        if (ids.has(contract.id)) throw new Error(`duplicate WorkContract in ${path}: ${contract.id}`);
        ids.add(contract.id);
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, work: [] };
      throw error;
    }
  }
}

function withContractMutationLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = contractMutationTails.get(path) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => withFileLock(`${path}.lock`, operation));
  const tail = result.then(() => undefined, () => undefined);
  contractMutationTails.set(path, tail);
  void tail.then(() => {
    if (contractMutationTails.get(path) === tail) contractMutationTails.delete(path);
  });
  return result;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
