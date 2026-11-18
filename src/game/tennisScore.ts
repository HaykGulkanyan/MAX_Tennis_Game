/**
 * Tennis scoring: how raw point counts read on the scoreboard and in the
 * umpire's calls.
 *
 * The simulation keeps plain point counts per game (0, 1, 2, 3, ...). This
 * module turns them into tennis: 0 = love, 1 = 15, 2 = 30, 3 = 40, then deuce
 * and advantage once both players reach 40. A game needs at least four points
 * and a two-point lead, so deuce can repeat any number of times.
 *
 * Pure functions, shared by the simulation (when is a game won), the HUD and
 * the umpire, so all three always agree.
 */

import type { PlayerSide } from './types';

/** Points needed to win a game, before the two-point-lead rule. */
export const POINTS_FOR_GAME = 4;

export type GameScore =
  | { kind: 'normal' }
  | { kind: 'deuce' }
  | { kind: 'advantage'; side: PlayerSide };

/** Where a game stands, from the two players' point counts in it. */
export function gameScore(points: readonly [number, number]): GameScore {
  const [a, b] = points;
  if (a >= 3 && b >= 3) {
    if (a === b) return { kind: 'deuce' };
    if (Math.abs(a - b) === 1) return { kind: 'advantage', side: a > b ? 0 : 1 };
  }
  return { kind: 'normal' };
}

/** Has this side won the game? At least four points and two clear. */
export function wonGame(points: readonly [number, number], side: PlayerSide): boolean {
  const mine = points[side];
  const theirs = points[side === 0 ? 1 : 0];
  return mine >= POINTS_FOR_GAME && mine - theirs >= 2;
}

/**
 * Keep a long deuce battle's counts small: whenever the score returns to
 * deuce, reset both counts to 3-3. Nothing changes for the player (deuce is
 * deuce); it just keeps the numbers bounded however long the game goes on.
 */
export function normaliseDeuce(points: [number, number]): void {
  if (points[0] >= 3 && points[0] === points[1]) {
    points[0] = 3;
    points[1] = 3;
  }
}

const LABELS = ['0', '15', '30', '40'];

/** The scoreboard label for one side: 0, 15, 30, 40 or AD. */
export function pointLabel(points: readonly [number, number], side: PlayerSide): string {
  const state = gameScore(points);
  if (state.kind === 'deuce') return '40';
  if (state.kind === 'advantage') return state.side === side ? 'AD' : '40';
  return LABELS[Math.min(3, points[side])] ?? '40';
}

const SPOKEN = ['love', 'fifteen', 'thirty', 'forty'];
const NUMBER_WORDS = [
  'love', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
];

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The umpire's call after a point within a game, server's score first, as
 * real umpires call it: "Fifteen, love.", "Thirty all.", "Deuce!",
 * "Advantage, Hayk!".
 */
export function pointCall(
  points: readonly [number, number],
  server: PlayerSide,
  names: readonly [string, string],
): string {
  const state = gameScore(points);
  if (state.kind === 'deuce') return 'Deuce!';
  if (state.kind === 'advantage') return `Advantage, ${names[state.side]}!`;
  const receiver: PlayerSide = server === 0 ? 1 : 0;
  const first = points[server];
  const second = points[receiver];
  if (first === second) return `${capitalise(SPOKEN[first])} all.`;
  return `${capitalise(SPOKEN[first])}, ${SPOKEN[second]}.`;
}

function gamesWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/**
 * The call when a game is won: "Game, Hayk. Hayk leads, two games to one."
 * or "Game, Hayk. One game all."
 */
export function gameCall(
  winner: PlayerSide,
  games: readonly [number, number],
  names: readonly [string, string],
): string {
  const [a, b] = games;
  const opening = `Game, ${names[winner]}.`;
  if (a === b) return `${opening} ${capitalise(gamesWord(a))} ${a === 1 ? 'game' : 'games'} all.`;
  const leader: PlayerSide = a > b ? 0 : 1;
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  const verb = names[leader].toLowerCase() === 'you' ? 'lead' : 'leads';
  return `${opening} ${names[leader]} ${verb}, ${gamesWord(high)} ${high === 1 ? 'game' : 'games'} to ${gamesWord(low)}.`;
}

/** The call at the end of the match. */
export function matchCall(winner: PlayerSide, names: readonly [string, string]): string {
  return `Game, set and match, ${names[winner]}!`;
}
