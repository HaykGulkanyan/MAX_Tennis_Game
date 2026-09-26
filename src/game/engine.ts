/**
 * The engine: owns the snapshot and the fixed-timestep clock.
 *
 * This is the seam between the pure simulation and everything that is messy —
 * React, the network, the renderer. There is exactly one of these per match.
 *
 * Roles differ in who advances the state:
 *  - host / ai / practice: runs `step` locally, authoritative.
 *  - guest: applies host snapshots, and predicts its own player on top.
 *  - spectator: applies host snapshots only, no prediction.
 */

import { SNAPSHOT_INTERVAL, TICK } from './constants';
import {
  createInitialSnapshot,
  predictPlayer,
  resetMatch,
  step,
} from './simulation';
import type {
  GameEvent,
  GameSnapshot,
  PlayerInput,
  PlayerSide,
} from './types';
import { EMPTY_INPUT } from './types';

export type EngineRole = 'authority' | 'guest' | 'spectator';

/** A local source of input, polled once per tick. */
export type InputSource = (snapshot: GameSnapshot, side: PlayerSide) => PlayerInput;

export type EngineOptions = {
  role: EngineRole;
  /** Which side this client controls. Spectators still need a camera side. */
  side: PlayerSide;
  /** Produces this client's own input each tick. */
  localInput: InputSource;
  /**
   * Produces the opponent's input. The host uses this for the AI or for the
   * latest input received from the guest; a guest leaves it undefined and
   * relies on the host's snapshots.
   */
  remoteInput?: InputSource;
  /** Called with the events from each tick, for sound and callouts. */
  onEvents?: (events: GameEvent[]) => void;
  /** Called when a snapshot is ready to broadcast (authority only). */
  onSnapshot?: (snapshot: GameSnapshot) => void;
  /**
   * Guest only: called with each input the engine produced, so the network
   * layer can forward exactly that input to the host.
   *
   * The network layer must NOT sample the input controller itself. Sampling
   * consumes the click latch and the released charge, so a second caller would
   * silently eat roughly half the player's clicks; and the input the guest
   * predicted with would differ from the one the host received, which
   * mispredicts every shot.
   */
  onLocalInput?: (input: PlayerInput) => void;
};

export class Engine {
  snapshot: GameSnapshot;
  readonly role: EngineRole;
  readonly side: PlayerSide;

  private options: EngineOptions;
  private accumulator = 0;
  private sinceSnapshot = 0;
  private seq = 0;

  /**
   * Inputs this client has sent but the host has not yet acknowledged. The
   * guest replays these over each incoming snapshot so its own player keeps
   * responding instantly instead of lagging by the round-trip time.
   */
  private pending: PlayerInput[] = [];

  /**
   * Extra ticks of delay applied to the authority's own input, to match what
   * the guest experiences. Without this the host reacts sooner simply for
   * being the host.
   */
  private fairnessDelayTicks = 0;
  private delayedInputs: PlayerInput[] = [];
  /** Seq of the last of our own inputs actually fed to the simulation. */
  private lastAppliedSelfSeq = 0;
  /** Highest host tick adopted, so out-of-order packets can be dropped. */
  private lastAppliedTick = -1;

  constructor(options: EngineOptions) {
    this.options = options;
    this.role = options.role;
    this.side = options.side;
    this.snapshot = createInitialSnapshot();
  }

  /** Set the host's self-imposed delay from the measured round-trip time. */
  setLatency(rttMs: number): void {
    if (this.role !== 'authority') return;
    // Half the round trip is the one-way delay the guest already suffers.
    const oneWay = Math.max(0, rttMs) / 2 / 1000;
    this.fairnessDelayTicks = Math.min(8, Math.round(oneWay / TICK));
  }

  /** Freeze or resume the match (opponent disconnected / rejoined). */
  setPaused(paused: boolean): void {
    this.snapshot.paused = paused;
  }

  nextInput(partial: Omit<PlayerInput, 'seq'>): PlayerInput {
    this.seq += 1;
    return { ...partial, seq: this.seq };
  }

