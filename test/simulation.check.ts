/** Headless sanity checks for the tennis simulation. */
import { createInitialSnapshot, step, resetMatch, predictPlayer } from '../src/game/simulation';
import { gameCall, gameScore, matchCall, pointCall, pointLabel } from '../src/game/tennisScore';
import { EMPTY_INPUT } from '../src/game/types';
import type { GameSnapshot, PlayerInput, GameEvent } from '../src/game/types';
import { COURT, MATCH } from '../src/game/constants';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) { failures++; console.log(`FAIL  ${label} ${detail}`); }
  else console.log(`ok    ${label} ${detail}`);
}

const inp = (o: Partial<PlayerInput> = {}): PlayerInput => ({ ...EMPTY_INPUT, ...o });

// --- 1. Serve gets the ball moving and switches to rally ---
{
  const s = createInitialSnapshot();
  check('starts in serving phase', s.match.phase === 'serving');
  check('server is side 0', s.match.server === 0);
  const ev = step(s, [inp({ shoot: true, aimX: 0, aimZ: 6 }), inp()]);
  check('serve -> rally', s.match.phase === 'rally', `phase=${s.match.phase}`);
  check('serve emits hit', ev.some(e => e.type === 'hit'));
  check('ball moving downcourt (+z)', s.ball.velocity.z > 0, `vz=${s.ball.velocity.z.toFixed(2)}`);
  check('ball has lift', s.ball.velocity.y > 0, `vy=${s.ball.velocity.y.toFixed(2)}`);
}

// --- 2. A served ball that nobody returns lands in, bounces twice, server wins ---
// The receiver is parked off court: auto-swing would otherwise (correctly)
// return a serve that lands within reach, and this checks the serve itself.
{
  const s = createInitialSnapshot();
  step(s, [inp({ shoot: true, aimX: 0, aimZ: 6 }), inp()]);
  let bounces = 0;
  let landedInbounds: boolean | null = null;
  for (let i = 0; i < 1200 && s.match.phase === 'rally'; i++) {
    s.players[1].position.x = 60;
    const ev = step(s, [inp(), inp()]);
    for (const e of ev) {
      if (e.type === 'bounce') {
        bounces++;
        if (bounces === 1) landedInbounds = Math.abs(e.position.x) <= COURT.halfWidth && Math.abs(e.position.z) <= COURT.halfLength;
      }
    }
  }
  check('unreturned serve ends point', s.match.phase !== 'rally', `phase=${s.match.phase}`);
  check('serve landed in bounds', landedInbounds === true, `inbounds=${landedInbounds}`);
  check('server (0) won the point', s.match.lastPointWinner === 0, `winner=${s.match.lastPointWinner} reason=${s.match.reason}`);
  check('score is 1-0', s.match.scores[0] === 1 && s.match.scores[1] === 0, `${s.match.scores}`);
  // Real tennis: the server keeps the serve for the whole game.
  check('server keeps serving within the game', s.match.server === 0, `server=${s.match.server}`);
}

// --- 3. Point-over auto-resets to serving ---
{
  const s = createInitialSnapshot();
  step(s, [inp({ shoot: true, aimZ: 6 }), inp()]);
  for (let i = 0; i < 1200 && s.match.phase === 'rally'; i++) step(s, [inp(), inp()]);
  check('phase point-over', s.match.phase === 'point-over', `phase=${s.match.phase}`);
  for (let i = 0; i < 200 && s.match.phase === 'point-over'; i++) step(s, [inp(), inp()]);
  check('resets to serving', s.match.phase === 'serving', `phase=${s.match.phase}`);
  check('ball reset to alive', s.ball.dead === false);
}

// --- 4. Hitting into the net loses the point ---
{
  const s = createInitialSnapshot();
  // Aim extremely short so the ball drops into the net.
  step(s, [inp({ shoot: true, aimX: 0, aimZ: 1.2 }), inp()]);
  // Force a low flat shot straight at the net to guarantee the net case.
  s.ball.position = { x: 0, y: 0.4, z: -1.0 };
  s.ball.velocity = { x: 0, y: 0.2, z: 12 };
  s.ball.lastHitBy = 0;
  let netEvent = false;
  for (let i = 0; i < 300 && s.match.phase === 'rally'; i++) {
    const ev = step(s, [inp(), inp()]);
    if (ev.some(e => e.type === 'net')) netEvent = true;
  }
  check('net collision detected', netEvent);
  check('net loses point for striker', s.match.lastPointWinner === 1, `winner=${s.match.lastPointWinner} reason=${s.match.reason}`);
}

