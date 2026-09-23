/**
 * The authoritative tennis simulation.
 *
 * Deliberately free of React and THREE so the rules live in one testable place.
 * Only the host ever calls `step`; the guest renders the snapshots it produces.
 */

import { COURT, MATCH, NET, PHYSICS, PLAYER, SHOT, TICK } from './constants';
import type {
  BallState,
  GameEvent,
  GameSnapshot,
  MatchState,
  PlayerInput,
  PlayerSide,
  PlayerState,
  Vec3,
} from './types';

const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

/** Which way this side hits: side 0 defends -Z so it hits toward +Z. */
const attackDir = (side: PlayerSide): number => (side === 0 ? 1 : -1);

/** Sign of the half-court this side defends. */
const defendDir = (side: PlayerSide): number => (side === 0 ? -1 : 1);

function spawnPosition(side: PlayerSide): Vec3 {
  return vec(0, 0, defendDir(side) * (COURT.halfLength - 1.4));
}

function makePlayer(side: PlayerSide): PlayerState {
  return {
    position: spawnPosition(side),
    velocity: vec(),
    swingCooldown: 0,
    swingTimer: 0,
    charge: 0,
    aim: { x: 0, z: attackDir(side) * COURT.serviceLine },
  };
}

export function createInitialSnapshot(): GameSnapshot {
  const snapshot: GameSnapshot = {
    tick: 0,
    players: [makePlayer(0), makePlayer(1)],
    ball: {
      position: vec(),
      velocity: vec(),
      lastHitBy: null,
      bouncesSinceHit: 0,
      dead: false,
    },
    match: {
      scores: [0, 0],
      server: 0,
      phase: 'serving',
      reason: null,
      lastPointWinner: null,
      winner: null,
      resetTimer: 0,
    },
    ackedSeq: [0, 0],
    paused: false,
  };
  placeBallForServe(snapshot);
  return snapshot;
}

/**
 * Park the ball at the server's racket. While `phase === 'serving'` the ball is
 * carried, so it follows the server until they strike it.
 */
function placeBallForServe(snapshot: GameSnapshot): void {
  const server = snapshot.match.server;
  const player = snapshot.players[server];
  const ball = snapshot.ball;
  ball.position = vec(
    player.position.x + 0.5 * attackDir(server),
    1.25,
    player.position.z + 0.35 * attackDir(server),
  );
  ball.velocity = vec();
  ball.lastHitBy = null;
  ball.bouncesSinceHit = 0;
  ball.dead = false;
}

/** Reset both players and the ball for a fresh point, keeping the score. */
function resetForNextPoint(snapshot: GameSnapshot): void {
  snapshot.players[0].position = spawnPosition(0);
  snapshot.players[1].position = spawnPosition(1);
  snapshot.players[0].velocity = vec();
  snapshot.players[1].velocity = vec();
  snapshot.players[0].swingCooldown = 0;
  snapshot.players[1].swingCooldown = 0;
  snapshot.match.phase = 'serving';
  snapshot.match.reason = null;
  placeBallForServe(snapshot);
}

export function resetMatch(snapshot: GameSnapshot): void {
  snapshot.match.scores = [0, 0];
  snapshot.match.server = 0;
  snapshot.match.winner = null;
  snapshot.match.lastPointWinner = null;
  snapshot.match.resetTimer = 0;
  resetForNextPoint(snapshot);
}

/** True once a side has enough points to take the match (first to N, win by 2). */
function isMatchPoint(scores: [number, number], side: PlayerSide): boolean {
  const mine = scores[side];
  const theirs = scores[side === 0 ? 1 : 0];
  return mine >= MATCH.pointsToWin && mine - theirs >= 2;
}

function awardPoint(
  snapshot: GameSnapshot,
  winner: PlayerSide,
  reason: MatchState['reason'],
  events: GameEvent[],
): void {
  const match = snapshot.match;
  // Guard against a point being awarded twice in the same tick, which would
  // otherwise be possible when two end conditions coincide (e.g. a ball that
  // bounces twice on the very tick it leaves the court).
  if (match.phase !== 'rally' && match.phase !== 'serving') return;

  match.scores[winner] += 1;
  match.lastPointWinner = winner;
  match.reason = reason;
  snapshot.ball.dead = true;
  events.push({ type: 'score', scores: [...match.scores] as [number, number] });

  if (isMatchPoint(match.scores, winner)) {
    match.phase = 'match-over';
    match.winner = winner;
    events.push({ type: 'match-over', winner });
    return;
  }

  match.phase = 'point-over';
  match.resetTimer = MATCH.pointResetDelay;
  // Loser of the point serves next, which keeps the game flowing without
  // anyone having to track a rotation.
  match.server = winner === 0 ? 1 : 0;
}

