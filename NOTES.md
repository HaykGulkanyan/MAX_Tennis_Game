# MAX Tennis Game — build notes

3D two-player tennis, React + Vite, deployed to GitHub Pages, friends join by link.

## Agreed spec

| Decision | Choice |
| --- | --- |
| Networking | PeerJS (P2P over WebRTC), no backend. Host is authoritative. |
| Gameplay | Arcade tennis |
| Camera | Behind-player 3rd person (each player sees their own side) |
| Visuals | Clean stylized — geometric primitives, no external model files |
| Scoring | First to 11, win by 2 |
| Controls | WASD move, mouse aims a court marker, **LMB** = shot, **hold RMB** = charge power. Auto-swing covers you if you do not click. |
| Extras | AI opponent, sound effects, player name + shirt colour |
| Join flow | Invite link auto-joins after a name/colour prompt |
| Netcode | Client-side prediction + reconciliation, ball interpolated |
| Fairness | Host delays its own input by ~RTT so both sides feel the same |
| Disconnects | Pause and wait; same link rejoins and resumes at the score |
| AI | Selectable Easy / Medium / Hard |
| Serving | Simple: aim, click, hold RMB for power. No faults, no service boxes |
| Rally depth | **Lean on purpose** — no sprint, stamina or shot types |
| Also building | Rematch without re-inviting, practice mode vs a wall, spectators |
| Priority | Feel over looks |
| Audience | Friends, link shared around. Desktop-first; must not break on mobile |
| Repo | Public, GitHub Pages |

## Status

**Done — the rules engine, and it is verified.**

- `src/game/constants.ts` — court geometry and all tuning values
- `src/game/types.ts` — shared types; the host/guest network contract
- `src/game/simulation.ts` — the authoritative simulation (no React, no THREE)
- `test/simulation.check.ts` — 56 headless checks, all passing

The types already carry what the later decisions need, so the network layer can
be built without reopening the simulation:

- `PlayerInput.seq` + `GameSnapshot.ackedSeq` — client-side prediction. The
  guest keeps unacknowledged inputs and replays them over each snapshot.
- `GameSnapshot.paused` — disconnect/rejoin. A paused step is a complete no-op,
  so the match resumes mid-point at the same score.
- `PeerRole`, `HostMessage.welcome` — spectators (snapshots out, inputs ignored).
- `ping`/`pong` — the latency estimate that drives the host's input delay.

**Stepping is verified deterministic** (check 24), which is the property
prediction rests on: replaying the same inputs, including from a serialised
snapshot, lands on exactly the same state. Anything non-deterministic added to
`step` (`Math.random`, `Date.now`, iteration over a `Set`) would break the
guest's view in ways that look like network jitter.

Run the checks with:

```
npm run check:sim
```

### Built in the parallel pass

All compile clean under `strict`, and the production build succeeds.

- `src/audio/sfx.ts` — synthesized WebAudio SFX, no asset files
- `src/game/ai.ts` — Easy/Medium/Hard opponent
- `src/game/input.ts` — keyboard + mouse, per-side mirroring, charge latch
- `src/net/peer.ts` — PeerJS host/guest, room codes, spectators, rejoin
- `src/scene/Court.tsx` — court, net, stadium, lighting
- `src/scene/Actors.tsx` — players, ball, aim marker, blob shadow
- `src/scene/GameScene.tsx` — the frame loop (mutation, never re-render)
- `src/ui/Screens.tsx` + `ui.css` — menu, profile, lobby, HUD, match over
- `src/state/store.ts`, `src/game/engine.ts`, `src/App.tsx` — the wiring
- `.github/workflows/deploy.yml`, `vite.config.ts` — Pages deploy

**`strict` was off in `tsconfig.app.json` and is now on.** Turning it on
immediately surfaced a real type error in the AI. Leave it on.

Two contract mismatches were caught and fixed at integration, both of the kind
that compile fine and fail silently at runtime:

1. The lobby built invite links as `?room=CODE` while the join path parsed
   `?r=CODE`, so **every invite link would have failed to join**. The UI now
   calls `inviteUrlFor` from `net/peer.ts` instead of formatting its own URL.
   Keep that single source of truth.
2. The HUD could not say whose serve it was, because the store did not mirror
   `match.server`. Added to `syncMatch`.

### Bugs found by audit and fixed

