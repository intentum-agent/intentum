import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep the developer's real ~/.pi/agent out of every test process.
    setupFiles: ["./tests/setup/isolated-agent-dir.ts"],
  },
});