// --- 5. Ball landing beyond the baseline is out ---
// Start the ball already past the net so this tests the baseline, not the net.
{
  const s = createInitialSnapshot();
  s.match.phase = 'rally';
  s.players[1].position.x = 60; // keep the opponent from returning it
  s.ball.position = { x: 0, y: 2.5, z: 3 };
  s.ball.velocity = { x: 0, y: 1, z: 30 }; // way too fast, must land long
  s.ball.lastHitBy = 0;
  s.ball.bouncesSinceHit = 0;
  for (let i = 0; i < 600 && s.match.phase === 'rally'; i++) {
    s.players[1].position.x = 60;
    step(s, [inp(), inp()]);
  }
  check('long ball is out', s.match.reason === 'out', `reason=${s.match.reason}`);
  check('out loses point for striker', s.match.lastPointWinner === 1, `winner=${s.match.lastPointWinner}`);
}

// --- 6. Ball landing wide is out ---
{
  const s = createInitialSnapshot();
  s.match.phase = 'rally';
  s.ball.position = { x: 0, y: 1.5, z: 2 };
  s.ball.velocity = { x: 22, y: 0.5, z: 5 };
  s.ball.lastHitBy = 0;
  for (let i = 0; i < 600 && s.match.phase === 'rally'; i++) step(s, [inp(), inp()]);
  check('wide ball is out', s.match.reason === 'out', `reason=${s.match.reason} x=${s.ball.position.x.toFixed(2)}`);
}

// --- 7. Fast ball cannot tunnel through the net ---
{
  const s = createInitialSnapshot();
  s.match.phase = 'rally';
  s.ball.position = { x: 0, y: 0.5, z: -0.6 };
  s.ball.velocity = { x: 0, y: 0, z: 90 }; // 1.5 units per tick, straddles the net
  s.ball.lastHitBy = 0;
  const ev = step(s, [inp(), inp()]);
  check('tunnelling prevented', ev.some(e => e.type === 'net'), `z=${s.ball.position.z.toFixed(2)}`);
}

// --- 8. Player movement clamps to own half (cannot cross net) ---
{
  const s = createInitialSnapshot();
  for (let i = 0; i < 300; i++) step(s, [inp({ moveZ: 1 }), inp({ moveZ: -1 })]);
  check('player 0 stays on -Z', s.players[0].position.z < 0, `z=${s.players[0].position.z.toFixed(2)}`);
  check('player 1 stays on +Z', s.players[1].position.z > 0, `z=${s.players[1].position.z.toFixed(2)}`);
}

// --- 9. Player clamps to sidelines ---
{
  const s = createInitialSnapshot();
  for (let i = 0; i < 400; i++) step(s, [inp({ moveX: 1 }), inp({ moveX: -1 })]);
  const limit = COURT.halfWidth + COURT.runoffX + 0.001;
  check('player 0 within +X limit', s.players[0].position.x <= limit, `x=${s.players[0].position.x.toFixed(2)} limit=${limit}`);
  check('player 1 within -X limit', s.players[1].position.x >= -limit, `x=${s.players[1].position.x.toFixed(2)}`);
}

// --- 10. Diagonal movement is not faster than axis movement ---
// Only 20 ticks, so neither run reaches the sideline clamp (which would make
// the comparison meaningless by capping the axis-only run).
{
  const a = createInitialSnapshot();
  const b = createInitialSnapshot();
  const start = { ...a.players[0].position };
  for (let i = 0; i < 20; i++) step(a, [inp({ moveX: 1 }), inp()]);
  for (let i = 0; i < 20; i++) step(b, [inp({ moveX: 1, moveZ: -1 }), inp()]);
  const distA = Math.hypot(a.players[0].position.x - start.x, a.players[0].position.z - start.z);
  const distB = Math.hypot(b.players[0].position.x - start.x, b.players[0].position.z - start.z);
  const clampedA = Math.abs(a.players[0].position.x) >= COURT.halfWidth + COURT.runoffX - 0.01;
  check('axis run did not hit the clamp (test is valid)', !clampedA, `x=${a.players[0].position.x.toFixed(2)}`);
  check('diagonal not faster', distB <= distA + 0.05, `axis=${distA.toFixed(2)} diag=${distB.toFixed(2)}`);
}

