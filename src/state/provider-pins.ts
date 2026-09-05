import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "../utils/file-lock.js";

/** Personal provider pins live in Pi's agent directory, outside project state. */
export class ProviderPinStore {
  constructor(private readonly path: string) {}

  async load(initial: readonly string[] = []): Promise<string[]> {
    const saved = await this.read();
    if (saved) return saved;
    return this.update((pins) => pins ?? [...new Set(initial)].slice(0, 3));
  }

  async setPinned(key: string, pinned: boolean): Promise<string[]> {
    return this.update((saved) => {
      const pins = new Set(saved ?? []);
      if (pinned) pins.add(key);
      else pins.delete(key);
      return [...pins];
    });
  }

  private async read(): Promise<string[] | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!value || typeof value !== "object" || !("pins" in value) || !Array.isArray(value.pins)
        || !value.pins.every((key) => typeof key === "string")) throw new Error("Invalid provider pins file");
      return [...new Set(value.pins as string[])];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async update(change: (saved: string[] | undefined) => string[]): Promise<string[]> {
    return withFileLock(`${this.path}.lock`, async () => {
      const pins = change(await this.read());
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, pins }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      return pins;
    });
  }
}
