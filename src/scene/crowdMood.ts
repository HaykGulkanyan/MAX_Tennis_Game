/**
 * How excited the crowd is right now, from 0 (calm) upward.
 *
 * Game events (a point, the match ending) raise it, and the crowd animation
 * reads and decays it once per frame. A plain module variable rather than store
 * state on purpose: it changes every frame, and putting it in the store would
 * re-render every subscriber sixty times a second.
 */

let excitement = 0

/** Seconds for excitement to fall to about a third, i.e. how long a cheer lasts. */
const DECAY_SECONDS = 1.3

/** Excite the crowd. A bigger moment wins over a smaller one already running. */
export function cheer(amount: number): void {
  excitement = Math.min(1.5, Math.max(excitement, amount))
}

/** Advance the decay by `dt` seconds and return the current level. */
export function sampleExcitement(dt: number): number {
  excitement *= Math.exp(-dt / DECAY_SECONDS)
  if (excitement < 0.001) excitement = 0
  return excitement
}

/** Calm the crowd at once, e.g. when leaving a match. */
export function resetCrowd(): void {
  excitement = 0
}