// --- 11/12. Tennis scoring: love-15-30-40, game, deuce, advantage, match ---
// Each point is played out through the real simulation: the loser strikes the
// ball long, so the point is decided by the same code as in a match.
{
  const names: [string, string] = ['Hayk', 'Max'];
  const winPoint = (s: GameSnapshot, side: 0 | 1): GameEvent[] => {
    const loser = side === 0 ? 1 : 0;
    s.match.phase = 'rally';
    s.ball.dead = false;
    s.ball.bouncesSinceHit = 0;
    s.ball.position = { x: 0, y: 1.5, z: 2 };
    s.ball.velocity = { x: 0, y: 1, z: 30 };
    s.ball.lastHitBy = loser;
    const events: GameEvent[] = [];
    for (let i = 0; i < 600 && s.match.phase === 'rally'; i++) events.push(...step(s, [inp(), inp()]));
    // Let the point-over pause run out, back to serving.
    for (let i = 0; i < 400 && s.match.phase === 'point-over'; i++) step(s, [inp(), inp()]);
    return events;
  };
  const labels = (s: GameSnapshot) => `${pointLabel(s.match.scores, 0)}-${pointLabel(s.match.scores, 1)}`;

  // A plain game: love, 15, 30, 40, game.
  const s = createInitialSnapshot();
  check('new match is love-all, 0 games', labels(s) === '0-0' && s.match.games[0] === 0 && s.match.games[1] === 0, labels(s));
  winPoint(s, 0);
  check('first point: 15-0', labels(s) === '15-0', labels(s));
  check('call: "Fifteen, love."', pointCall(s.match.scores, s.match.server, names) === 'Fifteen, love.', pointCall(s.match.scores, s.match.server, names));
  winPoint(s, 1);
  check('15 all', labels(s) === '15-15' && pointCall(s.match.scores, s.match.server, names) === 'Fifteen all.', labels(s));
  winPoint(s, 0);
  winPoint(s, 0);
  check('40-15', labels(s) === '40-15', labels(s));
  check('call: "Forty, fifteen."', pointCall(s.match.scores, s.match.server, names) === 'Forty, fifteen.');
  const gameEvents = winPoint(s, 0);
  const gameEvent = gameEvents.find((e) => e.type === 'game');
  check('fourth point wins the game', s.match.games[0] === 1 && s.match.games[1] === 0, `games=${s.match.games}`);
  check('a game event is emitted', gameEvent !== undefined && gameEvent.type === 'game' && gameEvent.winner === 0);
  check('points reset for the next game', labels(s) === '0-0', labels(s));
  check('serve passes to the other player after a game', s.match.server === 1, `server=${s.match.server}`);
  check('match continues after one game', s.match.phase === 'serving' && s.match.winner === null, `phase=${s.match.phase}`);
  check('call: "Game, Hayk. Hayk leads, one game to love."', gameCall(0, s.match.games, names) === 'Game, Hayk. Hayk leads, one game to love.', gameCall(0, s.match.games, names));

  // Server's score is called first: Max serves game 2, Hayk wins the point.
  winPoint(s, 0);
  check('server first: "Love, fifteen." when the receiver leads', pointCall(s.match.scores, s.match.server, names) === 'Love, fifteen.', pointCall(s.match.scores, s.match.server, names));

  // Deuce, and advantage back and forth as many times as it takes.
  const d = createInitialSnapshot();
  for (const side of [0, 1, 0, 1, 0, 1] as const) winPoint(d, side);
  check('40-40 is deuce', gameScore(d.match.scores).kind === 'deuce' && labels(d) === '40-40', labels(d));
  check('call: "Deuce!"', pointCall(d.match.scores, d.match.server, names) === 'Deuce!');
  winPoint(d, 0);
  check('advantage to the next point winner', gameScore(d.match.scores).kind === 'advantage' && labels(d) === 'AD-40', labels(d));
  check('call: "Advantage, Hayk!"', pointCall(d.match.scores, d.match.server, names) === 'Advantage, Hayk!');
  check('advantage is not yet a game', d.match.games[0] === 0, `games=${d.match.games}`);
  winPoint(d, 1);
  check('opponent wins it: back to deuce', gameScore(d.match.scores).kind === 'deuce', labels(d));
  let bounded = true;
  let alwaysDeuceOrAd = true;
  for (let round = 0; round < 25; round++) {
    winPoint(d, round % 2 === 0 ? 1 : 0);
    if (gameScore(d.match.scores).kind !== 'advantage') alwaysDeuceOrAd = false;
    winPoint(d, round % 2 === 0 ? 0 : 1);
    if (gameScore(d.match.scores).kind !== 'deuce') alwaysDeuceOrAd = false;
    if (Math.max(...d.match.scores) > 4) bounded = false;
  }
  check('25 more deuce/advantage swings, no game awarded', alwaysDeuceOrAd && d.match.games[0] === 0 && d.match.games[1] === 0, `games=${d.match.games} ${labels(d)}`);
  check('point counts stay small through long deuces', bounded, `scores=${d.match.scores}`);
  winPoint(d, 1);
  check('advantage Max after it all', labels(d) === '40-AD' && pointCall(d.match.scores, d.match.server, names) === 'Advantage, Max!', labels(d));
  winPoint(d, 1);
  check('winning from advantage wins the game', d.match.games[1] === 1 && labels(d) === '0-0', `games=${d.match.games}`);

  // Receiver breaks without deuce: 30-40 then the receiver wins it.
  const r = createInitialSnapshot();
  for (const side of [0, 1, 0, 1, 1] as const) winPoint(r, side);
  check('30-40', labels(r) === '30-40', labels(r));
  winPoint(r, 1);
  check('receiver wins the game from 30-40, no deuce needed', r.match.games[1] === 1 && r.match.games[0] === 0, `games=${r.match.games}`);

  // The match: first to MATCH.gamesToWin games, then frozen.
  const m = createInitialSnapshot();
  let matchEvents: GameEvent[] = [];
  for (let g = 0; g < MATCH.gamesToWin; g++) {
    for (let p = 0; p < 4; p++) matchEvents = winPoint(m, 0);
  }
  check(`match over at ${MATCH.gamesToWin} games`, m.match.phase === 'match-over' && m.match.winner === 0, `phase=${m.match.phase} games=${m.match.games}`);
  check('last point emits score, game and match-over', ['score', 'game', 'match-over'].every((t) => matchEvents.some((e) => e.type === t)), matchEvents.map((e) => e.type).join(','));
  check('call: "Game, set and match, Hayk!"', matchCall(0, names) === 'Game, set and match, Hayk!');
  const gamesAfter = [...m.match.games];
  for (let i = 0; i < 120; i++) step(m, [inp({ shoot: true }), inp({ shoot: true })]);
  check('score frozen after match', m.match.games[0] === gamesAfter[0] && m.match.games[1] === gamesAfter[1], `${m.match.games}`);
  check('games call when level: "Game, Max. One game all."', gameCall(1, [1, 1], names) === 'Game, Max. One game all.', gameCall(1, [1, 1], names));
}

