import type { ActiveProjectPhase, ProjectPhase, ProjectState } from "../state/schema.js";

export const ALLOWED_TRANSITIONS: Readonly<Record<ProjectPhase, readonly ProjectPhase[]>> = {
  discovery: ["direction", "paused"],
  direction: ["architecture", "discovery", "paused"],
  architecture: ["build", "direction", "paused"],
  build: ["verify", "architecture", "paused"],
  verify: ["review", "build", "paused"],
  review: ["ship", "build", "paused"],
  ship: ["maintain", "review", "paused"],
  maintain: ["build", "verify", "paused"],
  paused: [
    "discovery",
    "direction",
    "architecture",
    "build",
    "verify",
    "review",
    "ship",
    "maintain",
  ],
};

export function transitionProject(state: ProjectState, target: ProjectPhase): ProjectState {
  if (state.phase === target) return state;
  if (!ALLOWED_TRANSITIONS[state.phase].includes(target)) {
    throw new Error(`invalid intentum phase transition: ${state.phase} -> ${target}`);
  }

  if (target === "paused") {
    return {
      ...state,
      phase: target,
      phaseBeforePause: state.phase as ActiveProjectPhase,
      schedulerPaused: true,
    };
  }

  const next = {
    ...state,
    phase: target,
    schedulerPaused: false,
  };
  delete next.phaseBeforePause;
  return next;
}

export function pauseProject(state: ProjectState): ProjectState {
  return state.phase === "paused" ? { ...state, schedulerPaused: true } : transitionProject(state, "paused");
}

export function resumeProject(state: ProjectState): ProjectState {
  if (state.phase !== "paused") {
    return { ...state, schedulerPaused: false };
  }
  return transitionProject(state, state.phaseBeforePause ?? "discovery");
}