/** Clamp a player inside the playfield (court plus runoff, own half only). */
function clampToOwnHalf(position: Vec3, side: PlayerSide): void {
  const limitX = COURT.halfWidth + COURT.runoffX;
  const maxZ = COURT.halfLength + COURT.runoffZ;
  position.x = Math.max(-limitX, Math.min(limitX, position.x));

  // Players may serve-and-volley but cannot stand on top of the net, which
  // would otherwise be a dominant (and silly) camping strategy.
  if (side === 0) {
    position.z = Math.max(-maxZ, Math.min(-PLAYER.netKeepout, position.z));
  } else {
    position.z = Math.max(PLAYER.netKeepout, Math.min(maxZ, position.z));
  }
}

function stepPlayer(player: PlayerState, input: PlayerInput, side: PlayerSide, dt: number): void {
  // Normalise so diagonals are not faster than the axes.
  let dx = input.moveX;
  let dz = input.moveZ;
  const magnitude = Math.hypot(dx, dz);
  if (magnitude > 1) {
    dx /= magnitude;
    dz /= magnitude;
  }

  const targetVx = dx * PLAYER.moveSpeed;
  const targetVz = dz * PLAYER.moveSpeed;
  // Exponential approach to the target velocity: smooth to watch, and framerate
  // independent in a way that a plain lerp is not.
  const blend = 1 - Math.exp(-PLAYER.acceleration * dt);
  player.velocity.x += (targetVx - player.velocity.x) * blend;
  player.velocity.z += (targetVz - player.velocity.z) * blend;

  player.position.x += player.velocity.x * dt;
  player.position.z += player.velocity.z * dt;
  clampToOwnHalf(player.position, side);

  player.charge = input.charge;
  player.aim = { x: input.aimX, z: input.aimZ };

  if (player.swingCooldown > 0) player.swingCooldown -= dt;
  if (player.swingTimer > 0) player.swingTimer -= dt;
}

/**
 * Launch the ball from `from` so that it lands on (targetX, targetZ).
 *
 * We solve the arc rather than guessing a lift: horizontal speed sets the
 * flight time, and the vertical velocity is whatever makes the ball arrive at
 * ground level exactly on target. That keeps aiming honest — where you point
 * is where it lands — which matters because the player chooses the target.
 *
 * `speed` therefore controls *how hard and flat* the shot is, not how far it
 * goes: a faster shot has a shorter flight time and a flatter arc.
 */
