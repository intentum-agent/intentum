import { describe, expect, it } from "vitest";
import { countWorkingTree } from "../src/git/status.js";

describe("working-tree counts for the footer", () => {
  it("counts staged and unstaged columns independently, untracked once, and skips ignored", () => {
    const porcelain = [
      "M  staged.ts",
      " M unstaged.ts",
      "MM both.ts",
      "A  added.ts",
      "R  old.ts -> new.ts",
      " D deleted.ts",
      "?? new-file.ts",
      "?? dir/other.ts",
      "!! ignored.log",
      "",
    ].join("\n");
    expect(countWorkingTree(porcelain)).toEqual({ staged: 4, unstaged: 3, untracked: 2 });
    expect(countWorkingTree("")).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
  });
});