// --- 13. Returning the ball works: opponent auto-swings and sends it back ---
{
  const s = createInitialSnapshot();
  step(s, [inp({ shoot: true, aimX: 0, aimZ: 7 }), inp()]);
  let returned = false;
  for (let i = 0; i < 900 && s.match.phase === 'rally'; i++) {
    // Player 1 chases the ball in x and z.
    const p = s.players[1];
    const b = s.ball;
    const mx = Math.max(-1, Math.min(1, (b.position.x - p.position.x) * 2));
    const mz = Math.max(-1, Math.min(1, (b.position.z - p.position.z) * 2));
    const ev = step(s, [inp(), inp({ moveX: mx, moveZ: mz, aimX: 0, aimZ: -7 })]);
    if (ev.some(e => e.type === 'hit' && e.side === 1)) { returned = true; break; }
  }
  check('opponent can return the serve', returned, `lastHitBy=${s.ball.lastHitBy}`);
  if (returned) check('return travels back (-z)', s.ball.velocity.z < 0, `vz=${s.ball.velocity.z.toFixed(2)}`);
}

// --- 14. A full rally can be sustained (both chase) ---
// The chaser predicts the landing spot rather than running at where the ball
// currently is. Running at the live position only ever worked because players
// used to be fast enough to cover any mistake; at a realistic movement speed a
// player has to anticipate, which is what a human (and the AI) actually does.
{
  const s = createInitialSnapshot();
  step(s, [inp({ shoot: true, aimX: 0, aimZ: 7 }), inp()]);
  let hits = 0;
  for (let i = 0; i < 3000 && s.match.phase === 'rally'; i++) {
    const b = s.ball;
    const g = 9.8, r = 0.14;
    const disc = b.velocity.y * b.velocity.y + 2 * g * Math.max(0, b.position.y - r);
    const t = disc > 0 ? (b.velocity.y + Math.sqrt(disc)) / g : 0;
    const landX = b.position.x + b.velocity.x * t;
    const landZ = b.position.z + b.velocity.z * t;
    const chase = (side: 0 | 1) => {
      const p = s.players[side];
      const mine = (side === 0 ? -1 : 1) * landZ > 0;
      const tx = mine ? landX : 0;
      const tz = mine ? landZ : (side === 0 ? -8 : 8);
      const mx = Math.max(-1, Math.min(1, (tx - p.position.x) * 2));
      const mz = Math.max(-1, Math.min(1, (tz - p.position.z) * 2));
      return inp({ moveX: mx, moveZ: mz, aimX: 0, aimZ: side === 0 ? 7 : -7 });
    };
    const ev = step(s, [chase(0), chase(1)]);
    hits += ev.filter(e => e.type === 'hit').length;
  }
  check('rally sustains multiple hits', hits >= 3, `hits=${hits}`);
}