function launchBall(
  ball: BallState,
  from: Vec3,
  targetX: number,
  targetZ: number,
  speed: number,
): void {
  const dx = targetX - from.x;
  const dz = targetZ - from.z;
  const distance = Math.max(0.5, Math.hypot(dx, dz));

  // Horizontal speed decays as v0 * exp(-drag * t), so over a flight of time t
  // the ball only covers v0 * (1 - exp(-drag*t)) / drag. Invert that to get the
  // launch speed that actually carries the ball the full distance, instead of
  // falling short as a naive distance/speed would.
  const k = PHYSICS.airDrag;
  const nominalTime = distance / speed;
  const reach = (1 - Math.exp(-k * nominalTime)) / k;
  const horizontalSpeed = reach > 0 ? Math.min(distance / reach, speed * 1.6) : speed;
  let flightTime = nominalTime;

  ball.velocity.x = (dx / distance) * horizontalSpeed;
  ball.velocity.z = (dz / distance) * horizontalSpeed;

  // Solve y: from.y + vy*t + 0.5*g*t^2 = ground  =>  vy = (ground - from.y - 0.5*g*t^2) / t
  const ground = PHYSICS.ballRadius;
  let vy = (ground - from.y - 0.5 * PHYSICS.gravity * flightTime * flightTime) / flightTime;

  // The solved arc can be too flat to clear the net — typically a short target
  // struck from deep, where the net sits late in the flight and the ball is
  // already falling by the time it gets there.
  //
  // Solve it directly rather than by trial: work out the vy that puts the ball
  // at the required height exactly over the net, and if that is more lift than
  // the flat arc has, adopt it and stretch the flight time so the ball still
  // lands on the target. Clearing the net wins over keeping the shot fast, so
  // a short target becomes a loopier drop shot instead of a netted drive.
  if (from.z * targetZ < 0) {
    const clearance = NET.height + PHYSICS.ballRadius + 0.25;
    const netFraction = Math.abs(from.z) / Math.abs(targetZ - from.z);

    // Raising vy to clear the net makes the ball land later, which moves the
    // net crossing later in the flight, which changes the height there — so
    // the two constraints have to be solved together. A handful of iterations
    // converges quickly; each pass lifts the arc and re-times the landing.
    for (let attempt = 0; attempt < 24; attempt++) {
      const tNet = flightTime * netFraction;
      const heightAtNet = from.y + vy * tNet + 0.5 * PHYSICS.gravity * tNet * tNet;
      if (heightAtNet >= clearance) break;

      // Lift enough to clear the net at the crossing time, with a little extra
      // each pass so the iteration makes progress rather than creeping.
      vy = (clearance - from.y - 0.5 * PHYSICS.gravity * tNet * tNet) / tNet + 0.35;

      // Re-time the landing for the new arc: positive root of
      // from.y + vy*t + 0.5*g*t^2 = ground.
      const a = 0.5 * PHYSICS.gravity;
      const discriminant = vy * vy - 4 * a * (from.y - ground);
      if (discriminant <= 0) break;
      const landingTime = (-vy - Math.sqrt(discriminant)) / (2 * a);
      if (landingTime <= 0) break;
      flightTime = landingTime;
    }

    // Re-fit the horizontal speed to the (now longer) flight so the ball still
    // lands on the target, compensating for drag the same way as above.
    const lifted = (1 - Math.exp(-k * flightTime)) / k;
    const finalSpeed = lifted > 0 ? distance / lifted : distance / flightTime;
    ball.velocity.x = (dx / distance) * finalSpeed;
    ball.velocity.z = (dz / distance) * finalSpeed;
  }

  ball.velocity.y = vy;
}

/** Clamp an aim point to somewhere inside the opponent's half. */
export function clampAim(
  aimX: number,
  aimZ: number,
  side: PlayerSide,
): { x: number; z: number } {
  const dir = attackDir(side);
  const x = Math.max(-COURT.halfWidth + 0.2, Math.min(COURT.halfWidth - 0.2, aimX));
  /*
   * Keep the target on the far side of the net and inside the baseline.
   *
   * The near limit is derived, not chosen. A player may stand no closer than
   * `netKeepout` and may reach `netReach` in front of themselves, so the
   * closest ball anyone can ever play is `netKeepout - netReach`. Allowing an
   * aim shorter than that would create a band of drop shots that are
   * physically unreturnable by either player, which is an instant-win exploit
   * as soon as somebody finds it. The small margin keeps such a shot hard but
   * legal rather than impossible.
   */
  const minZ = PLAYER.netKeepout - PLAYER.netReach + 0.25;
  const maxZ = COURT.halfLength - 0.4;
  const depth = Math.max(minZ, Math.min(maxZ, Math.abs(aimZ)));
  return { x, z: dir * depth };
}

/**
 * Can this player's racket reach the ball right now?
 *
 * Single source of truth so the auto-swing trigger and the swing itself can
 * never disagree. The volume is a flattened dome: full reach at racket height,
 * shrinking as the ball climbs, so a player has to actually be under a high
 * ball rather than swatting anything that drifts overhead.
 */
function canReachBall(player: PlayerState, ball: BallState, side: PlayerSide): boolean {
  if (ball.position.y > PLAYER.maxHitHeight) return false;

  // The ball must be travelling toward this player's side. This stops a player
  // hitting a ball that is already on its way back over the net.
  if (defendDir(side) * ball.velocity.z < 0) return false;

  // A player can only reach *toward* the net as far as their own position
  // allows; they cannot lean over it. Without this the two reach volumes meet
  // above the net and the ball is volleyed back and forth at head height
  // forever, never landing, so the point never ends.
  const ballDepth = defendDir(side) * ball.position.z;
  const playerDepth = defendDir(side) * player.position.z;
  if (ballDepth < playerDepth - PLAYER.netReach) return false;

  const dx = ball.position.x - player.position.x;
  const dz = ball.position.z - player.position.z;
  const horizontal = Math.hypot(dx, dz);

  // Reach shrinks with height: at racket height you get the full reach, at the
  // maximum hittable height you get roughly half.
  const racketHeight = 1.1;
  const heightExcess = Math.max(0, ball.position.y - racketHeight);
  const heightPenalty = heightExcess / (PLAYER.maxHitHeight - racketHeight);
  const effectiveReach = PLAYER.reach * (1 - 0.5 * heightPenalty);

  if (horizontal > effectiveReach) return false;

  // A ball is only playable on this player's own side of the net. Combined
  // with the net keepout (which is larger than the reach) this guarantees the
  // two players' reach volumes can never overlap.
  return defendDir(side) * ball.position.z >= 0;
}

