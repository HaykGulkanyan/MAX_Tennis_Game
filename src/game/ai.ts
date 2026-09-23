/**
 * The computer opponent.
 *
 * An AI controller is just an `InputSource` (see `engine.ts`) with memory, so
 * the host can drop one straight into `remoteInput` and the simulation never
 * learns that a human is not on the other end. All the state lives in a
 * closure; nothing here mutates the snapshot.
 *
 * The central idea is that good tennis is positioning, not reflexes. The
 * controller predicts where the ball will *land*, then where it will be after
 * it bounces, and walks there early. Chasing the ball's current position is
 * what makes a naive bot look drunk: it is always a metre behind and arrives as
 * the ball leaves.
 *
 * Difficulty is expressed as prediction error, reaction delay and how early the
 * AI commits its feet, never as movement speed. The numbers are stark: crossing
 * the whole court takes about 0.7s while shots land about 1.75s apart, so a
 * "slow" player still strolls to the right spot in time and plays exactly as
 * well. Only being wrong about *where* to go, being late to decide, or having
 * stopped adjusting before the ball arrives actually costs points.
 *
 * One constraint from the rules shapes all of this: `clampAim` pulls every aim
 * point back inside the lines before launching, so the AI cannot lose a point
 * by aiming out. Unforced errors do not exist here, which means a rally only
 * ends when somebody genuinely fails to reach the ball, and the error knobs
 * have to be large enough to consume the racket's 2.1m reach to have any effect
 * at all.
 *
 * Randomness comes from a seeded mulberry32 generator kept in the closure
 * rather than `Math.random()`. The AI only ever runs on the host so global
 * randomness would not break network determinism, but a fixed seed means a
 * misbehaving bot replays identically while debugging, which is worth the
 * fifteen lines.
 */

import { COURT, PHYSICS, PLAYER, TICK } from './constants';
import type { Difficulty, GameSnapshot, PlayerInput, PlayerSide } from './types';

/**
 * mulberry32: tiny, fast, good enough statistically for jitter and coin flips.
 * Returns values in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Tuning = {
  /** Seconds before the controller reacts to a new incoming shot. */
  reactionDelay: number;
  /** How often the target is refreshed while tracking, in seconds. */
  retargetInterval: number;
  /** Metres of lateral error injected into the predicted intercept. */
  predictionError: number;
  /** 0 = aims down the middle, 1 = aims at the corner. */
  aimAggression: number;
  /** Probability that any given shot is charged at all. */
  chargeChance: number;
  /** Ceiling on the charge when it does charge. */
  chargeMax: number;
  /** Metres of random noise added to the aim point. */
  aimJitter: number;
  /**
   * How far outside the lines a ball must be predicted to land before this AI
   * will let it go. A large margin means it only leaves the obvious ones and
   * plays balls that were already out, gifting points back.
   */
  outMargin: number;
  /**
   * Chance per shot of leaving the recovery a beat late, so a well-placed reply
   * catches this AI out of position. Models watching your own shot instead of
   * splitting back to the middle.
   */
  lazyRecoveryChance: number;
  /**
   * Seconds before the ball arrives at which this AI stops adjusting its feet
   * and commits to wherever it is standing.
   *
   * This is what turns prediction error into missed balls. Without it the AI
   * keeps re-solving every fraction of a second right up to contact, so even a
   * large error is corrected in the final moments and it reaches everything:
   * there is far more time between shots (about 1.75s) than it takes to cross
   * the court (about 0.7s), so late correction is always enough. Freezing the
   * target early means a bad read actually costs the point.
   */
  commitWindow: number;
};

const TUNING: Record<Difficulty, Tuning> = {
  easy: {
    reactionDelay: 0.62,
    retargetInterval: 0.55,
    predictionError: 2.6,
    aimAggression: 0.15,
    chargeChance: 0.06,
    chargeMax: 0.3,
    aimJitter: 1.5,
    outMargin: 1.4,
    lazyRecoveryChance: 0.45,
    commitWindow: 0.75,
  },
  medium: {
    reactionDelay: 0.3,
    retargetInterval: 0.25,
    predictionError: 1.55,
    aimAggression: 0.55,
    chargeChance: 0.35,
    chargeMax: 0.7,
    aimJitter: 0.7,
    outMargin: 0.5,
    lazyRecoveryChance: 0.18,
    commitWindow: 0.42,
  },
  hard: {
    reactionDelay: 0.07,
    retargetInterval: 0.1,
    predictionError: 0.62,
    aimAggression: 0.95,
    chargeChance: 0.75,
    chargeMax: 1,
    aimJitter: 0.22,
    outMargin: 0.12,
    lazyRecoveryChance: 0.05,
    commitWindow: 0.12,
  },
};

