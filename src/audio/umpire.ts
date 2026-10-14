/**
 * The chair umpire's voice: calls the score after every point.
 *
 * Uses the browser's built-in speech synthesis, so there are no recordings to
 * ship and any player name can be spoken. The trade-off is that the voice is
 * whatever the operating system provides, so it sounds different on Windows,
 * macOS and phones. Where speech is unavailable, every call is a silent no-op.
 *
 * The wording follows real umpire calls, adapted to this game's scoring
 * (first to MATCH.pointsToWin, win by 2): "Five, three. Hayk leads.",
 * "Four all.", "Deuce.", "Advantage, Hayk.", "Match point, Hayk.",
 * "Game, set and match, Hayk!".
 */

import { MATCH } from '../game/constants'

let enabled = true
let voice: SpeechSynthesisVoice | null = null

const NUMBERS = [
  'love', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
]

function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/**
 * Pick an English voice, preferring British for the Wimbledon feel. Voices
 * load asynchronously in Chrome, so this runs again on `voiceschanged`.
 */
function chooseVoice(): void {
  if (!speechAvailable()) return
  const voices = window.speechSynthesis.getVoices()
  voice =
    voices.find((v) => v.lang === 'en-GB') ??
    voices.find((v) => v.lang === 'en-US') ??
    voices.find((v) => v.lang.startsWith('en')) ??
    null
}

if (speechAvailable()) {
  chooseVoice()
  window.speechSynthesis.addEventListener?.('voiceschanged', chooseVoice)
}

export function setUmpireVoice(on: boolean): void {
  enabled = on
  if (!on && speechAvailable()) window.speechSynthesis.cancel()
}

/** Stop a call mid-sentence, e.g. when leaving a match. */
export function hushUmpire(): void {
  if (speechAvailable()) window.speechSynthesis.cancel()
}

function say(text: string): void {
  if (!enabled || !speechAvailable()) return
  try {
    // A new call replaces one still being spoken: in a fast match, a call that
    // trails into the next point is worse than a call cut short.
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang ?? 'en-GB'
    utterance.rate = 0.95
    utterance.pitch = 0.9
    window.speechSynthesis.speak(utterance)
  } catch {
    // The voice is a nicety; never let it interrupt the game.
  }
}

function spoken(n: number): string {
  return NUMBERS[n] ?? String(n)
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** "You lead" rather than "You leads" in a match against the computer. */
function leads(name: string): string {
  return name.toLowerCase() === 'you' ? `${name} lead` : `${name} leads`
}

/**
 * The call for a score, as text. Exported so the wording can be checked
 * without a browser.
 */
export function scoreCall(
  scores: readonly [number, number],
  names: readonly [string, string],
  reason: 'out' | 'net' | null = null,
): string {
  const [a, b] = scores
  const target = MATCH.pointsToWin
  const prefix = reason === 'out' ? 'Out! ' : reason === 'net' ? 'Net! ' : ''

  if (a === b) {
    // Level at the far end of the match is deuce, as in a real game.
    return prefix + (a >= target - 1 ? 'Deuce.' : `${capitalise(spoken(a))} all.`)
  }

  const leader = a > b ? 0 : 1
  const high = Math.max(a, b)
  const low = Math.min(a, b)
  const name = names[leader]
  const matchPoint = high + 1 >= target && high + 1 - low >= 2

  // One ahead after deuce: advantage, which is always also a match point.
  if (low >= target - 1) return `${prefix}Advantage, ${name}.`

  const call = `${capitalise(spoken(high))}, ${spoken(low)}. ${leads(name)}.`
  return prefix + call + (matchPoint ? ` Match point, ${name}.` : '')
}

/** Call the score after a point. */
export function announceScore(
  scores: readonly [number, number],
  names: readonly [string, string],
  reason: 'out' | 'net' | null,
): void {
  say(scoreCall(scores, names, reason))
}

/** Call the end of the match. */
export function announceMatch(winnerName: string): void {
  say(`Game, set and match, ${winnerName}!`)
}
