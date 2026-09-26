/**
 * Shared vocabulary for the simulation and the network layer.
 *
 * The host runs the only authoritative simulation. The guest sends inputs and
 * renders the snapshots it receives back, so every type here has to survive a
 * JSON round-trip: plain objects and primitives only, no class instances and
 * no THREE.Vector3.
 */

export type Vec3 = { x: number; y: number; z: number };

/** 0 defends -Z (the host's side), 1 defends +Z (the guest's side). */
export type PlayerSide = 0 | 1;

export type PlayerProfile = {
  name: string;
  color: string;
};

/**
 * One player's intent for a single tick. This is the entire guest -> host
 * message: the guest never moves itself authoritatively, it only asks.
 */
export type PlayerInput = {
  /**
   * Monotonic sequence number, assigned by the client that produced this
   * input. Client-side prediction depends on it: the guest keeps every input
   * it has sent, and when a snapshot arrives saying "I have applied up to
   * seq N", it discards those and replays the rest on top of the authoritative
   * state. Without it the guest cannot tell which of its predictions the host
   * has already accounted for.
   */
  seq: number;
  /** Normalised movement direction on the court plane, -1..1 per axis. */
  moveX: number;
  moveZ: number;
  /** Where on the court this player is aiming, in world coordinates. */
  aimX: number;
  aimZ: number;
  /** Left mouse: fire a shot at the aim point on the next contact. */
  shoot: boolean;
  /** Right mouse held: charge power. 0..1, already normalised by the client. */
  charge: number;
};

export const EMPTY_INPUT: PlayerInput = {
  seq: 0,
  moveX: 0,
  moveZ: 0,
  aimX: 0,
  aimZ: 0,
  shoot: false,
  charge: 0,
};

export type PlayerState = {
  position: Vec3;
  velocity: Vec3;
  /** Seconds remaining before this player may swing again. */
  swingCooldown: number;
  /** Counts up while a swing animation plays, for the renderer. */
  swingTimer: number;
  /** Current charge level, mirrored from input so the guest can draw the bar. */
  charge: number;
  /** Where this player is aiming, so both clients can draw the marker. */
  aim: { x: number; z: number };
};

export type BallState = {
  position: Vec3;
  velocity: Vec3;
  /** Who hit the ball last. null before the serve is struck. */
  lastHitBy: PlayerSide | null;
  /**
   * Bounces on the current side since the last strike. Two bounces on the
   * same side ends the point.
   */
  bouncesSinceHit: number;
  /** True once the ball is out of play and we are waiting for the reset. */
  dead: boolean;
};

export type RallyPhase =
  /** Waiting for the server to strike; ball is held at the racket. */
  | 'serving'
  /** Ball is live. */
  | 'rally'
  /** Point decided, showing the result before the next serve. */
  | 'point-over'
  /** Match decided. */
  | 'match-over';

/** Why the last point ended, used for the on-screen callout. */
export type PointReason =
  | 'out'
  | 'net'
  | 'double-bounce'
  | 'winner'
  | null;

export type MatchState = {
  scores: [number, number];
  /** Which side serves the current point. */
  server: PlayerSide;
  phase: RallyPhase;
  reason: PointReason;
  /** Who won the last point, for the callout and the serve rotation. */
  lastPointWinner: PlayerSide | null;
  winner: PlayerSide | null;
  /** Seconds left in the point-over pause. */
  resetTimer: number;
};

/**
 * The complete authoritative state. The host sends this wholesale; at ~20 Hz
 * with this few fields the bandwidth is trivial and it avoids a whole class of
 * desync bugs that partial deltas invite.
 */
export type GameSnapshot = {
  /** Host simulation tick, so the guest can drop out-of-order packets. */
  tick: number;
  players: [PlayerState, PlayerState];
  ball: BallState;
  match: MatchState;
  /**
   * The last input `seq` the host had consumed from each side when this
   * snapshot was taken. The guest uses its own entry to discard predictions
   * the host has already accounted for, and replays the rest.
   */
  ackedSeq: [number, number];
  /** True while a player is disconnected; the simulation is frozen. */
  paused: boolean;
};

/** Events the host emits for one-shot effects (sound, callouts). */
export type GameEvent =
  | { type: 'hit'; side: PlayerSide; power: number }
  | { type: 'bounce'; position: Vec3 }
  | { type: 'net' }
  | { type: 'out' }
  | { type: 'score'; scores: [number, number] }
  | { type: 'match-over'; winner: PlayerSide };

/**
 * What a connected peer is here to do. A spectator receives snapshots but its
 * inputs are ignored, so an onlooker can never nudge the match.
 */
export type PeerRole = 'player' | 'spectator';

/** Guest -> host. */
export type ClientMessage =
  | { kind: 'input'; input: PlayerInput }
  /**
   * The guest's measured round-trip time. Only the guest can measure it (it
   * sends the pings), but only the host can act on it, since the host is the
   * one that delays its own input to even out the advantage.
   */
  | { kind: 'latency'; rttMs: number }
  | { kind: 'profile'; profile: PlayerProfile; role: PeerRole }
  | { kind: 'rematch' }
  /** Round-trip probe, echoed back by the host, for the latency estimate. */
  | { kind: 'ping'; sent: number };

/** Host -> guest. */
export type HostMessage =
  | { kind: 'snapshot'; snapshot: GameSnapshot }
  | { kind: 'events'; events: GameEvent[] }
  | { kind: 'profiles'; profiles: [PlayerProfile, PlayerProfile] }
  /** Tells a joiner which side it controls, or that it is only watching. */
  | { kind: 'welcome'; side: PlayerSide; role: PeerRole }
  | { kind: 'start' }
  | { kind: 'pong'; sent: number };

export type ConnectionStatus =
  | 'idle'
  | 'hosting'
  | 'connecting'
  | 'connected'
  /** Opponent dropped; the match is frozen and waiting for them to rejoin. */
  | 'waiting-for-rejoin'
  | 'error'
  | 'closed';

export type GameMode = 'menu' | 'ai' | 'host' | 'guest' | 'spectator' | 'practice';

/** AI opponent strength. */
export type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * Which camera the player is using. Purely a client-side view preference: it
 * never reaches the simulation, so the two players can each pick their own.
 */
export type CameraMode = 'broadcast' | 'third' | 'first';

export const CAMERA_MODES: readonly CameraMode[] = ['broadcast', 'third', 'first'];

export const CAMERA_MODE_LABELS: Record<CameraMode, string> = {
  broadcast: 'Broadcast',
  third: 'Third person',
  first: 'First person',
};
