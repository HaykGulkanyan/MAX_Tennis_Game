import { Engine } from '../src/game/engine';
import { EMPTY_INPUT } from '../src/game/types';
import type { GameSnapshot, PlayerInput } from '../src/game/types';

const inp = (o: Partial<PlayerInput> = {}): PlayerInput => ({ ...EMPTY_INPUT, ...o });
let fails = 0;
const ck = (l: string, ok: boolean, d = '') => { if(!ok){fails++;console.log('FAIL '+l+' '+d);} else console.log('ok   '+l+' '+d); };

// Host (authority) and guest, wired like the real app.
let sent: GameSnapshot[] = [];
const host = new Engine({
  role: 'authority', side: 0,
  localInput: () => inp({ shoot: true, aimX: 0, aimZ: 7 }),
  onSnapshot: (s) => sent.push(JSON.parse(JSON.stringify(s))),
});
const guest = new Engine({
  role: 'guest', side: 1,
  localInput: () => inp({ moveX: 1 }),
});

// Run ~4 seconds. Host ticks at 60Hz and emits at 20Hz; guest consumes them.
let applied = 0, ballMoved = 0;
let prevBall = JSON.stringify(guest.snapshot.ball.position);
for (let i = 0; i < 240; i++) {
  host.advance(1/60);
  guest.advance(1/60);
  while (sent.length) {
    const s = sent.shift()!;
    const before = guest.snapshot.tick;
    guest.applySnapshot(s);
    if (guest.snapshot.tick !== before || guest.snapshot.tick === s.tick) applied++;
  }
  const now = JSON.stringify(guest.snapshot.ball.position);
  if (now !== prevBall) ballMoved++;
  prevBall = now;
}
ck('guest accepted snapshots', applied > 50, `applied=${applied}`);
ck('guest ball actually moves', ballMoved > 40, `frames ball changed=${ballMoved} (20Hz snapshots => ~80 expected)`);
ck('guest tick tracks host', Math.abs(guest.snapshot.tick - host.snapshot.tick) < 10,
   `guest=${guest.snapshot.tick} host=${host.snapshot.tick}`);
const b = guest.snapshot.ball.position;
ck('guest ball on court', Math.abs(b.x) < 30 && Math.abs(b.z) < 40 && b.y > -1,
   `x=${b.x.toFixed(1)} y=${b.y.toFixed(1)} z=${b.z.toFixed(1)}`);
ck('guest sees the rally', host.snapshot.match.phase !== 'serving' || host.snapshot.tick > 0,
   `phase=${guest.snapshot.match.phase}`);
console.log(fails ? `\n${fails} FAILED` : '\nGUEST BALL OK');
