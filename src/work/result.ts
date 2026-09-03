export interface TestRunSummary {
  command: string;
  status: "passed" | "failed" | "not_run";
  exitCode?: number;
  durationMs?: number;
  summary: string;
}

export interface WorkerResultInput {
  status: "completed" | "blocked" | "failed";
  summary: string;
  userVisibleChanges: string[];
  filesChanged: string[];
  testsRun: TestRunSummary[];
  architectureConcerns: string[];
  remainingRisks: string[];
  suggestedFollowUps: string[];
}

export interface WorkerResult extends WorkerResultInput {
  workId: string;
  attemptId: string;
  resultCommit?: string;
  recordedAt: string;
}

const RESULT_INPUT_KEYS = new Set([
  "status",
  "summary",
  "userVisibleChanges",
  "filesChanged",
  "testsRun",
  "architectureConcerns",
  "remainingRisks",
  "suggestedFollowUps",
]);

export function assertWorkerResultInput(value: unknown): asserts value is WorkerResultInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker result must be an object");
  }
  assertExactKeys(value, RESULT_INPUT_KEYS, "Worker result");
  const result = value as Partial<WorkerResultInput>;
  if (result.status !== "completed" && result.status !== "blocked" && result.status !== "failed") {
    throw new Error(`invalid Worker result status: ${String(result.status)}`);
  }
  assertBoundedString(result.summary, "Worker result summary", 4_000);
  assertStringArray(result.userVisibleChanges, "Worker result userVisibleChanges", 100, 2_000);
  assertStringArray(result.filesChanged, "Worker result filesChanged", 1_000, 1_000);
  assertStringArray(result.architectureConcerns, "Worker result architectureConcerns", 100, 2_000);
  assertStringArray(result.remainingRisks, "Worker result remainingRisks", 100, 2_000);
  assertStringArray(result.suggestedFollowUps, "Worker result suggestedFollowUps", 100, 2_000);
  if (!Array.isArray(result.testsRun) || result.testsRun.length > 100) {
    throw new Error("Worker result testsRun must be an array with at most 100 entries");
  }
  for (const [index, test] of result.testsRun.entries()) {
    if (!test || typeof test !== "object" || Array.isArray(test)) {
      throw new Error(`Worker result test ${index} must be an object`);
    }
    assertExactKeys(test, new Set(["command", "status", "exitCode", "durationMs", "summary"]), `Worker result test ${index}`);
    assertBoundedString(test.command, `Worker result test ${index} command`, 4_000);
    assertBoundedString(test.summary, `Worker result test ${index} summary`, 4_000);
    if (test.status !== "passed" && test.status !== "failed" && test.status !== "not_run") {
      throw new Error(`invalid Worker result test ${index} status: ${String(test.status)}`);
    }
    if (test.exitCode !== undefined && !Number.isInteger(test.exitCode)) {
      throw new Error(`Worker result test ${index} exitCode must be an integer`);
    }
    if (test.durationMs !== undefined && (!Number.isFinite(test.durationMs) || test.durationMs < 0)) {
      throw new Error(`Worker result test ${index} durationMs must be a non-negative number`);
    }
  }
}

export function assertWorkerResult(value: unknown): asserts value is WorkerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stored Worker result must be an object");
  const storedKeys = new Set([...RESULT_INPUT_KEYS, "workId", "attemptId", "resultCommit", "recordedAt"]);
  assertExactKeys(value, storedKeys, "stored Worker result");
  const stored = value as Partial<WorkerResult>;
  const input = Object.fromEntries(
    Object.entries(value).filter(([key]) => RESULT_INPUT_KEYS.has(key)),
  );
  assertWorkerResultInput(input);
  assertBoundedString(stored.workId, "stored Worker result workId", 128);
  assertBoundedString(stored.attemptId, "stored Worker result attemptId", 128);
  assertBoundedString(stored.recordedAt, "stored Worker result recordedAt", 128);
  if (Number.isNaN(Date.parse(stored.recordedAt)) || new Date(stored.recordedAt).toISOString() !== stored.recordedAt) {
    throw new Error("stored Worker result recordedAt must be a canonical ISO timestamp");
  }
  if (stored.resultCommit !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(stored.resultCommit)) {
    throw new Error("stored Worker result resultCommit must be a Git object id");
  }
  if (stored.status === "completed" && stored.resultCommit === undefined) {
    throw new Error("stored completed Worker result requires resultCommit");
  }
  if (stored.status !== "completed" && stored.resultCommit !== undefined) {
    throw new Error(`stored ${stored.status} Worker result cannot contain resultCommit`);
  }
}

function assertExactKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unexpected field(s): ${unexpected.join(", ")}`);
}

function assertBoundedString(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string with at most ${maximum} characters`);
  }
}

function assertStringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} must be an array with at most ${maximumItems} entries`);
  }
  for (const item of value) assertBoundedString(item, `${label} entry`, maximumLength);
}
