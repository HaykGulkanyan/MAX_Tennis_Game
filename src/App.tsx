/**
 * Application shell: owns the match lifecycle and the network wiring.
 *
 * Everything stateful and long-lived (the engine, the input controller, the
 * peer connection) lives in refs rather than React state, because none of it
 * should trigger a re-render. React here is only responsible for which screen
 * is showing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';

import { GameScene, initialCameraPosition, CAMERA_FOV } from './scene/GameScene';
import {
  Hud,
  LobbyScreen,
  MatchOverScreen,
  MenuScreen,
  ProfileScreen,
  UnsupportedScreen,
} from './ui/Screens';
import { Engine } from './game/engine';
import { createAi } from './game/ai';
import { createInputController } from './game/input';
import type { InputController } from './game/input';
import {
  initAudio,
  playBounce,
  playHit,
  playNet,
  playScore,
  playUiClick,
  playWin,
  playLose,
} from './audio/sfx';
import {
  inviteUrlFor,
  joinRoom,
  roomCodeFromUrl,
  startHost,
} from './net/peer';
import type { GuestHandle, HostHandle } from './net/peer';
import { useStore } from './state/store';
import type {
  GameEvent,
  GameSnapshot,
  PlayerSide,
  PlayerInput,
  PlayerProfile,
} from './game/types';
import { EMPTY_INPUT } from './game/types';

/** Point-ending callouts, shown briefly over the court. */
const CALLOUTS: Record<string, string> = {
  out: 'OUT!',
  net: 'NET!',
  'double-bounce': 'POINT!',
  winner: 'WINNER!',
};

