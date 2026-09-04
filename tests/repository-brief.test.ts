import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRepositoryBrief,
  formatRepositoryBrief,
  loadRepositoryEvidence,
  REPOSITORY_BRIEF_MAX_CHARS,
} from "../src/runtime/repository-brief.js";
import { runFile } from "../src/utils/process.js";
import { createTempRepository } from "./helpers/temp-repo.js";

describe("repository brief", () => {
  it("classifies an existing product from README, package.json, and src/", async () => {
    const fixture = await createTempRepository();
    try {
      await writeFile(join(fixture.repo, "package.json"), `${JSON.stringify({
        name: "fixture-app",
        description: "A shipped product with users already in the tree.",
        scripts: { test: "vitest", build: "tsc" },
      }, null, 2)}\n`, "utf8");
      await mkdir(join(fixture.repo, "src"));
      await writeFile(join(fixture.repo, "src", "index.ts"), "export const ready = true;\n", "utf8");
      await runFile("git", ["add", "package.json", "src/index.ts"], fixture.repo);
      await runFile("git", ["commit", "-m", "feat: existing product"], fixture.repo);

      const brief = await buildRepositoryBrief(fixture.repo);
      expect(brief.posture).toBe("existing-product");
      expect(brief.branch).toBe("main");
      expect(brief.headSubject).toBe("feat: existing product");
      expect(brief.trackedFileCount).toBeGreaterThanOrEqual(3);
      expect(brief.topLevel).toEqual(expect.arrayContaining(["README.md", "package.json", "src"]));
      expect(brief.notablePaths).toContain("src/");
      expect(brief.readmeExcerpt).toContain("# Fixture");
      expect(brief.manifests).toEqual([expect.objectContaining({
        path: "package.json",
        name: "fixture-app",
        description: "A shipped product with users already in the tree.",
        scripts: ["test", "build"],
      })]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("classifies a README-only tree as sparse and an empty commit as empty", async () => {
    const sparse = await createTempRepository();
    const empty = await createTempRepository();
    try {
      expect((await buildRepositoryBrief(sparse.repo)).posture).toBe("sparse");

      await runFile("git", ["rm", "-f", "README.md"], empty.repo);
      await runFile("git", ["commit", "--allow-empty", "-m", "empty tree"], empty.repo);
      const brief = await buildRepositoryBrief(empty.repo);
      expect(brief.posture).toBe("empty");
      expect(brief.trackedFileCount).toBe(0);
      expect(brief.readmeExcerpt).toBeUndefined();
    } finally {
      await Promise.all([sparse.cleanup(), empty.cleanup()]);
    }
  });

  it("ignores node_modules and .intentum when listing the tree", async () => {
    const fixture = await createTempRepository();
    try {
      await mkdir(join(fixture.repo, "src"));
      await mkdir(join(fixture.repo, "node_modules", "fake-pkg"), { recursive: true });
      await mkdir(join(fixture.repo, ".intentum"));
      await writeFile(join(fixture.repo, "src", "app.ts"), "export {}\n", "utf8");
      await writeFile(join(fixture.repo, "node_modules", "fake-pkg", "index.js"), "module.exports = 1;\n", "utf8");
      await writeFile(join(fixture.repo, ".intentum", "charter.md"), "# Hidden\n", "utf8");
      await runFile("git", ["add", "src/app.ts"], fixture.repo);
      await runFile("git", ["commit", "-m", "feat: app"], fixture.repo);

      const brief = await buildRepositoryBrief(fixture.repo);
      expect(brief.topLevel).not.toContain("node_modules");
      expect(brief.topLevel).not.toContain(".intentum");
      expect(brief.notablePaths).toContain("src/");
      expect(brief.readmeExcerpt).not.toContain("Hidden");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects symlink components and keeps the rendered brief bounded", async () => {
    const fixture = await createTempRepository();
    try {
      const outside = join(fixture.root, "outside-secret.txt");
      await writeFile(outside, "SECRET_OUTSIDE\n", "utf8");
      await runFile("git", ["rm", "-f", "README.md"], fixture.repo);
      await symlink(outside, join(fixture.repo, "README.md"));
      await symlink(outside, join(fixture.repo, "src"));
      await writeFile(join(fixture.repo, "package.json"), `${JSON.stringify({
        name: "linked",
        description: "x".repeat(2_000),
        scripts: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`s${index}`, "true"])),
      })}\n`, "utf8");
      for (let index = 0; index < 50; index += 1) {
        await writeFile(join(fixture.repo, `file-${index}.txt`), "n\n", "utf8");
      }

      const brief = await buildRepositoryBrief(fixture.repo);
      expect(JSON.stringify(brief)).not.toContain("SECRET_OUTSIDE");
      expect(brief.readmeExcerpt).toBeUndefined();
      expect(brief.notablePaths).not.toContain("src/");
      expect(brief.topLevel).toHaveLength(40);
      expect(brief.manifests[0]?.scripts).toHaveLength(12);
      expect(brief.manifests[0]?.description?.length).toBeLessThanOrEqual(240);

      const rendered = formatRepositoryBrief({
        ...brief,
        readmeExcerpt: "R".repeat(REPOSITORY_BRIEF_MAX_CHARS),
        topLevel: Array.from({ length: 80 }, (_, index) => `extra-${index}`),
      });
      expect(rendered.length).toBeLessThanOrEqual(REPOSITORY_BRIEF_MAX_CHARS);
      expect(rendered).not.toContain("SECRET_OUTSIDE");
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns unavailable evidence instead of throwing when the tree cannot be read", async () => {
    await expect(loadRepositoryEvidence(join("/no-such-intentum-root", "missing"))).resolves.toBe(
      JSON.stringify({ unavailable: true }),
    );
  });
});
