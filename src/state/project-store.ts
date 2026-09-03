import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Autonomy, ProjectState } from "./schema.js";
import { assertProjectState } from "./schema.js";
import { withFileLock } from "../utils/file-lock.js";
import { assertRepositoryOwnedPath, ensureRepositoryOwnedDirectory } from "../utils/safe-path.js";

const CHARTER_TEMPLATE = `# Product Charter

## Target users

【To be established with the user】

## Primary outcome

【To be established with the user】

## Success criteria

【To be established with the user】

## Non-goals

【To be established with the user】
`;

const ARCHITECTURE_TEMPLATE = `# Current Approved Architecture Direction

## Context

【To be established during discovery】

## Direction

【Not approved yet】

## Constraints and trade-offs

【To be established during discovery】
`;

export type ProjectArtifact = "charter" | "architecture";

export interface InitializeProjectOptions {
  projectName?: string;
  projectId?: string;
  autonomy?: Autonomy;
  now?: string;
}

// All ProjectStore instances in this process coordinate on the canonical
// state path. Intentum can construct a fresh runtime during Pi session reload,
// and instance-local queues would otherwise race through the same state.json.
const stateMutationTails = new Map<string, Promise<void>>();

export class ProjectStore {
  readonly projectRoot: string;
  readonly stateDir: string;
  readonly statePath: string;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    this.stateDir = join(this.projectRoot, ".intentum");
    this.statePath = join(this.stateDir, "state.json");
  }

  async exists(): Promise<boolean> {
    try {
      await access(await assertRepositoryOwnedPath(this.projectRoot, this.statePath));
      return true;
    } catch {
      return false;
    }
  }

  async initialize(options: InitializeProjectOptions = {}): Promise<{ state: ProjectState; created: boolean }> {
    return withStateMutationQueue(this.statePath, async () => {
      await ensureRepositoryOwnedDirectory(this.projectRoot, this.stateDir);
      const safeStatePath = await assertRepositoryOwnedPath(this.projectRoot, this.statePath);
      const lockPath = await assertRepositoryOwnedPath(this.projectRoot, `${safeStatePath}.lock`);
      return withFileLock(lockPath, async () => {
        if (await this.exists()) {
          const state = await this.read();
          await this.ensureArtifacts();
          return { state, created: false };
        }

        const now = options.now ?? new Date().toISOString();
        const name = options.projectName?.trim() || basename(this.projectRoot);
        if (name.length > 120) throw new Error("intentum project name must be 120 characters or fewer");
        const state: ProjectState = {
          schemaVersion: 1,
          projectId: options.projectId ?? `intentum-${randomUUID()}`,
          projectName: name,
          phase: "discovery",
          autonomy: options.autonomy ?? "guided",
          workers: {},
          pendingDecisions: [],
          schedulerPaused: false,
          updatedAt: now,
        };

        await this.writeAtomic(state);
        await this.ensureArtifacts();
        return { state, created: true };
      });
    });
  }

  async read(): Promise<ProjectState> {
    const safeStatePath = await assertRepositoryOwnedPath(this.projectRoot, this.statePath);
    const raw = await readFile(safeStatePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`invalid JSON in ${this.statePath}`, { cause: error });
    }
    assertProjectState(parsed);
    return structuredClone(parsed);
  }

  async update(updater: (state: ProjectState) => ProjectState | Promise<ProjectState>): Promise<ProjectState> {
    return withStateMutationQueue(this.statePath, async () => {
      await ensureRepositoryOwnedDirectory(this.projectRoot, this.stateDir);
      const safeStatePath = await assertRepositoryOwnedPath(this.projectRoot, this.statePath);
      const lockPath = await assertRepositoryOwnedPath(this.projectRoot, `${safeStatePath}.lock`);
      return withFileLock(lockPath, async () => {
        const current = await this.read();
        const next = await updater(structuredClone(current));
        next.updatedAt = new Date().toISOString();
        assertProjectState(next);
        await this.writeAtomic(next);
        return structuredClone(next);
      });
    });
  }

  async readArtifact(artifact: ProjectArtifact): Promise<string> {
    return readFile(await assertRepositoryOwnedPath(this.projectRoot, this.artifactPath(artifact)), "utf8");
  }

  async writeArtifact(artifact: ProjectArtifact, content: string): Promise<void> {
    if (!content.trim()) throw new Error(`${artifact} artifact must not be empty`);
    await ensureRepositoryOwnedDirectory(this.projectRoot, this.stateDir);
    const target = await assertRepositoryOwnedPath(this.projectRoot, this.artifactPath(artifact));
    await assertRepositoryOwnedPath(this.projectRoot, `${target}.lock`);
    await withFileLock(`${target}.lock`, async () => {
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, content.endsWith("\n") ? content : `${content}\n`, "utf8");
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  private artifactPath(artifact: ProjectArtifact): string {
    return join(this.stateDir, `${artifact}.md`);
  }

  async ensureArtifacts(): Promise<void> {
    await ensureRepositoryOwnedDirectory(this.projectRoot, this.stateDir);
    await this.writeIfMissing(await assertRepositoryOwnedPath(this.projectRoot, this.artifactPath("charter")), CHARTER_TEMPLATE);
    await this.writeIfMissing(await assertRepositoryOwnedPath(this.projectRoot, this.artifactPath("architecture")), ARCHITECTURE_TEMPLATE);
  }

  private async writeIfMissing(path: string, content: string): Promise<void> {
    try {
      await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private async writeAtomic(state: ProjectState): Promise<void> {
    await ensureRepositoryOwnedDirectory(this.projectRoot, this.stateDir);
    const statePath = await assertRepositoryOwnedPath(this.projectRoot, this.statePath);
    const temp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temp, statePath);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function withStateMutationQueue<T>(statePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = stateMutationTails.get(statePath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  stateMutationTails.set(statePath, tail);
  void tail.then(() => {
    if (stateMutationTails.get(statePath) === tail) stateMutationTails.delete(statePath);
  });
  return result;
}
