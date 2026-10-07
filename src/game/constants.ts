/**
 * Court geometry and physics tuning.
 *
 * World axes: X = sideline to sideline, Y = up, Z = baseline to baseline.
 * The net sits at Z = 0. Player 0 ("host") defends negative Z, player 1
 * defends positive Z. Dimensions are scaled-down real tennis (metres),
 * shrunk a little so rallies stay lively at arcade speeds.
 */

export const COURT = {
  /** Half-width of the singles court (sideline to centre). */
  halfWidth: 4.1,
  /** Distance from the net to a baseline. */
  halfLength: 11.9,
  /** Distance from the net to a service line. */
  serviceLine: 6.4,
  /** Playfield padding beyond the lines that players may run into. */
  runoffX: 3.2,
  runoffZ: 3.4,
  netHeight: 1.07,
  lineWidth: 0.08,
} as const;

export const PHYSICS = {
  gravity: -9.8,
  /** Energy kept after a bounce off the court surface. */
  bounceRestitution: 0.62,
  /** Horizontal speed kept after a bounce (surface friction). */
  bounceFriction: 0.86,
  /** Per-second air drag applied to ball velocity. */
  airDrag: 0.12,
  ballRadius: 0.14,
  /** Ball is dead below this height once it has stopped mattering. */
  restHeight: 0.02,
} as const;

export const PLAYER = {
  radius: 0.42,
  height: 1.8,
  /**
   * Running speed.
   *
   * This is the main lever on whether placement can win a point, so it is
   * worth recording the arithmetic. A fully charged shot crosses the court in
   * about 1.16s; a corner-to-corner recovery run (less the racket's reach)
   * takes `(2 * halfWidth - reach) / moveSpeed`. At the original 9.4 that run
   * was 0.65s, leaving half a second spare on the hardest shot in the game, so
   * a well-placed winner was always retrieved and rallies only ended on
   * unforced errors. At 7.0 the same run takes 0.87s, which leaves the
   * defender stretched but not helpless.
   *
   * If rallies feel too short, raise this before touching the shot speeds.
   */
  moveSpeed: 7.0,
  /** How quickly a player reaches full speed / stops (higher = snappier). */
  acceleration: 26,
  /** Horizontal distance at which the racket can reach the ball. */
  reach: 2.1,
  /** Ball must be below this height to be hittable. */
  maxHitHeight: 3.0,
  /** Cooldown after a swing so one approach cannot hit twice. */
  swingCooldown: 0.34,
  /**
   * Closest a player may stand to the net.
   *
   * This MUST stay greater than `reach`, otherwise a player parked at the net
   * can reach across it: both players then volley the same ball at head height
   * near the net, it never touches the ground, and the point can never end.
   * The volley zone starts just behind the service line instead.
   */
  netKeepout: 2.6,
  /**
   * How far toward the net a player may reach in front of themselves. Smaller
   * than `reach` (which applies sideways and behind), so a volleyer has to
   * commit to a position rather than covering the whole forecourt.
   */
  netReach: 1.0,
  /**
   * How far behind the baseline the server starts each point. Until the serve
   * is struck the server may not step over the baseline (a foot fault in real
   * tennis), so they start just behind it with room to shuffle sideways.
   */
  serveStandBack: 0.5,
  /**
   * Highest ball the automatic swing will take by itself. Above this the
   * player must click to volley, which keeps the auto-swing helpful without
   * letting two players trade the ball in mid-air indefinitely.
   */
  autoSwingHeight: 1.9,
} as const;

/**
 * Shot speeds. Because the launch solver aims at a point, speed controls how
 * hard and flat a shot is rather than how far it travels: a charged shot
 * arrives sooner on a lower arc, giving the opponent less time to get there.
 */
export const SHOT = {
  /** Speed of an uncharged shot. */
  basePower: 14.0,
  /**
   * Floor on shot speed. The net-clearance solver slows a shot down to raise
   * its arc; without a floor a shot aimed short from near the net becomes a
   * feeble lob that never reaches the other side.
   */
  minPower: 9.0,
  /** Speed of a fully charged shot. */
  maxPower: 22.0,
  /** Seconds of holding right mouse to reach full charge. */
  chargeTime: 1.1,
  /** Serve speed at zero charge. */
  servePower: 15.0,
} as const;

export const MATCH = {
  /** First to this many points wins, but must win by 2. */
  pointsToWin: 11,
  /** Seconds between a point ending and the next serve. */
  pointResetDelay: 1.6,
} as const;

export const NET = {
  /** Ball hitting the net below this height is stopped dead. */
  height: COURT.netHeight,
  /** How much horizontal speed survives clipping the net cord. */
  clipDamping: 0.25,
} as const;

/** Fixed simulation step, in seconds. The host advances physics on this clock. */
export const TICK = 1 / 60;

/** How often the host broadcasts a state snapshot, in seconds. */
export const SNAPSHOT_INTERVAL = 1 / 20;

export const SHIRT_COLORS = [
  '#e8503a',
  '#2f7fe8',
  '#37b46b',
  '#f0b429',
  '#9b51e0',
  '#14b8b0',
] as const;