// --- 15. resetMatch clears everything ---
{
  const s = createInitialSnapshot();
  s.match.scores = [2, 1];
  s.match.games = [2, 1];
  s.match.phase = 'match-over';
  s.match.winner = 1;
  resetMatch(s);
  check('resetMatch clears score', s.match.scores[0] === 0 && s.match.scores[1] === 0 && s.match.games[0] === 0 && s.match.games[1] === 0);
  check('resetMatch clears winner', s.match.winner === null);
  check('resetMatch back to serving', s.match.phase === 'serving');
}

// --- 16. Snapshot survives JSON round-trip (network contract) ---
{
  const s = createInitialSnapshot();
  step(s, [inp({ shoot: true, aimZ: 6 }), inp()]);
  const round = JSON.parse(JSON.stringify(s)) as GameSnapshot;
  const ev = step(round, [inp(), inp()]);
  check('snapshot JSON round-trips', typeof round.ball.position.y === 'number' && !Number.isNaN(round.ball.position.y), `y=${round.ball.position.y}`);
  check('stepping a round-tripped snapshot works', Array.isArray(ev));
}

// --- 17. No NaN anywhere after a long run ---
{
  const s = createInitialSnapshot();
  for (let i = 0; i < 5000; i++) {
    const b = s.ball;
    const chase = (side: 0 | 1) => {
      const p = s.players[side];
      return inp({
        moveX: Math.max(-1, Math.min(1, (b.position.x - p.position.x) * 2)),
        moveZ: Math.max(-1, Math.min(1, (b.position.z - p.position.z) * 2)),
        aimX: Math.sin(i / 50) * 3,
        aimZ: side === 0 ? 7 : -7,
        shoot: i % 37 === 0,
        charge: (i % 100) / 100,
      });
    };
    step(s, [chase(0), chase(1)]);
  }
  const nums = JSON.stringify(s).match(/-?\d+\.?\d*(e-?\d+)?/g) ?? [];
  const bad = JSON.stringify(s).includes('null,null') || /NaN|Infinity/.test(JSON.stringify(s));
  check('no NaN/Infinity after 5000 ticks', !bad);
  const played = s.match.scores[0] + s.match.scores[1] + s.match.games[0] + s.match.games[1];
  check('match progressed over long run', played > 0, `points=${s.match.scores} games=${s.match.games}`);
}

