import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { IntentumRuntime } from "../runtime/intentum-runtime.js";

export type IntentumRuntimeSource = IntentumRuntime | (() => IntentumRuntime);

export function registerIntentumCommands(pi: ExtensionAPI, runtimeSource: IntentumRuntimeSource): void {
  pi.registerCommand("intentum", {
    description: "Initialize, inspect, pause, resume, steer, and integrate an intentum project",
    handler: async (rawArgs, ctx) => {
      try {
        await handleIntentumCommand(resolveRuntime(runtimeSource), rawArgs, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

function resolveRuntime(source: IntentumRuntimeSource): IntentumRuntime {
  return typeof source === "function" ? source() : source;
}

export async function handleIntentumCommand(
  runtime: IntentumRuntime,
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await runtime.assertContextRoot(ctx.cwd);
  const [command = "help", ...args] = splitArguments(rawArgs);

  switch (command.toLowerCase()) {
    case "init": {
      const name = args.join(" ").trim() || undefined;
      const result = await runtime.initialize(name);
      ctx.ui.notify(
        result.created
          ? `intentum initialized ${result.state.projectName} in discovery phase.`
          : `intentum already initialized ${result.state.projectName}; existing artifacts were preserved.`,
        "info",
      );
      return;
    }
    case "status": {
      ctx.ui.notify((await runtime.status()).text, "info");
      return;
    }
    case "workers": {
      const { state } = await runtime.status();
      const workers = Object.values(state.workers);
      ctx.ui.notify(
        workers.length
          ? workers.map((worker) => `${worker.id} · ${worker.status} · ${worker.progressSummary ?? worker.objective}`).join("\n")
          : "No Worker has been started.",
        "info",
      );
      return;
    }
    case "pause": {
      await runtime.pauseProject();
      ctx.ui.notify("Project scheduling paused. Active Workers received a safe-pause request; their worktrees were preserved.", "warning");
      return;
    }
    case "resume": {
      const state = await runtime.resumeProject();
      ctx.ui.notify(`Project resumed in ${state.phase} phase. Resume a paused Worker explicitly when ready.`, "info");
      return;
    }
    case "steer": {
      const [workerId, ...messageParts] = args;
      if (!workerId || messageParts.length === 0) throw new Error("usage: /intentum steer WORKER_ID message");
      await runtime.workers.steer(workerId, messageParts.join(" "));
      ctx.ui.notify(`Instruction sent or queued for ${workerId}.`, "info");
      return;
    }
    case "worker-resume": {
      const [workerId, ...messageParts] = args;
      if (!workerId) throw new Error("usage: /intentum worker-resume WORKER_ID [message]");
      runtime.setWorkerSessionDefaults(ctx);
      await runtime.workers.resume(workerId, messageParts.join(" ") || undefined);
      ctx.ui.notify(`Resuming ${workerId} in its preserved Pi session and worktree.`, "info");
      return;
    }
    case "integrate": {
      const [workerId] = args;
      if (!workerId) throw new Error("usage: /intentum integrate WORKER_ID");
      const { state } = await runtime.status();
      if (state.autonomy === "guided") {
        const confirmed = await ctx.ui.confirm(
          "Integrate Worker result",
          `Merge ${workerId} into its recorded target branch? The result commit and clean worktree will be verified first.`,
        );
        if (!confirmed) {
          ctx.ui.notify("Integration left unchanged.", "info");
          return;
        }
      }
      await runtime.workers.integrateWorker(workerId);
      ctx.ui.notify(`${workerId} integrated into its recorded target branch.`, "info");
      return;
    }
    case "abort": {
      const [workerId, ...reasonParts] = args;
      if (!workerId || reasonParts.length === 0) throw new Error("usage: /intentum abort WORKER_ID reason");
      const confirmed = await ctx.ui.confirm(
        "Emergency abort",
        `Abort the current turn for ${workerId}? Session, branch, worktree, and files will be preserved.`,
      );
      if (!confirmed) return;
      await runtime.workers.abort(workerId, reasonParts.join(" "));
      ctx.ui.notify(`${workerId} interrupted; preserved artifacts remain available.`, "warning");
      return;
    }
    case "help":
    case "": {
      ctx.ui.notify(
        [
          "/intentum init [project name]",
          "/intentum status",
          "/intentum workers",
          "/intentum pause",
          "/intentum resume",
          "/intentum steer WORKER_ID message",
          "/intentum worker-resume WORKER_ID [message]",
          "/intentum integrate WORKER_ID",
          "/intentum abort WORKER_ID reason",
          "Use normal conversation for product decisions and Worker creation.",
        ].join("\n"),
        "info",
      );
      return;
    }
    default:
      throw new Error(`unknown /intentum action: ${command}`);
  }
}

export function splitArguments(value: string): string[] {
  const matches = value.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) ?? [];
  return matches.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1).replace(/\\([\\"'])/g, "$1");
    }
    return token;
  });
}
