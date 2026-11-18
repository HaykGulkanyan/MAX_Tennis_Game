/**
 * The chair umpire's voice: calls the score after every point.
 *
 * Uses the browser's built-in speech synthesis, so there are no recordings to
 * ship and any player name can be spoken. The trade-off is that the voice is
 * whichever ones the device has installed, so this picks the best of them:
 * a natural-sounding ("neural") male English voice, British first, the way a
 * Grand Slam chair umpire sounds, and delivers it a little slower and lower.
 * Where speech is unavailable, every call is a silent no-op.
 *
 * The wording is real tennis (see game/tennisScore.ts), server's score first:
 * "Fifteen, love.", "Thirty all.", "Deuce!", "Advantage, Hayk!",
 * "Game, Hayk. Hayk leads, two games to one.", "Game, set and match, Hayk!".
 */

import { gameCall, matchCall, pointCall } from '../game/tennisScore'
import type { PlayerSide } from '../game/types'

let enabled = true
let voice: SpeechSynthesisVoice | null = null
/** Whether the chosen voice is a male one, which decides how far to lower it. */
let voiceIsMale = false

function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/*
 * Voice names across the platforms people play on. Natural/neural voices
 * (Edge's "Online (Natural)" ones, and Chrome's network voices) sound far more
 * human than the older desktop voices, so they rank highest of all.
 */
const MALE_NAMES = [
  'ryan', 'thomas', 'guy', 'christopher', 'eric', 'andrew', 'brian', 'roger',
  'steffan', 'william', 'liam', 'george', 'daniel', 'arthur', 'oliver',
  'david', 'mark', 'james', 'alex', 'fred', 'rishi', 'aaron', 'uk english male',
  'us english male', 'male',
]
const FEMALE_NAMES = [
  'sonia', 'libby', 'maisie', 'hazel', 'susan', 'zira', 'aria', 'jenny',
  'michelle', 'ava', 'emma', 'samantha', 'karen', 'moira', 'tessa', 'serena',
  'kate', 'fiona', 'victoria', 'female', 'catherine', 'natasha', 'clara',
]

function nameHas(name: string, list: readonly string[]): boolean {
  return list.some((word) => name.includes(word))
}

/**
 * How well a voice suits a chair umpire; higher is better. Only English voices
 * qualify at all (anything else is -Infinity); among them a female voice still
 * ranks, just low, so a device without a male voice still gets an English one.
 * Exported so the ranking can be checked without a browser.
 */
export function rankVoice(v: { name: string; lang: string }): number {
  const name = v.name.toLowerCase()
  const lang = v.lang.toLowerCase().replace('_', '-')
  if (!lang.startsWith('en')) return Number.NEGATIVE_INFINITY
  let score = 0
  if (/natural|neural|online|premium|enhanced/.test(name)) score += 100
  if (name.startsWith('google')) score += 40
  if (nameHas(name, FEMALE_NAMES)) score -= 60
  else if (nameHas(name, MALE_NAMES)) score += 60
  if (lang === 'en-gb') score += 25
  else if (lang === 'en-au' || lang === 'en-ie') score += 12
  else if (lang === 'en-us') score += 8
  return score
}

/**
 * Pick the best voice the device offers. Voices load asynchronously in Chrome
 * and Edge, so this runs again on `voiceschanged`.
 */
function chooseVoice(): void {
  if (!speechAvailable()) return
  const ranked = window.speechSynthesis
    .getVoices()
    .map((v) => ({ v, score: rankVoice(v) }))
    .filter((r) => r.score > Number.NEGATIVE_INFINITY)
    .sort((a, b) => b.score - a.score)
  voice = ranked[0]?.v ?? null
  voiceIsMale = voice !== null && !nameHas(voice.name.toLowerCase(), FEMALE_NAMES)
}

if (speechAvailable()) {
  chooseVoice()
  window.speechSynthesis.addEventListener?.('voiceschanged', chooseVoice)
}

/** The name of the voice in use, for display. */
export function umpireVoiceName(): string | null {
  return voice?.name ?? null
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
    // Measured and authoritative: a touch slower than conversation, and lower.
    // A male voice only needs a little lowering; pushing it further sounds
    // processed. Any other voice is lowered more to approach the right range.
    utterance.rate = 0.9
    utterance.pitch = voiceIsMale ? 0.82 : 0.7
    utterance.volume = 1
    window.speechSynthesis.speak(utterance)
  } catch {
    // The voice is a nicety; never let it interrupt the game.
  }
}

function reasonPrefix(reason: 'out' | 'net' | null): string {
  return reason === 'out' ? 'Out! ' : reason === 'net' ? 'Net! ' : ''
}

/** Call the score after a point that did not end the game. */
export function announcePoint(
  points: readonly [number, number],
  server: PlayerSide,
  names: readonly [string, string],
  reason: 'out' | 'net' | null,
): void {
  say(reasonPrefix(reason) + pointCall(points, server, names))
}

/** Call a game won, and the games score. */
export function announceGame(
  winner: PlayerSide,
  games: readonly [number, number],
  names: readonly [string, string],
  reason: 'out' | 'net' | null,
): void {
  say(reasonPrefix(reason) + gameCall(winner, games, names))
}

/** Call the end of the match. */
export function announceMatch(winner: PlayerSide, names: readonly [string, string]): void {
  say(matchCall(winner, names))
}
