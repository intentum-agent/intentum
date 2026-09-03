import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { WorkContract } from "../work/contract.js";
import type { WorkerResultInput } from "../work/result.js";

export interface WorkerProgressInput {
  summary: string;
  state?: "working" | "paused";
  wipCommit?: string;
}

export interface WorkerEscalationInput {
  kind:
    | "blocker"
    | "architecture_concern"
    | "requirement_ambiguity"
    | "interface_conflict"
    | "destructive_change";
  summary: string;
}

export interface WorkerCommitInput {
  message: string;
}

export interface WorkerCommitResult {
  commit: string;
  files: string[];
}

export interface WorkerCallbacks {
  commit(input: WorkerCommitInput, signal?: AbortSignal): Promise<WorkerCommitResult>;
  progress(input: WorkerProgressInput): Promise<void>;
  escalate(input: WorkerEscalationInput): Promise<void>;
  complete(input: WorkerResultInput, signal?: AbortSignal): Promise<void>;
}

export type WorkerRuntimeEvent =
  | { type: "settled" }
  | { type: "turn_failed"; error: string }
  | { type: "session_ref_changed"; sessionRef: string };

export type WorkerEventListener = (event: WorkerRuntimeEvent) => void;

export class WorkerSessionUnavailableError extends Error {
  override readonly name = "WorkerSessionUnavailableError";
}

export class WorkerModelSelectionError extends Error {
  override readonly name = "WorkerModelSelectionError";
}

export interface WorkerRuntime {
  readonly id: string;
  readonly sessionRef: string | undefined;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void> | void;
  subscribe(listener: WorkerEventListener): () => void;
}

export interface CreateWorkerRuntimeInput {
  workerId: string;
  worktreePath: string;
  contract: WorkContract;
  callbacks: WorkerCallbacks;
}

export interface RestoreWorkerRuntimeInput extends CreateWorkerRuntimeInput {
  sessionRef: string;
}

export interface WorkerRuntimeFactory {
  create(input: CreateWorkerRuntimeInput): Promise<WorkerRuntime>;
  restore(input: RestoreWorkerRuntimeInput): Promise<WorkerRuntime>;
  setSessionDefaults?(defaults: {
    model?: CreateAgentSessionOptions["model"];
    thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
    projectTrusted?: boolean;
  }): void;
}