/** Side 0 defends -Z; side 1 defends +Z. Mirrors `simulation.ts`. */
const defendDir = (side: PlayerSide): number => (side === 0 ? -1 : 1);
const attackDir = (side: PlayerSide): number => (side === 0 ? 1 : -1);

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** Replaces NaN/Infinity with a fallback, so a degenerate solve cannot escape. */
const finite = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

/**
 * Time until a projectile starting at `y` with vertical speed `vy` reaches
 * `targetY`, or null when it never gets there. Positive root of
 * y + vy*t + 0.5*g*t^2 = targetY.
 */
function timeToHeight(y: number, vy: number, targetY: number): number | null {
  const a = 0.5 * PHYSICS.gravity;
  const c = y - targetY;
  const discriminant = vy * vy - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  // Two roots; take the later one, which is the descent through targetY.
  const t1 = (-vy + root) / (2 * a);
  const t2 = (-vy - root) / (2 * a);
  const t = Math.max(t1, t2);
  return t > 0 && Number.isFinite(t) ? t : null;
}

/**
 * Horizontal distance travelled in `t` seconds at launch speed `v0` under the
 * simulation's exponential drag. `stepBall` multiplies velocity by
 * (1 - drag*dt) each tick, which integrates to v0 * exp(-drag * t), so the
 * distance covered is v0 * (1 - exp(-drag*t)) / drag.
 */
function dragDistance(v0: number, t: number): number {
  const k = PHYSICS.airDrag;
  if (k <= 0) return v0 * t;
  return (v0 * (1 - Math.exp(-k * t))) / k;
}

/** Velocity remaining after `t` seconds of the same drag. */
const dragVelocity = (v0: number, t: number): number =>
  v0 * Math.exp(-PHYSICS.airDrag * t);

type Intercept = {
  x: number;
  z: number;
  /** Seconds from now until the AI should be standing there. */
  time: number;
  /**
   * Where the ball is predicted to bounce for the first time, which is the
   * point `isInBounds` judges. Null when it has already bounced.
   */
  landing: { x: number; z: number } | null;
};

/**
 * Where to stand to play the incoming ball.
 *
 * Two stages, because the auto-swing in `simulation.ts` only fires once
 * `bouncesSinceHit >= 1` and the ball is below `autoSwingHeight`: standing on
 * the first landing spot is too early, the ball is still overhead there on the
 * way down and then kicks away. So we solve the bounce, then follow the ball
 * back down through comfortable racket height and meet it there.
 */
function predictIntercept(snapshot: GameSnapshot): Intercept | null {
  const ball = snapshot.ball;
  const ground = PHYSICS.ballRadius;

  let x = ball.position.x;
  let y = ball.position.y;
  let z = ball.position.z;
  let vx = ball.velocity.x;
  let vy = ball.velocity.y;
  let vz = ball.velocity.z;
  let elapsed = 0;

  // If the ball has not bounced yet, fly it to the ground and bounce it. Two
  // bounces is the most that can ever matter: a second one ends the point.
  let landing: { x: number; z: number } | null = null;
  const bouncesLeft = ball.bouncesSinceHit >= 1 ? 0 : 1;
  for (let bounce = 0; bounce < bouncesLeft; bounce++) {
    const t = timeToHeight(y, vy, ground);
    if (t === null) return null;

    x += dragDistance(vx, t);
    z += dragDistance(vz, t);
    landing = { x, z };
    vx = dragVelocity(vx, t) * PHYSICS.bounceFriction;
    vz = dragVelocity(vz, t) * PHYSICS.bounceFriction;
    vy = Math.abs(vy + PHYSICS.gravity * t) * PHYSICS.bounceRestitution;
    y = ground;
    elapsed += t;
  }

  // Now find the moment the ball comes back down to a comfortable hitting
  // height. Aiming at that point rather than the bounce means the AI is already
  // planted when the auto-swing window opens.
  const strikeHeight = Math.min(PLAYER.autoSwingHeight * 0.75, 1.1);
  let strikeTime = timeToHeight(y, vy, strikeHeight);
  if (strikeTime === null || strikeTime < 0) {
    // Ball is already below racket height (a low skidding shot): meet it where
    // it next touches down instead.
    strikeTime = timeToHeight(y, vy, ground) ?? 0;
  }

  x += dragDistance(vx, strikeTime);
  z += dragDistance(vz, strikeTime);
  elapsed += strikeTime;

  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(elapsed)) return null;
  return { x, z, time: elapsed, landing };
}

