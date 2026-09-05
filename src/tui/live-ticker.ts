/**
 * One phase-locked ticker for every live tool block. N concurrent spinners
 * cost one timer and advance in lockstep; the frame index derives from the
 * clock, so blocks that register late join mid-cycle instead of restarting.
 */

/** Advance the spinner glyph at its classic ~12.5fps step. */
export const SPINNER_TICK_MS = 80;

const liveTools = new Map<string, () => void>();
let ticker: NodeJS.Timeout | undefined;

export function sharedSpinnerFrame(frameCount: number, now: number = performance.now()): number {
  return frameCount > 0 ? Math.floor(now / SPINNER_TICK_MS) % frameCount : 0;
}

/** Track a live tool call; `repaint` runs once per tick until the call settles. */
export function registerLiveTool(id: string, repaint: () => void): void {
  liveTools.set(id, repaint);
  if (ticker) return;
  ticker = setInterval(() => {
    for (const paint of liveTools.values()) paint();
  }, SPINNER_TICK_MS);
  ticker.unref?.();
}

export function unregisterLiveTool(id: string): void {
  if (!liveTools.delete(id) || liveTools.size > 0 || !ticker) return;
  clearInterval(ticker);
  ticker = undefined;
}

/** Drop every live block: a turn ended or the session shut down without their results. */
export function settleLiveTools(): void {
  liveTools.clear();
  if (!ticker) return;
  clearInterval(ticker);
  ticker = undefined;
}

export function liveToolCount(): number {
  return liveTools.size;
}
