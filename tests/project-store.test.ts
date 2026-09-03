import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { transitionProject } from "../src/controller/lifecycle.js";
import { ProjectStore } from "../src/state/project-store.js";
import { IntentumRuntime } from "../src/runtime/intentum-runtime.js";
import { ScriptedWorkerFactory } from "./helpers/scripted-worker.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTempRepository } from "./helpers/temp-repo.js";

describe("ProjectStore", () => {
  it("initializes idempotently without overwriting product artifacts", async () => {
    const fixture = await createTempRepository();
    try {
      const store = new ProjectStore(fixture.repo);
      const first = await store.initialize({ projectName: "Fixture Product", projectId: "fixture-product" });
      expect(first.created).toBe(true);
      expect(first.state).toMatchObject({
        schemaVersion: 1,
        projectName: "Fixture Product",
        phase: "discovery",
        autonomy: "guided",
        schedulerPaused: false,
      });

      await store.writeArtifact("charter", "# Deliberate Charter\n");
      const second = await store.initialize({ projectName: "Ignored Name" });
      expect(second.created).toBe(false);
      expect(second.state.projectName).toBe("Fixture Product");
      expect(await store.readArtifact("charter")).toBe("# Deliberate Charter\n");
      expect(await readFile(join(fixture.repo, ".intentum", "architecture.md"), "utf8")).toContain(
        "Current Approved Architecture Direction",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes concurrent updates instead of losing state", async () => {
    const fixture = await createTempRepository();
    try {
      const store = new ProjectStore(fixture.repo);
      await store.initialize({ projectName: "P", projectId: "p" });
      await Promise.all([
        store.update(async (state) => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return { ...state, projectName: `${state.projectName}A` };
        }),
        store.update((state) => ({ ...state, projectName: `${state.projectName}B` })),
      ]);
      expect((await store.read()).projectName).toBe("PAB");
      await expect(readFile(`${store.statePath}.tmp`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes mutations across separate ProjectStore instances", async () => {
    const fixture = await createTempRepository();
    try {
      const first = new ProjectStore(fixture.repo);
      const second = new ProjectStore(fixture.repo);
      await first.initialize({ projectName: "P", projectId: "p" });
      await Promise.all([
        first.update(async (state) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ...state, projectName: `${state.projectName}A` };
        }),
        second.update((state) => ({ ...state, projectName: `${state.projectName}B` })),
      ]);
      expect((await first.read()).projectName).toBe("PAB");
    } finally {
      await fixture.cleanup();
    }
  });

  it("repairs missing initialization artifacts on session start without overwriting survivors", async () => {
    const fixture = await createTempRepository();
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(), projectTrusted: true,
    });
    try {
      await runtime.initialize();
      await runtime.store.writeArtifact("charter", "# Surviving Charter\n");
      await rm(join(fixture.repo, ".intentum", "architecture.md"));
      await runtime.dispose();

      await runtime.onSessionStart({
        cwd: fixture.repo,
        ui: { setWidget() {}, setStatus() {} },
        isProjectTrusted: () => true,
      } as unknown as ExtensionContext);
      expect(await runtime.store.readArtifact("charter")).toBe("# Surviving Charter\n");
      expect(await runtime.store.readArtifact("architecture")).toContain("Current Approved Architecture Direction");
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });

  it("reports corrupt state without replacing it", async () => {
    const fixture = await createTempRepository();
    try {
      const store = new ProjectStore(fixture.repo);
      await store.initialize({ projectId: "p" });
      await writeFile(store.statePath, "{broken", "utf8");
      await expect(store.read()).rejects.toThrow(`invalid JSON in ${store.statePath}`);
      expect(await readFile(store.statePath, "utf8")).toBe("{broken");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a structurally invalid Worker record in otherwise valid JSON", async () => {
    const fixture = await createTempRepository();
    try {
      const store = new ProjectStore(fixture.repo);
      const state = (await store.initialize({ projectId: "p" })).state;
      await writeFile(store.statePath, `${JSON.stringify({
        ...state,
        workers: {
          "W-001": {
            id: "W-001",
            kind: "microtask",
            status: "working",
            objective: "bad durable record",
            pendingInstructions: "not-an-array",
            updatedAt: new Date().toISOString(),
          },
        },
      })}\n`, "utf8");
      await expect(store.read()).rejects.toThrow("invalid Worker kind");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a repository .intentum symlink before creating any outside lock or artifact", async () => {
    const fixture = await createTempRepository();
    const outside = join(fixture.root, "outside-controller-state");
    await mkdir(outside);
    await symlink(outside, join(fixture.repo, ".intentum"));
    const runtime = new IntentumRuntime(fixture.repo, {
      cacheRoot: fixture.cache,
      workerRuntimeFactory: new ScriptedWorkerFactory(),
      projectTrusted: true,
    });
    try {
      await expect(runtime.initialize()).rejects.toThrow("symbolic link");
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  });
});

describe("project lifecycle", () => {
  it("enforces transitions and resumes the persisted pre-pause phase", async () => {
    const fixture = await createTempRepository();
    try {
      const state = (await new ProjectStore(fixture.repo).initialize({ projectId: "p" })).state;
      const direction = transitionProject(state, "direction");
      const paused = transitionProject(direction, "paused");
      expect(paused).toMatchObject({ phase: "paused", phaseBeforePause: "direction", schedulerPaused: true });
      const resumed = transitionProject(paused, "direction");
      expect(resumed.phase).toBe("direction");
      expect(resumed.phaseBeforePause).toBeUndefined();
      expect(() => transitionProject(state, "build")).toThrow("discovery -> build");
    } finally {
      await fixture.cleanup();
    }
  });
});