/** Standing spot when there is nothing to chase: centred, just off the baseline. */
function readyPosition(side: PlayerSide): { x: number; z: number } {
  return { x: 0, z: defendDir(side) * (COURT.halfLength - 1.4) };
}

/**
 * Is this ball the AI's problem? Only when it is live and heading into the half
 * this side defends. Anything else means recover, not chase.
 */
function ballIsIncoming(snapshot: GameSnapshot, side: PlayerSide): boolean {
  const ball = snapshot.ball;
  if (ball.dead) return false;
  if (snapshot.match.phase !== 'rally') return false;
  // You cannot play your own shot back, so while the ball is still ours it is
  // the opponent's turn and we should be recovering.
  if (ball.lastHitBy === side) return false;
  // Travelling toward our baseline, or already sitting on our side.
  const approaching = defendDir(side) * ball.velocity.z > 0;
  const onOurSide = defendDir(side) * ball.position.z > 0;
  return approaching || onOurSide;
}

export function createAi(
  difficulty: Difficulty,
  side: PlayerSide,
): {
  (snapshot: GameSnapshot, side: PlayerSide): PlayerInput;
  reset(): void;
} {
  const tuning = TUNING[difficulty];

  // Seed from the difficulty and side so two AIs of the same difficulty do not
  // roll identical shots in lockstep, while each stays reproducible run to run.
  // `difficulty.length` alone is a poor mixer ("easy" and "hard" are both 4),
  // so hash the characters.
  let difficultyHash = 0x811c9dc5;
  for (let i = 0; i < difficulty.length; i++) {
    difficultyHash = Math.imul(difficultyHash ^ difficulty.charCodeAt(i), 0x01000193);
  }
  const seedBase = (0x9e3779b9 ^ Math.imul(side + 1, 0x85ebca6b) ^ difficultyHash) >>> 0;
  let random = mulberry32(seedBase);

  let seq = 0;
  /** Where we are currently walking to, in world coordinates. */
  let targetX = 0;
  let targetZ = 0;
  /** Aim point, refreshed with the target so the shot is not re-rolled per tick. */
  let aimX = 0;
  let aimZ = 0;
  /** Seconds since the opponent last struck; drives the reaction delay. */
  let sinceShot = Number.POSITIVE_INFINITY;
  /** Seconds since the target was last refreshed. */
  let sinceRetarget = Number.POSITIVE_INFINITY;
  /** Charge decided once per shot rather than re-rolled every tick. */
  let plannedCharge = 0;
  /** Detects a new incoming shot: `lastHitBy` flipping to the opponent. */
  let lastSeenHitter: PlayerSide | null = null;
  let lastSeenTick = -1;
  /** Serve is committed one tick after the aim is chosen, so the aim lands first. */
  let serveArmed = false;
  /** Whether this shot's recovery is skipped; decided once per incoming ball. */
  let lazyThisShot = false;
  /** Set once the ball is too close to keep adjusting; cleared on the next shot. */
  let committed = false;

  function resetState(controlled: PlayerSide): void {
    const ready = readyPosition(controlled);
    targetX = ready.x;
    targetZ = ready.z;
    aimX = 0;
    aimZ = attackDir(controlled) * (COURT.halfLength - 2.5);
    sinceShot = Number.POSITIVE_INFINITY;
    sinceRetarget = Number.POSITIVE_INFINITY;
    plannedCharge = 0;
    lastSeenHitter = null;
    lastSeenTick = -1;
    serveArmed = false;
    lazyThisShot = false;
    committed = false;
  }

  resetState(side);

  /**
   * Pick a target in the opponent's half, biased away from where they are
   * standing. Aggression decides how close to the corner we dare go; jitter
   * stops every shot from landing on the same square metre.
   */
  function chooseAim(snapshot: GameSnapshot, controlled: PlayerSide): void {
    const opponent = snapshot.players[controlled === 0 ? 1 : 0];
    const opponentX = finite(opponent?.position.x ?? 0, 0);

    // Hit to the side they are not on. When they are dead centre the sign is
    // arbitrary, so let the PRNG break the tie instead of always going left.
    const away = opponentX > 0.15 ? -1 : opponentX < -0.15 ? 1 : random() < 0.5 ? -1 : 1;
    // Decide the power first, because how hard this ball is struck determines
    // how deep it can safely be aimed (see below).
    plannedCharge =
      random() < tuning.chargeChance ? tuning.chargeMax * (0.6 + 0.4 * random()) : 0;

    // Kept inside the sideline for the same reason as the depth below: a ball
    // landing on the line bounces on out of the playfield and is scored against
    // the striker. "Corner" here means the corner of the safe zone.
    const corner = (COURT.halfWidth - 1.1) * away;
    // Interpolate between the middle and the corner by aggression: easy plays
    // safe through the centre, hard goes for the line.
    const base = corner * tuning.aimAggression;
    const jitter = (random() * 2 - 1) * tuning.aimJitter;

    aimX = clamp(base + jitter, -COURT.halfWidth + 0.6, COURT.halfWidth - 0.6);

    // Depth: mostly deep, occasionally short to move them forward.
    //
    // The ceiling on "deep" is not the baseline. A ball landing near the line
    // is in, but it keeps most of its pace through the bounce
    // (`bounceFriction` is 0.86) and carries on past the playfield's far limit,
    // where `stepBall` scores it against the striker however good the shot was.
    // Harder shots run further after bouncing, so the safe ceiling drops as the
    // charge rises; these numbers come from simulating the bounce-out directly.
    const safeDepth = COURT.halfLength - 1.9 - 2.2 * plannedCharge;
    const short = COURT.serviceLine + 0.6;
    const goShort = random() < 0.18 * tuning.aimAggression;
    const depth = goShort ? short : safeDepth - random() * 1.6;

    aimZ = attackDir(controlled) * depth;
  }

  /** Refresh the standing target from a fresh ballistic solve. */
  function retarget(snapshot: GameSnapshot, controlled: PlayerSide): void {
    const intercept = predictIntercept(snapshot);
    const ready = readyPosition(controlled);

    if (!intercept) {
      targetX = ready.x;
      targetZ = ready.z;
      return;
    }

    // Letting a ball go is a real tennis skill, and skipping it is expensive:
    // `isInBounds` judges only the first bounce, so a ball heading long is a
    // free point, but running it down and returning it hands that point back.
    // Judge the call against a margin, so a weak AI misreads the close ones and
    // plays balls it should have left; a strong AI trusts a narrower margin.
    if (intercept.landing) {
      const margin = tuning.outMargin;
      const goingWide = Math.abs(intercept.landing.x) > COURT.halfWidth + margin;
      const goingLong = Math.abs(intercept.landing.z) > COURT.halfLength + margin;
      if (
        Number.isFinite(intercept.landing.x) &&
        Number.isFinite(intercept.landing.z) &&
        (goingWide || goingLong)
      ) {
        // Shadow the ball laterally rather than returning to centre, so a bad
        // read can still be rescued if it drops in after all.
        targetX = clamp(intercept.landing.x, -COURT.halfWidth, COURT.halfWidth);
        targetZ = ready.z;
        return;
      }
    }

    // Once the ball is nearly here, stop fiddling with the feet and play
    // whatever position we are in. See `commitWindow`: without this the endless
    // re-solves wash out the prediction error entirely and the AI is perfect.
    if (intercept.time <= tuning.commitWindow) {
      committed = true;
      return;
    }

    // Prediction error is the difficulty knob that actually bites. Scale it up
    // slightly when the ball is still far out, so a weak AI commits early to a
    // wrong spot and has to scramble, exactly like a real misread.
    const uncertainty = 1 + clamp(intercept.time, 0, 1.5) * 0.4;
    const errorX = (random() * 2 - 1) * tuning.predictionError * uncertainty;
    const errorZ = (random() * 2 - 1) * tuning.predictionError * 0.6 * uncertainty;

    const limitX = COURT.halfWidth + COURT.runoffX;

    targetX = clamp(finite(intercept.x + errorX, ready.x), -limitX, limitX);

    // Stand a little behind the ball rather than on top of it: `canReachBall`
    // refuses anything more than `netReach` in front of the player, so being
    // short of the bounce is a whiff while being deep of it still connects.
    const depth = defendDir(controlled) * finite(intercept.z + errorZ, ready.z) + 0.45;

    // Cap the retreat well short of the back fence. A deep ball keeps climbing
    // away after the bounce, so the point where it next falls to racket height
    // can be metres behind the baseline; chasing that point literally backs the
    // AI into the fence, from where it still returns everything and no rally
    // can ever end. Refusing to retreat past here means a genuinely deep ball
    // has to be taken early or not at all, which is what makes depth a weapon.
    const maxRetreat = COURT.halfLength + 1.2;
    const clampedDepth = clamp(depth, PLAYER.netKeepout, maxRetreat);
    targetZ = defendDir(controlled) * clampedDepth;
  }

  function controller(snapshot: GameSnapshot, controlledSide: PlayerSide): PlayerInput {
    seq += 1;

    // Defend against a malformed or half-initialised snapshot; the engine polls
    // input every tick including during teardown, and a throw here would kill
    // the whole game loop.
    const controlled: PlayerSide = controlledSide === 1 ? 1 : 0;
    const self = snapshot?.players?.[controlled];
    const ball = snapshot?.ball;
    const match = snapshot?.match;
    if (!self || !ball || !match) {
      return { seq, moveX: 0, moveZ: 0, aimX: 0, aimZ: 0, shoot: false, charge: 0 };
    }

    // The engine ticks at a fixed rate, so counting ticks is a sound clock and
    // avoids depending on wall time (which would make the AI react faster on a
    // faster machine).
    if (match.phase === 'rally' || match.phase === 'serving') {
      sinceShot += TICK;
      sinceRetarget += TICK;
    }

    // A tick going backwards means the match restarted underneath us.
    if (snapshot.tick < lastSeenTick) resetState(controlled);
    lastSeenTick = snapshot.tick;

    const ready = readyPosition(controlled);

    // --- Between points -------------------------------------------------
    if (match.phase === 'point-over' || match.phase === 'match-over') {
      lastSeenHitter = null;
      serveArmed = false;
      targetX = ready.x;
      targetZ = ready.z;
      return {
        seq,
        ...moveToward(self.position.x, self.position.z, targetX, targetZ),
        aimX,
        aimZ,
        shoot: false,
        charge: 0,
      };
    }

    // --- Serving --------------------------------------------------------
    if (match.phase === 'serving') {
      lastSeenHitter = null;
      sinceShot = 0;
      sinceRetarget = Number.POSITIVE_INFINITY;

      if (match.server !== controlled) {
        // Receiving: wait on the baseline, shaded to cover the wider angle.
        serveArmed = false;
        targetX = ready.x;
        targetZ = ready.z;
        return {
          seq,
          ...moveToward(self.position.x, self.position.z, targetX, targetZ),
          aimX,
          aimZ,
          shoot: false,
          charge: 0,
        };
      }

      // Serving: pick a target once, stand still, then strike. Choosing the aim
      // a tick before shooting matters because `serve` reads the aim off the
      // very input that carries `shoot`, and holding position avoids serving
      // while drifting sideways.
      if (!serveArmed) {
        chooseAim(snapshot, controlled);
        // A serve must land in the opponent's court; bias it deep and keep it
        // inside the lines with room to spare, since a fault is a free point.
        aimX = clamp(aimX * 0.8, -COURT.halfWidth + 0.8, COURT.halfWidth - 0.8);
        aimZ = attackDir(controlled) * (COURT.serviceLine + 1.2 + random() * 2.0);
        serveArmed = true;
        return {
          seq,
          moveX: 0,
          moveZ: 0,
          aimX,
          aimZ,
          shoot: false,
          charge: plannedCharge,
        };
      }

      serveArmed = false;
      return {
        seq,
        moveX: 0,
        moveZ: 0,
        aimX,
        aimZ,
        shoot: true,
        charge: plannedCharge,
      };
    }

    // --- Rally ----------------------------------------------------------
    serveArmed = false;

    // Detect the opponent striking: that is the instant the reaction clock
    // starts, and the moment to plan the reply.
    if (ball.lastHitBy !== lastSeenHitter) {
      lastSeenHitter = ball.lastHitBy;
      if (ball.lastHitBy !== null && ball.lastHitBy !== controlled) {
        sinceShot = 0;
        sinceRetarget = Number.POSITIVE_INFINITY;
        chooseAim(snapshot, controlled);
        // Decide up front whether this reply gets a proper recovery, so the
        // choice holds for the whole shot instead of flickering per tick.
        lazyThisShot = random() < tuning.lazyRecoveryChance;
        committed = false;
      }
    }

    const incoming = ballIsIncoming(snapshot, controlled);

    if (!incoming) {
      // Our shot is on its way over, or the ball is dead: recover to the middle
      // of the likely replies rather than admiring the shot. A lazy recovery
      // skips the split back to centre, which is what leaves a weak AI wrong
      // footed by a decent reply.
      if (!lazyThisShot) {
        targetX = ready.x;
        targetZ = ready.z;
      }
    } else if (
      !committed &&
      sinceShot >= tuning.reactionDelay &&
      sinceRetarget >= tuning.retargetInterval
    ) {
      // This is the entire difficulty mechanism: *when* the stored target is
      // refreshed, and how wrong it is. Movement speed is untouched, because at
      // these court dimensions even a sluggish player arrives in time.
      retarget(snapshot, controlled);
      sinceRetarget = 0;
    }

    const move = moveToward(self.position.x, self.position.z, targetX, targetZ);

    // The simulation auto-swings for us once the ball has bounced and is at a
    // comfortable height, so clicking is only worth it for a deliberate volley:
    // ball still in the air, in reach, and we wanted power anyway. Easy almost
    // never does this because `chargeChance` keeps `plannedCharge` at zero.
    const wantsVolley =
      incoming &&
      plannedCharge > 0 &&
      ball.bouncesSinceHit === 0 &&
      self.swingCooldown <= 0 &&
      withinReach(self.position.x, self.position.z, ball.position, controlled);

    return {
      seq,
      moveX: move.moveX,
      moveZ: move.moveZ,
      aimX: finite(aimX, 0),
      aimZ: finite(aimZ, attackDir(controlled) * COURT.serviceLine),
      shoot: wantsVolley,
      charge: clamp(finite(plannedCharge, 0), 0, 1),
    };
  }

  controller.reset = (): void => {
    resetState(side);
    seq = 0;
    // Rewind the PRNG too, so a restarted match replays identically.
    random = mulberry32(seedBase);
  };

  return controller;
}

