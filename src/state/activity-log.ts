import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertRepositoryOwnedPath, ensureRepositoryOwnedDirectory } from "../utils/safe-path.js";

export interface ActivityEvent {
  time: string;
  type: string;
  [key: string]: unknown;
}

export class ActivityLog {
  readonly path: string;
  private appendTail: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.path = join(projectRoot, ".intentum", "activity.jsonl");
    this.projectRoot = projectRoot;
  }

  private readonly projectRoot: string;

  append(event: { type: string; time?: string; [key: string]: unknown }): Promise<void> {
    const operation = this.appendTail.then(async () => {
      await ensureRepositoryOwnedDirectory(this.projectRoot, dirname(this.path));
      const safePath = await assertRepositoryOwnedPath(this.projectRoot, this.path);
      const entry = {
        ...event,
        time: event.time ?? new Date().toISOString(),
      } satisfies ActivityEvent;
      await appendFile(safePath, `${JSON.stringify(entry)}\n`, "utf8");
    });

    // Activity history is diagnostic only: a logging failure must not fail the
    // canonical state transition that requested it. Keep the swallowed promise
    // as the tail so later appends remain ordered and a failed write does not
    // poison the queue.
    const bestEffortOperation = operation.catch(() => undefined);
    this.appendTail = bestEffortOperation;
    return bestEffortOperation;
  }
}