function trySwing(
  snapshot: GameSnapshot,
  side: PlayerSide,
  input: PlayerInput,
  events: GameEvent[],
): void {
  const player = snapshot.players[side];
  const ball = snapshot.ball;

  if (player.swingCooldown > 0) return;
  if (ball.dead) return;

  // You cannot hit your own shot back.
  if (ball.lastHitBy === side) return;

  if (!canReachBall(player, ball, side)) return;

  const aim = clampAim(input.aimX, input.aimZ, side);
  const power = SHOT.basePower + (SHOT.maxPower - SHOT.basePower) * Math.min(1, input.charge);

  launchBall(ball, ball.position, aim.x, aim.z, power);
  ball.lastHitBy = side;
  ball.bouncesSinceHit = 0;

  player.swingCooldown = PLAYER.swingCooldown;
  player.swingTimer = 0.22;
  events.push({ type: 'hit', side, power: Math.min(1, input.charge) });
}

function serve(
  snapshot: GameSnapshot,
  side: PlayerSide,
  input: PlayerInput,
  events: GameEvent[],
): void {
  const ball = snapshot.ball;
  const player = snapshot.players[side];
  const aim = clampAim(input.aimX, input.aimZ, side);
  const power = SHOT.servePower + (SHOT.maxPower - SHOT.servePower) * Math.min(1, input.charge);

  launchBall(ball, ball.position, aim.x, aim.z, power);
  ball.lastHitBy = side;
  ball.bouncesSinceHit = 0;
  ball.dead = false;

  snapshot.match.phase = 'rally';
  player.swingCooldown = PLAYER.swingCooldown;
  player.swingTimer = 0.22;
  events.push({ type: 'hit', side, power: Math.min(1, input.charge) });
}

/** Did the ball land inside the singles court? */
function isInBounds(position: Vec3): boolean {
  return (
    Math.abs(position.x) <= COURT.halfWidth &&
    Math.abs(position.z) <= COURT.halfLength
  );
}

function stepBall(snapshot: GameSnapshot, dt: number, events: GameEvent[]): void {
  const ball = snapshot.ball;
  if (ball.dead) return;

  const previousZ = ball.position.z;

  // Air drag, then gravity.
  const drag = Math.max(0, 1 - PHYSICS.airDrag * dt);
  ball.velocity.x *= drag;
  ball.velocity.z *= drag;
  ball.velocity.y += PHYSICS.gravity * dt;

  ball.position.x += ball.velocity.x * dt;
  ball.position.y += ball.velocity.y * dt;
  ball.position.z += ball.velocity.z * dt;

  // --- Net ---
  // Detect the crossing rather than testing the current position, so a fast
  // ball cannot tunnel straight through the net between two ticks.
  const crossedNet = previousZ > 0 !== ball.position.z > 0;
  if (crossedNet && ball.position.y < NET.height + PHYSICS.ballRadius) {
    // Into the net: the striker loses the point.
    const striker = ball.lastHitBy;
    ball.position.z = 0;
    ball.velocity.z *= -NET.clipDamping;
    ball.velocity.x *= NET.clipDamping;
    ball.velocity.y = Math.min(ball.velocity.y, 0);
    events.push({ type: 'net' });
    if (striker !== null) {
      awardPoint(snapshot, striker === 0 ? 1 : 0, 'net', events);
    }
    return;
  }

  // --- Ground ---
  if (ball.position.y - PHYSICS.ballRadius <= 0) {
    ball.position.y = PHYSICS.ballRadius;
    ball.velocity.y = Math.abs(ball.velocity.y) * PHYSICS.bounceRestitution;
    ball.velocity.x *= PHYSICS.bounceFriction;
    ball.velocity.z *= PHYSICS.bounceFriction;
    ball.bouncesSinceHit += 1;
    events.push({ type: 'bounce', position: { ...ball.position } });

    const striker = ball.lastHitBy;
    if (striker === null) return;

    if (ball.bouncesSinceHit === 1) {
      // First bounce decides in/out.
      if (!isInBounds(ball.position)) {
        events.push({ type: 'out' });
        awardPoint(snapshot, striker === 0 ? 1 : 0, 'out', events);
        return;
      }
      // Landing on the striker's own side means it never crossed: also out.
      const landedOnStrikerSide = defendDir(striker) * ball.position.z > 0;
      if (landedOnStrikerSide) {
        events.push({ type: 'out' });
        awardPoint(snapshot, striker === 0 ? 1 : 0, 'out', events);
      }
      return;
    }

    if (ball.bouncesSinceHit >= 2) {
      // Two bounces before the opponent returned it: the striker wins.
      awardPoint(snapshot, striker, 'double-bounce', events);
    }
  }

  // Ball that sails far past the playfield without bouncing (e.g. a huge lob)
  // is still out; catch it so play cannot stall.
  const farLimit = COURT.halfLength + COURT.runoffZ + 6;
  const wideLimit = COURT.halfWidth + COURT.runoffX + 6;
  if (Math.abs(ball.position.z) > farLimit || Math.abs(ball.position.x) > wideLimit) {
    const striker = ball.lastHitBy;
    events.push({ type: 'out' });
    if (striker !== null) {
      awardPoint(snapshot, striker === 0 ? 1 : 0, 'out', events);
    } else {
      ball.dead = true;
    }
  }
}