// --- 18. Shots land near where they are aimed (the aiming promise) ---
{
  const targets = [
    { x: 0, z: 6 }, { x: 3, z: 9 }, { x: -3, z: 4 },
    { x: 0, z: 10.5 }, { x: 3.5, z: 2.5 }, { x: -2, z: 11 },
  ];
  let worst = 0;
  let worstAt = '';
  let allCleared = true;
  for (const t of targets) {
    for (const charge of [0, 0.5, 1]) {
      const s = createInitialSnapshot();
      s.players[1].position.x = 60; // keep the opponent out of the way
      step(s, [inp({ shoot: true, aimX: t.x, aimZ: t.z, charge }), inp()]);
      let landed: { x: number; z: number } | null = null;
      let minNetClearance = Infinity;
      for (let i = 0; i < 600 && !landed; i++) {
        s.players[1].position.x = 60;
        const prevZ = s.ball.position.z;
        const ev = step(s, [inp(), inp()]);
        if (prevZ < 0 && s.ball.position.z >= 0) minNetClearance = Math.min(minNetClearance, s.ball.position.y);
        for (const e of ev) if (e.type === 'bounce' && !landed) landed = { x: e.position.x, z: e.position.z };
      }
      if (!landed) { allCleared = false; worstAt = `never landed @${t.x},${t.z} c=${charge}`; continue; }
      const err = Math.hypot(landed.x - t.x, landed.z - t.z);
      if (err > worst) { worst = err; worstAt = `aim(${t.x},${t.z}) c=${charge} -> (${landed.x.toFixed(2)},${landed.z.toFixed(2)}) err=${err.toFixed(2)}`; }
      if (minNetClearance < 1.07) allCleared = false;
    }
  }
  check('every aimed shot lands', worstAt.indexOf('never') === -1, worstAt);
  check('shots land within 1.2m of aim', worst < 1.2, `worst: ${worstAt}`);
  check('shots clear the net', allCleared);
}

// --- 19. A stationary player does not swat balls passing overhead ---
{
  const s = createInitialSnapshot();
  s.match.phase = 'rally';
  // Ball sails over player 1 at 2.8m, well above racket height, moving toward
  // them (so it is only the height that should prevent the hit).
  s.players[1].position = { x: 0, y: 0, z: 6 };
  s.ball.position = { x: 0, y: 2.8, z: 4.2 };
  s.ball.velocity = { x: 0, y: 0.5, z: 8 };
  s.ball.lastHitBy = 0;
  let swatted = false;
  for (let i = 0; i < 12; i++) {
    s.players[1].position = { x: 0, y: 0, z: 6 };
    const ev = step(s, [inp(), inp()]);
    if (ev.some(e => e.type === 'hit' && e.side === 1)) swatted = true;
  }
  check('no swatting balls overhead', !swatted);
}

// --- 20. A rally between two chasing players is sustained (regression) ---
// The chaser predicts where the ball will land rather than running at where it
// currently is, which is what a real player (and the AI opponent) does.
{
  const s = createInitialSnapshot();
  step(s, [inp({ shoot: true, aimX: 0, aimZ: 7 }), inp()]);
  let hits = 0, bounces = 0;
  for (let i = 0; i < 3000 && s.match.phase === 'rally'; i++) {
    const b = s.ball;
    // Predict the landing point with simple ballistics.
    const g = 9.8, r = 0.14;
    const disc = b.velocity.y * b.velocity.y + 2 * g * Math.max(0, b.position.y - r);
    const t = disc > 0 ? (b.velocity.y + Math.sqrt(disc)) / g : 0;
    const landX = b.position.x + b.velocity.x * t;
    const landZ = b.position.z + b.velocity.z * t;
    const chase = (side: 0 | 1) => {
      const p = s.players[side];
      // Only chase balls heading to your own side; otherwise recover to centre.
      const mine = (side === 0 ? -1 : 1) * landZ > 0;
      const tx = mine ? landX : 0;
      const tz = mine ? landZ : (side === 0 ? -8 : 8);
      return inp({
        moveX: Math.max(-1, Math.min(1, (tx - p.position.x) * 1.5)),
        moveZ: Math.max(-1, Math.min(1, (tz - p.position.z) * 1.5)),
        aimX: 0, aimZ: side === 0 ? 8 : -8,
      });
    };
    const ev = step(s, [chase(0), chase(1)]);
    hits += ev.filter(e => e.type === 'hit').length;
    bounces += ev.filter(e => e.type === 'bounce').length;
  }
  check('ball actually bounces in a rally', bounces >= 2, `bounces=${bounces} hits=${hits}`);
  check('rally is returnable', hits >= 2, `hits=${hits}`);
  // Two flawless predictive players legitimately rally forever, so this only
  // asserts the rally is alive and healthy, not that it has ended.
  check('long rally stays alive and lands shots', bounces >= 10 && hits >= 10, `bounces=${bounces} hits=${hits}`);
}