  /** Host: record the newest input received from the remote player. */
  private latestRemote: PlayerInput = { ...EMPTY_INPUT };
  setRemoteInput(input: PlayerInput): void {
    // Ignore out-of-order arrivals; a stale input would rubber-band them.
    if (input.seq < this.latestRemote.seq) return;
    this.latestRemote = input;
  }

  /**
   * Guest: adopt an authoritative snapshot, then re-apply the inputs the host
   * has not seen yet so this client's own player does not snap backwards.
   */
  applySnapshot(incoming: GameSnapshot): void {
    // Drop genuinely out-of-order packets, but accept an equal tick: the guest
    // no longer advances `tick` itself, so a repeated tick is a legitimate
    // retransmit rather than a stale one. Using `<=` here was the second half
    // of the vanishing-ball bug, because it discarded good snapshots.
    if (incoming.tick < this.lastAppliedTick) return;
    this.lastAppliedTick = incoming.tick;

    this.snapshot = incoming;

    if (this.role !== 'guest') return;

    const acked = incoming.ackedSeq[this.side];
    this.pending = this.pending.filter((input) => input.seq > acked);

    // Replay unacknowledged inputs. Only this client's own side is predicted;
    // the opponent is left exactly as the host reported, because guessing
    // their movement produces visible rubber-banding when the guess is wrong.
    for (const input of this.pending) {
      predictPlayer(this.snapshot, this.side, input);
    }
  }

  /** Advance the clock. Call once per animation frame with the frame delta. */
  advance(deltaSeconds: number): void {
    // Clamp so a backgrounded tab does not try to catch up thousands of ticks
    // in one frame and lock the browser up.
    this.accumulator += Math.min(deltaSeconds, 0.25);

    while (this.accumulator >= TICK) {
      this.accumulator -= TICK;
      this.tick();
    }
  }

  private tick(): void {
    const local = this.options.localInput(this.snapshot, this.side);

    if (this.role === 'guest') {
      // The guest does not simulate the world; it only predicts itself. The
      // authoritative state arrives via applySnapshot.
      this.pending.push(local);
      // Hand the host the exact input we predicted with, so its authoritative
      // result matches our prediction.
      this.options.onLocalInput?.(local);
      predictPlayer(this.snapshot, this.side, local);
      return;
    }

    if (this.role === 'spectator') return;

    // --- Authority ---
    // Delay our own input by the fairness window, so the host does not enjoy a
    // reaction-time advantage over the guest.
    // Hold our own input for `fairnessDelayTicks` before applying it, so the
    // host does not react sooner than the guest simply for being the host.
    // While the queue is still filling we act on nothing, and we report the
    // seq of the input we ACTUALLY applied, never the one still waiting; the
    // ack has to describe what was consumed or reconciliation drifts.
    this.delayedInputs.push(local);
    let selfInput: PlayerInput;
    if (this.delayedInputs.length > this.fairnessDelayTicks) {
      selfInput = this.delayedInputs.shift() as PlayerInput;
    } else {
      const lastApplied = this.lastAppliedSelfSeq;
      selfInput = { ...EMPTY_INPUT, seq: lastApplied };
    }
    this.lastAppliedSelfSeq = selfInput.seq;

    const opponent = this.options.remoteInput
      ? this.options.remoteInput(this.snapshot, this.side === 0 ? 1 : 0)
      : this.latestRemote;

    const inputs: [PlayerInput, PlayerInput] =
      this.side === 0 ? [selfInput, opponent] : [opponent, selfInput];

    const events = step(this.snapshot, inputs);
    if (events.length) this.options.onEvents?.(events);

    this.sinceSnapshot += TICK;
    if (this.sinceSnapshot >= SNAPSHOT_INTERVAL) {
      this.sinceSnapshot = 0;
      this.options.onSnapshot?.(this.snapshot);
    }
  }

  restart(): void {
    resetMatch(this.snapshot);
  }
}
