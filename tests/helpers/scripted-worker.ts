import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CreateWorkerRuntimeInput,
  RestoreWorkerRuntimeInput,
  WorkerEventListener,
  WorkerRuntime,
  WorkerRuntimeEvent,
  WorkerRuntimeFactory,
} from "../../src/runtime/worker-runtime.js";

export class ScriptedWorkerRuntime implements WorkerRuntime {
  readonly prompts: string[] = [];
  readonly steering: string[] = [];
  readonly followUps: string[] = [];
  aborted = false;
  disposed = false;
  private readonly listeners = new Set<WorkerEventListener>();

  constructor(
    readonly id: string,
    readonly sessionRef: string,
  ) {}

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }

  async steer(text: string): Promise<void> {
    this.steering.push(text);
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async waitForIdle(): Promise<void> {}

  dispose(): void {
    this.disposed = true;
  }

  subscribe(listener: WorkerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: WorkerRuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export class ScriptedWorkerFactory implements WorkerRuntimeFactory {
  readonly creates: CreateWorkerRuntimeInput[] = [];
  readonly restores: RestoreWorkerRuntimeInput[] = [];
  readonly runtimes = new Map<string, ScriptedWorkerRuntime>();

  async create(input: CreateWorkerRuntimeInput): Promise<WorkerRuntime> {
    this.creates.push(input);
    const sessionRef = join(input.worktreePath, "..", `${input.workerId}.scripted-session.jsonl`);
    await writeFile(sessionRef, `${JSON.stringify({ type: "session", id: input.workerId })}\n`, "utf8");
    const runtime = new ScriptedWorkerRuntime(input.workerId, sessionRef);
    this.runtimes.set(input.workerId, runtime);
    return runtime;
  }

  async restore(input: RestoreWorkerRuntimeInput): Promise<WorkerRuntime> {
    this.restores.push(input);
    const runtime = new ScriptedWorkerRuntime(input.workerId, input.sessionRef);
    this.runtimes.set(input.workerId, runtime);
    return runtime;
  }
}