// --- 21. Imperfect players do lose points, so matches finish ---
// Side 1 chases a deliberately wrong spot, so it is genuinely out of position
// and misses balls. (Handicapping movement *speed* does not work: there is
// over a second between shots, so even a slow player always arrives in time.)
{
  const s = createInitialSnapshot();
  let guard = 0;
  while (s.match.phase !== 'match-over' && guard < 200000) {
    guard++;
    const b = s.ball;
    const g = 9.8, r = 0.14;
    const disc = b.velocity.y * b.velocity.y + 2 * g * Math.max(0, b.position.y - r);
    const t = disc > 0 ? (b.velocity.y + Math.sqrt(disc)) / g : 0;
    const landX = b.position.x + b.velocity.x * t;
    const landZ = b.position.z + b.velocity.z * t;
    const chase = (side: 0 | 1, skill: number) => {
      const p = s.players[side];
      const mine = (side === 0 ? -1 : 1) * landZ > 0;
      const tx = mine ? landX : 0;
      const tz = mine ? landZ : (side === 0 ? -8 : 8);
      // Scale the final input so the handicap survives the -1..1 clamp; a
      // sluggish player genuinely moves slower rather than just aiming badly.
      // Aim away from where the opponent is standing, as a real player would.
      const opponent = s.players[side === 0 ? 1 : 0];
      const aimX = opponent.position.x > 0 ? -3.2 : 3.2;
      // `skill` < 1 offsets the chase target sideways, so this player stands in
      // the wrong place and genuinely fails to reach some balls.
      const misjudge = (1 - skill) * 5.5;
      return inp({
        moveX: Math.max(-1, Math.min(1, (tx + misjudge - p.position.x) * 1.5)),
        moveZ: Math.max(-1, Math.min(1, (tz - p.position.z) * 1.5)),
        aimX, aimZ: side === 0 ? 9 : -9,
        shoot: s.match.phase === 'serving',
      });
    };
    // Side 1 is deliberately sluggish, so it misses some balls.
    step(s, [chase(0, 1), chase(1, 0.3)]);
  }
  check('a match between unequal players completes', s.match.phase === 'match-over', `phase=${s.match.phase} score=${s.match.scores} ticks=${guard}`);
  check('the better player wins', s.match.winner === 0, `winner=${s.match.winner} score=${s.match.scores}`);
}

// --- 22. Pausing freezes the world exactly (disconnect / rejoin) ---
{
  const s = createInitialSnapshot();
  step(s, [inp({ shoot: true, aimZ: 7 }), inp()]);
  for (let i = 0; i < 30; i++) step(s, [inp(), inp()]);

  s.paused = true;
  const frozen = JSON.stringify(s);
  for (let i = 0; i < 300; i++) {
    step(s, [inp({ moveX: 1, moveZ: 1, shoot: true }), inp({ moveX: -1, shoot: true })]);
  }
  check('pause freezes the entire world', JSON.stringify(s) === frozen, 'state drifted while paused');

  // Unpausing resumes the same point, at the same score, mid-rally.
  const scoreBefore = [...s.match.scores];
  const phaseBefore = s.match.phase;
  s.paused = false;
  step(s, [inp(), inp()]);
  check('unpause resumes the same point', s.match.phase === phaseBefore, `phase=${s.match.phase}`);
  check('unpause preserves the score', s.match.scores[0] === scoreBefore[0] && s.match.scores[1] === scoreBefore[1], `${s.match.scores}`);
}