Two review passes over the parallel-written code found problems that types and
headless tests could not, because they live in seams no single module owns.

Showstoppers:

- **A/D was inverted for both players.** The camera looking down +Z mirrors X on
  screen, so world +X renders screen-LEFT for side 0 and screen-RIGHT for side 1.
  The code assumed the opposite and flipped both axes together. Verified by
  building the real camera and projecting a point, not by reasoning.
- **Aim drifted with movement.** The camera tracked the player's depth 1:1, and
  since aiming raycasts the cursor onto the court, running forward dragged the
  aim downcourt at running speed. The camera no longer follows Z.
- **A 0.4m band of unreturnable drop shots.** `clampAim` allowed targeting
  z=1.2 while the closest playable ball is `netKeepout - netReach` = 1.6. The
  aim limit is now derived from those constants instead of hardcoded.
- **Guest clicks were eaten.** `sample()` consumes the click latch, and it was
  called both by the engine and by the network send loop, so roughly half of a
  guest's clicks never reached the simulation. The engine now hands the network
  layer the exact input it predicted with (`onLocalInput`).
- **Practice mode deadlocked.** The serve rotates to whoever lost the point, and
  the wall never clicked, so the match froze in `serving` forever.
- **The guest's match was silent and nameless** — the host never broadcast
  `events` or `profiles`.

Also fixed: rematch bouncing straight back to the end screen, leaked ping and
send intervals, double-connect seating you as a frozen spectator, the fairness
delay being dead code (and the ping/pong direction being backwards), a stale
`side` swapping the win and lose sounds, the swing animation playing backwards,
the blob shadow being nearly constant, and the camera lurching on load.

**`PLAYER.moveSpeed` dropped 9.4 -> 7.0.** At 9.4 a defender covered the widest
possible shot in 0.65s while the fastest shot took 1.16s, so placement could
never win a point and rallies only ended on unforced errors. This is the number
most likely to need another pass after playing.

### Still to build

Everything above compiles and the app builds, but **none of it has been played
yet**. That is the honest state: verified by types and by the headless
simulation checks, not by a human hitting a ball. What remains:

1. **Play it.** `npm run dev`. Expect to find real problems here: camera feel,
   whether the aim marker reads clearly, whether auto-swing fires when you
   expect, whether the AI is beatable. This is the step that matters.
2. **Test two browsers locally** (host in one window, open the invite link in
   another) to exercise the P2P path, prediction and the rejoin flow.
3. Practice mode is currently "opponent never moves", which lets you rally
   against your own returns. If that feels pointless, give it a real wall.
4. The JS bundle is ~1.2MB (324KB gzipped), mostly three.js. Fine for a game,
   but code-splitting the menu from the scene would speed first load.
5. Push to GitHub and enable Pages (Settings > Pages > source "GitHub Actions").

## Physics notes worth keeping

These were all found by the checks, and each one is load-bearing. Changing any
of them will probably break rallies, so re-run `npm run check:sim` after tuning.

- **Shots are solved, not guessed.** `launchBall` computes the arc that lands on
  the aim point, so where you point is where the ball lands (within ~25cm).
  Shot *speed* therefore controls how hard and flat a shot is, not how far it
  travels.
- **Drag is compensated in closed form.** Horizontal speed decays as
  `v0·exp(-k·t)`, so the launch speed is scaled by the inverse of that integral.
  Without this, deep shots land ~2m short.
- **Net clearance is solved iteratively.** Lifting the ball to clear the net
  makes it land later, which moves the net crossing later, which changes the
  height there — the two constraints have to converge together.
- **`PLAYER.netKeepout` (2.6) must stay larger than `PLAYER.reach` (2.1).**
  Otherwise both players can reach over the net, they volley the same ball at
  head height forever, it never lands, and the point can never end. `netReach`
  (1.0) additionally limits how far *forward* a player can reach.
- **Auto-swing only fires after the ball has bounced** and below
  `autoSwingHeight`. Volleying out of the air must be a deliberate click. This
  is what stops two well-positioned players from rallying in mid-air forever.
- **The net is detected by the crossing, not the position**, so a fast ball
  cannot tunnel through it between two ticks.

### A caution about testing this

Handicapping a test opponent by movement *speed* does not work: there is over a
second between shots, so even a slow player always arrives in time. To make a
test player miss, offset the spot they run to (see check 21).