/**
 * Unit-ish movement vector toward a point, easing off inside a small deadzone.
 *
 * The deadzone stops the classic jitter where a player overshoots by a few
 * centimetres and oscillates around the target forever.
 */
function moveToward(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): { moveX: number; moveZ: number } {
  const dx = finite(toX - fromX, 0);
  const dz = finite(toZ - fromZ, 0);
  const distance = Math.hypot(dx, dz);
  if (!Number.isFinite(distance) || distance < 0.08) return { moveX: 0, moveZ: 0 };

  // Ease into the last half-metre so the approach settles instead of skidding
  // past; beyond that, run flat out.
  const scale = Math.min(1, distance / 0.5) / distance;
  return { moveX: clamp(dx * scale, -1, 1), moveZ: clamp(dz * scale, -1, 1) };
}

/** Cheap mirror of the simulation's reach test, used only to decide on volleys. */
function withinReach(
  playerX: number,
  playerZ: number,
  ballPosition: { x: number; y: number; z: number },
  side: PlayerSide,
): boolean {
  if (ballPosition.y > PLAYER.maxHitHeight) return false;
  if (defendDir(side) * ballPosition.z < 0) return false;
  // Do not swing at something in front of us that the racket cannot reach.
  if (defendDir(side) * ballPosition.z < defendDir(side) * playerZ - PLAYER.netReach) return false;
  // Slightly tighter than the real test, so a click is never wasted on a ball
  // hovering right at the edge of the dome.
  return Math.hypot(ballPosition.x - playerX, ballPosition.z - playerZ) <= PLAYER.reach * 0.8;
}