export default function App() {
  const screen = useStore((s) => s.screen);
  const setScreen = useStore((s) => s.setScreen);
  const setMode = useStore((s) => s.setMode);
  const side = useStore((s) => s.side);
  const setSide = useStore((s) => s.setSide);
  const difficulty = useStore((s) => s.difficulty);
  const profile = useStore((s) => s.profile);
  const setProfiles = useStore((s) => s.setProfiles);
  const setConnection = useStore((s) => s.setConnection);
  const setRoomCode = useStore((s) => s.setRoomCode);
  const setLatency = useStore((s) => s.setLatency);
  const setCallout = useStore((s) => s.setCallout);
  const syncMatch = useStore((s) => s.syncMatch);
  const setUnsupported = useStore((s) => s.setUnsupported);
  const unsupported = useStore((s) => s.unsupported);
  const storeWinner = useStore((s) => s.winner);

  const engineRef = useRef<Engine | null>(null);
  const inputRef = useRef<InputController | null>(null);
  const hostRef = useRef<HostHandle | null>(null);
  const guestRef = useRef<GuestHandle | null>(null);
  /** True from the Join click until the connection settles. */
  const joiningRef = useRef(false);
  const calloutTimer = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  /** Held so a rematch can clear the AI's carried-over state. */
  const aiRef = useRef<ReturnType<typeof createAi> | null>(null);

  /** Set when the page was opened from an invite link. */
  const [joiningCode, setJoiningCode] = useState<string | null>(null);
  /** Bumped to force the Canvas to remount cleanly between matches. */
  const [sceneKey, setSceneKey] = useState(0);

  // Detect a device that cannot play: the controls need a real pointer and a
  // keyboard. Menus still render on a phone (the link gets shared around), but
  // we say plainly that playing needs a desktop.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    setUnsupported(coarse);
  }, [setUnsupported]);

  /*
   * C cycles the camera. Handled here rather than in the input controller
   * because it is a view preference, not gameplay input: it never reaches the
   * simulation and so must not travel to the host.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'KeyC' || event.repeat) return;
      // Ignore it while the player is typing their name.
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      useStore.getState().cycleCameraMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // An invite link lands here: capture the code and go straight to the name
  // prompt, so joining is one step.
  useEffect(() => {
    const code = roomCodeFromUrl();
    if (code) {
      setJoiningCode(code);
      setScreen('profile');
    }
  }, [setScreen]);

  const showCallout = useCallback(
    (text: string) => {
      setCallout(text);
      if (calloutTimer.current) window.clearTimeout(calloutTimer.current);
      calloutTimer.current = window.setTimeout(() => setCallout(null), 1400);
    },
    [setCallout],
  );

  /**
   * Turn simulation events into sound and on-screen callouts.
   *
   * Reads the side from the store rather than closing over it, because the
   * engine keeps whichever callback instance it was built with: a guest is
   * told its side only after the engine exists, so a captured `side` would be
   * stale and the win and lose sounds would be swapped.
   */
  const handleEvents = useCallback(
    (events: GameEvent[]) => {
      const mySide = useStore.getState().side;
      for (const event of events) {
        switch (event.type) {
          case 'hit':
            playHit(event.power);
            break;
          case 'bounce':
            playBounce();
            break;
          case 'net':
            playNet();
            showCallout(CALLOUTS.net);
            break;
          case 'out':
            showCallout(CALLOUTS.out);
            break;
          case 'score':
            playScore();
            break;
          case 'match-over':
            if (event.winner === mySide) playWin();
            else playLose();
            break;
        }
      }
    },
    [showCallout],
  );

  const teardown = useCallback(() => {
    inputRef.current?.detach();
    inputRef.current = null;
    engineRef.current = null;
    hostRef.current?.close();
    hostRef.current = null;
    guestRef.current?.close();
    guestRef.current = null;
    joiningRef.current = false;
    if (pingTimerRef.current !== null) {
      window.clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    if (calloutTimer.current !== null) {
      window.clearTimeout(calloutTimer.current);
      calloutTimer.current = null;
    }
  }, []);

  useEffect(() => teardown, [teardown]);

  /** Build the engine and input controller shared by every mode. */
  const buildEngine = useCallback(
    (
      role: 'authority' | 'guest' | 'spectator',
      mySide: PlayerSide,
      opponentInput?: (snapshot: GameSnapshot, side: PlayerSide) => PlayerInput,
      onSnapshot?: (snapshot: GameSnapshot) => void,
      onLocalInput?: (input: PlayerInput) => void,
    ) => {
      // Replace any controller from a previous match, so an old one cannot
      // keep consuming clicks in the background.
      inputRef.current?.detach();
      const input = createInputController();
      input.attach(window);
      inputRef.current = input;

      const engine = new Engine({
        role,
        side: mySide,
        localInput: (snapshot, s) => input.sample(snapshot, s),
        remoteInput: opponentInput,
        onEvents: (events) => {
          handleEvents(events);
          // The guest has no simulation of its own, so the host has to forward
          // the events or the joiner's match is completely silent.
          hostRef.current?.broadcast({ kind: 'events', events });
        },
        onSnapshot,
        onLocalInput,
      });
      engineRef.current = engine;
      setSceneKey((k) => k + 1);
      return engine;
    },
    [handleEvents],
  );

  const startAiMatch = useCallback(() => {
    initAudio();
    playUiClick();
    const ai = createAi(difficulty, 1);
    aiRef.current = ai;
    setSide(0);
    setProfiles([
      { name: profile.name || 'You', color: profile.color },
      { name: 'Computer', color: '#e8503a' },
    ]);
    buildEngine('authority', 0, (snapshot, s) => ai(snapshot, s));
    setMode('ai');
    setScreen('playing');
  }, [buildEngine, difficulty, profile, setMode, setProfiles, setScreen, setSide]);

  const startPractice = useCallback(() => {
    initAudio();
    playUiClick();
    setSide(0);
    setProfiles([
      { name: profile.name || 'You', color: profile.color },
      { name: 'Wall', color: '#6b7280' },
    ]);
    // Practice has no opponent: the far side never moves or swings, so the
    // player can rally against their own returns and learn the controls.
    //
    // It must still "serve" though. The serve rotates to whoever lost the last
    // point, so once the wall takes a point the serve passes to a side that
    // never clicks, and without this the match would sit in `serving` forever.
    buildEngine('authority', 0, () => ({ ...EMPTY_INPUT, shoot: true }));
    setMode('practice');
    setScreen('playing');
  }, [buildEngine, profile, setMode, setProfiles, setScreen, setSide]);

  const startHosting = useCallback(async () => {
    // A second click would open a second broker peer, orphaning the first and
    // showing a room code nobody is listening on.
    if (hostRef.current) return;
    initAudio();
    playUiClick();
    setMode('host');
    setSide(0);
    setConnection('hosting');
    setScreen('lobby');

    try {
      const host = await startHost({
        onStatus: setConnection,
        onPeerJoined: (role, peerProfile) => {
          if (role !== 'player') return;
          const pair: [PlayerProfile, PlayerProfile] = [
            { name: profile.name || 'Host', color: profile.color },
            peerProfile,
          ];
          setProfiles(pair);
          // Send them on, or the guest shows two blank default players.
          hostRef.current?.broadcast({ kind: 'profiles', profiles: pair });

          // Joining a match already under way (a rejoin after a drop or a
          // refresh). The guest waits on the name screen for 'start', which
          // only goes out when the match begins, so without this they would
          // sit there forever.
          const engine = engineRef.current;
          if (engine) {
            engine.resetRemoteInput();
            hostRef.current?.broadcast({ kind: 'start' });
          }
        },
        onPeerLeft: (role) => {
          if (role !== 'player') return;
          // Freeze rather than end: the same link lets them resume the point.
          engineRef.current?.setPaused(true);
          setConnection('waiting-for-rejoin');
        },
        onClientMessage: (message) => {
          const engine = engineRef.current;
          if (!engine) return;
          if (message.kind === 'input') {
            engine.setRemoteInput(message.input);
            // Any input proves the guest is back, so lift a rejoin pause.
            engine.setPaused(false);
          } else if (message.kind === 'latency') {
            // The guest measured it; the host is the one that has to act on it.
            engine.setLatency(message.rttMs);
            setLatency(message.rttMs);
          } else if (message.kind === 'rematch') {
            engine.restart();
            // Put the guest back on the court too; it is driven by our
            // snapshots and would otherwise sit on its end screen.
            hostRef.current?.broadcast({ kind: 'start' });
          }
        },
        onError: (error) => {
          setConnection('error');
          showCallout(error);
        },
      });
      hostRef.current = host;
      setRoomCode(host.roomCode);
    } catch {
      setConnection('error');
    }
  }, [
    profile,
    setConnection,
    setMode,
    setProfiles,
    setRoomCode,
    setScreen,
    setSide,
    showCallout,
  ]);

  /** Host: begin the match and start broadcasting. */
  const beginHostedMatch = useCallback(() => {
    playUiClick();
    buildEngine('authority', 0, undefined, (snapshot) => {
      hostRef.current?.broadcast({ kind: 'snapshot', snapshot });
    });
    // The host does not ping: `peer.ts` answers the guest's pings inline, and
    // the guest reports the measured round trip back in its input stream. The
    // fairness delay is applied in the ping handler as those arrive, rather
    // than once here, where the latency would still be a stale zero.
    hostRef.current?.broadcast({ kind: 'start' });
    setScreen('playing');
  }, [buildEngine, setScreen]);

  const joinAsGuest = useCallback(async () => {
    if (!joiningCode) return;
    // A second connection would be seated as a spectator, whose engine never
    // ticks, so the player would appear frozen with no explanation. The guard
    // has to be set before the await: `guestRef` is only filled once the
    // connection opens, and a second click on "Join match" while it was still
    // connecting used to slip through and seat the joiner as a spectator.
    if (guestRef.current || joiningRef.current) return;
    joiningRef.current = true;
    initAudio();
    playUiClick();
    setMode('guest');
    setConnection('connecting');

    try {
      const guest = await joinRoom(joiningCode, 'player', profile, {
        onStatus: setConnection,
        onHostMessage: (message) => {
          switch (message.kind) {
            case 'welcome': {
              setSide(message.side);
              const spectating = message.role === 'spectator';
              buildEngine(
                spectating ? 'spectator' : 'guest',
                message.side,
                undefined,
                undefined,
                // Forward exactly the input the engine predicted with. A
                // spectator sends nothing, so its inputs can never nudge the
                // match even if the host failed to filter them.
                spectating
                  ? undefined
                  : (input) => guestRef.current?.send({ kind: 'input', input }),
              );
              break;
            }
            case 'snapshot':
              engineRef.current?.applySnapshot(message.snapshot);
              break;
            case 'events':
              handleEvents(message.events);
              break;
            case 'profiles':
              setProfiles(message.profiles);
              break;
            case 'start':
              // Also sent on a rematch, so clear the stale winner or the
              // match-over effect fires again immediately.
              syncMatch({
                scores: [0, 0],
                phase: 'serving',
                server: 0,
                winner: null,
              });
              setScreen('playing');
              break;
            case 'pong': {
              const rtt = Math.round(performance.now() - message.sent);
              setLatency(rtt);
              // Report it back: only the host can apply the fairness delay.
              guestRef.current?.send({ kind: 'latency', rttMs: rtt });
              break;
            }
          }
        },
        onError: (error) => {
          setConnection('error');
          showCallout(error);
        },
      });
      guestRef.current = guest;

      // Input reaches the host through the engine's onLocalInput hook, set up
      // in the 'welcome' handler above. Do not add a sampling loop here: see
      // the note on `onLocalInput` in engine.ts.

      // Measure the round trip so the HUD can show it and the host can even
      // out its own reaction-time advantage.
      const pingTimer = window.setInterval(() => {
        guest.send({ kind: 'ping', sent: performance.now() });
      }, 2000);
      pingTimerRef.current = pingTimer;
    } catch {
      setConnection('error');
      // Let them press Join again; nothing is connected to be duplicated.
      joiningRef.current = false;
    }
  }, [
    buildEngine,
    handleEvents,
    joiningCode,
    profile,
    setConnection,
    setLatency,
    setMode,
    setProfiles,
    setScreen,
    setSide,
    showCallout,
  ]);

  const confirmProfile = useCallback(() => {
    if (joiningCode) void joinAsGuest();
    else setScreen('menu');
  }, [joinAsGuest, joiningCode, setScreen]);

  const exitToMenu = useCallback(() => {
    playUiClick();
    teardown();
    useStore.getState().reset();
  }, [teardown]);

  const rematch = useCallback(() => {
    playUiClick();
    engineRef.current?.restart();
    // The AI keeps closure state (reaction timers, its PRNG) that would
    // otherwise carry into the new match and make its first point erratic.
    aiRef.current?.reset();
    guestRef.current?.send({ kind: 'rematch' });
    // Clear the mirrored winner immediately. The snapshot mirror only runs a
    // few times a second, so without this the "match is over" effect fires
    // again before the fresh state arrives and bounces straight back here.
    syncMatch({
      scores: [0, 0],
      phase: 'serving',
      server: 0,
      winner: null,
    });
    setScreen('playing');
  }, [setScreen, syncMatch]);

  // Move to the end screen when the match is decided.
  useEffect(() => {
    if (storeWinner !== null && screen === 'playing') setScreen('match-over');
  }, [screen, setScreen, storeWinner]);

  if (unsupported && screen !== 'menu') return <UnsupportedScreen />;

  const showCanvas =
    (screen === 'playing' || screen === 'match-over') && engineRef.current;

  return (
    <div className="app">
      {showCanvas && engineRef.current && inputRef.current && (
        <Canvas
          key={sceneKey}
          shadows
          /*
           * r3f defaults to ACES filmic tone mapping, which is built for
           * photographic HDR content and noticeably crushes flat saturated
           * colours toward black; it was the main reason the court rendered
           * murky. These are stylized solid colours, so neutral tone mapping
           * reproduces them as authored.
           */
          gl={{ toneMapping: THREE.NoToneMapping, antialias: true }}
          camera={{ fov: CAMERA_FOV, position: initialCameraPosition(side), near: 0.1, far: 200 }}
        >
          <GameScene
            engine={engineRef.current}
            input={inputRef.current}
            side={side}
          />
        </Canvas>
      )}

      {screen === 'playing' && <Hud />}
      {screen === 'menu' && (
        <MenuScreen
          onPlayAi={startAiMatch}
          onHost={() => void startHosting()}
          onPractice={startPractice}
        />
      )}
      {screen === 'profile' && (
        <ProfileScreen
          joiningCode={joiningCode}
          onConfirm={confirmProfile}
          onBack={() => setScreen('menu')}
        />
      )}
      {screen === 'lobby' && (
        <LobbyScreen onStart={beginHostedMatch} onCancel={exitToMenu} />
      )}
      {screen === 'match-over' && (
        <MatchOverScreen onRematch={rematch} onExit={exitToMenu} />
      )}
    </div>
  );
}

export { inviteUrlFor };