// --- 23. Snapshots acknowledge the inputs they consumed (prediction needs this) ---
{
  const s = createInitialSnapshot();
  step(s, [inp({ seq: 7 }), inp({ seq: 42 })]);
  check('snapshot acks side 0 input seq', s.ackedSeq[0] === 7, `acked=${s.ackedSeq[0]}`);
  check('snapshot acks side 1 input seq', s.ackedSeq[1] === 42, `acked=${s.ackedSeq[1]}`);

  step(s, [inp({ seq: 8 }), inp({ seq: 43 })]);
  check('acks advance with each tick', s.ackedSeq[0] === 8 && s.ackedSeq[1] === 43, `${s.ackedSeq}`);

  // A paused host consumes nothing, so it must not advance the acks either.
  s.paused = true;
  step(s, [inp({ seq: 99 }), inp({ seq: 99 })]);
  check('paused host does not ack new input', s.ackedSeq[0] === 8 && s.ackedSeq[1] === 43, `${s.ackedSeq}`);
}

// --- 24. Replaying the same inputs gives the same result (prediction must be deterministic) ---
// Client-side prediction replays inputs locally and expects to land on exactly
// what the host computed. If stepping is not deterministic, the guest's view
// would constantly snap and jitter.
{
  const inputsFor = (i: number): [PlayerInput, PlayerInput] => ([
    inp({ seq: i, moveX: Math.sin(i / 9), moveZ: Math.cos(i / 7), aimX: Math.sin(i / 13) * 3, aimZ: 8, shoot: i % 31 === 0, charge: (i % 50) / 50 }),
    inp({ seq: i, moveX: Math.cos(i / 11), moveZ: Math.sin(i / 5), aimX: Math.cos(i / 17) * 3, aimZ: -8, shoot: i % 37 === 0, charge: (i % 40) / 40 }),
  ]);

  const a = createInitialSnapshot();
  const b = createInitialSnapshot();
  for (let i = 0; i < 1500; i++) step(a, inputsFor(i));
  for (let i = 0; i < 1500; i++) step(b, inputsFor(i));
  check('stepping is deterministic', JSON.stringify(a) === JSON.stringify(b), 'two identical runs diverged');

  // And replaying from a serialised copy must match too, which is exactly what
  // the guest does on reconciliation.
  const c = JSON.parse(JSON.stringify(createInitialSnapshot())) as GameSnapshot;
  for (let i = 0; i < 1500; i++) step(c, inputsFor(i));
  check('replay from a serialised snapshot matches', JSON.stringify(c) === JSON.stringify(a), 'replayed run diverged');
}

// --- 25. The server may not cross the baseline until the serve is struck ---
// A foot fault in real tennis. Side 0 serves first and defends -z, so moving
// toward the net is +z. The receiver is free to move, and the server is free
// again once the ball is in play.
{
  const s = createInitialSnapshot();
  check('server starts behind the baseline', s.players[0].position.z <= -COURT.halfLength, `z=${s.players[0].position.z.toFixed(2)}`);
  for (let i = 0; i < 120; i++) step(s, [inp({ moveZ: 1, moveX: 0.5 }), inp({ moveZ: -1 })]);
  check('server held at the baseline while serving', s.players[0].position.z <= -COURT.halfLength + 1e-9, `z=${s.players[0].position.z.toFixed(2)}`);
  check('server can still move sideways', s.players[0].position.x > 1, `x=${s.players[0].position.x.toFixed(2)}`);
  check('receiver is not held back', s.players[1].position.z < COURT.halfLength - 2, `z=${s.players[1].position.z.toFixed(2)}`);

  // The guest predicts the same rule, or its server would walk in and snap back.
  const g = createInitialSnapshot();
  for (let i = 0; i < 120; i++) predictPlayer(g, 0, inp({ moveZ: 1 }));
  check('prediction holds the server at the baseline', g.players[0].position.z <= -COURT.halfLength + 1e-9, `z=${g.players[0].position.z.toFixed(2)}`);

  step(s, [inp({ shoot: true, aimX: 0, aimZ: 6 }), inp()]);
  check('serve struck -> rally', s.match.phase === 'rally', `phase=${s.match.phase}`);
  for (let i = 0; i < 30; i++) step(s, [inp({ moveZ: 1 }), inp()]);
  check('server free to come in after the serve', s.players[0].position.z > -COURT.halfLength + 1, `z=${s.players[0].position.z.toFixed(2)}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
