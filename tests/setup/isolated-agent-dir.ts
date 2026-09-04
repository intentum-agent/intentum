import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Pi resolves its user configuration — default model, provider credentials,
 * session store — from PI_CODING_AGENT_DIR, falling back to `~/.pi/agent`.
 * Tests that construct a real Pi session must not read the developer's own
 * settings: a configured default model silently turns "no model is
 * resolvable" assertions into a different, passing code path, and session
 * files would be written into the developer's home directory.
 *
 * Point every test worker at an empty, per-process directory instead.
 */
const agentDir = join(tmpdir(), "intentum-vitest-agent", String(process.pid));
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => {
  rmSync(agentDir, { recursive: true, force: true });
});

/**
 * Without a preset the glyph tables follow Nerd Font detection, and the brand
 * mark would differ between developer machines and CI, or follow the shell's
 * own INTENTUM_SYMBOLS. Tests that exercise detection or another preset pass
 * their own environment objects or stub the variable.
 */
process.env.INTENTUM_SYMBOLS = "unicode";