/**
 * Advance the world by one fixed tick.
 *
 * Returns the events that happened, for sound and UI callouts. The snapshot is
 * mutated in place; callers that need to send it should serialise it after.
 */
export function step(
  snapshot: GameSnapshot,
  inputs: [PlayerInput, PlayerInput],
  dt: number = TICK,
): GameEvent[] {
  const events: GameEvent[] = [];
  const match = snapshot.match;

  // A paused match (an opponent has dropped) freezes completely: no movement,
  // no physics, no clocks. The score and positions are preserved exactly, so
  // the rejoining player resumes mid-point rather than losing the rally.
  if (snapshot.paused) return events;

  // Record what we consumed, so the guest can tell which of its predicted
  // inputs the host has now accounted for.
  snapshot.ackedSeq[0] = inputs[0].seq;
  snapshot.ackedSeq[1] = inputs[1].seq;

  stepPlayer(snapshot.players[0], inputs[0], 0, dt);
  stepPlayer(snapshot.players[1], inputs[1], 1, dt);

  if (match.phase === 'point-over') {
    match.resetTimer -= dt;
    if (match.resetTimer <= 0) resetForNextPoint(snapshot);
    snapshot.tick += 1;
    return events;
  }

  if (match.phase === 'match-over') {
    snapshot.tick += 1;
    return events;
  }

  if (match.phase === 'serving') {
    // The ball rides along with the server until they strike it.
    const server = match.server;
    const player = snapshot.players[server];
    snapshot.ball.position.x = player.position.x + 0.5 * attackDir(server);
    snapshot.ball.position.y = 1.25;
    snapshot.ball.position.z = player.position.z + 0.35 * attackDir(server);
    snapshot.ball.velocity = vec();

    if (inputs[server].shoot) {
      serve(snapshot, server, inputs[server], events);
    }
    snapshot.tick += 1;
    return events;
  }

  // Rally: both players may swing, then the ball moves.
  for (const side of [0, 1] as PlayerSide[]) {
    // A swing fires on click, or automatically when the ball is in range so a
    // player never simply whiffs.
    const input = inputs[side];
    const player = snapshot.players[side];
    const ball = snapshot.ball;

    // A click always attempts a swing (trySwing re-checks reach itself), so
    // the player can volley deliberately.
    if (input.shoot) {
      trySwing(snapshot, side, input, events);
      continue;
    }

    // Auto-swing is the safety net for a player who does not click, so it only
    // fires once the ball has bounced and is at a comfortable hitting height.
    // Volleying straight out of the air has to be a deliberate click, which is
    // what stops two well-positioned players from rallying in mid-air forever.
    const isGroundstroke = ball.bouncesSinceHit >= 1;
    const comfortableHeight = ball.position.y <= PLAYER.autoSwingHeight;
    if (isGroundstroke && comfortableHeight && canReachBall(player, ball, side)) {
      trySwing(snapshot, side, input, events);
    }
  }

  stepBall(snapshot, dt, events);
  snapshot.tick += 1;
  return events;
}
