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
  playCrowdCheer,
  startCrowdMurmur,
  stopCrowdMurmur,
} from './audio/sfx';
import { announceGame, announceMatch, announcePoint, hushUmpire, setUmpireVoice } from './audio/umpire';
import { cheer, resetCrowd } from './scene/crowdMood';
import { COMPUTER_AVATAR, WALL_AVATAR, sanitizeProfile } from './game/avatar';
import { isVenue, settleVote } from './game/venues';
import type { Venue } from './game/venues';
import { VoteScreen } from './ui/VoteScreen';
import {
  inviteUrlFor,
  joinRoom,
  roomCodeFromUrl,
  startHost,
} from './net/peer';
import type { GuestHandle, HostHandle } from './net/peer';
import { connectDirectory } from './net/directory';
import type { DirectoryHandle } from './net/directory';
import { useStore } from './state/store';
import type { UiScreen } from './state/store';
import { CustomizeScreen } from './ui/CustomizeScreen';
import type {
  GameEvent,
  GameSnapshot,
  PlayerSide,
  PlayerInput,
  PlayerProfile,
} from './game/types';
import { EMPTY_INPUT } from './game/types';

/** The name the umpire uses for a side; falls back when a name was left blank. */
function calledName(profile: PlayerProfile, side: PlayerSide): string {
  return profile.name.trim() || (side === 0 ? 'Player One' : 'Player Two');
}

/** How long an online venue vote stays open. */
const VOTE_SECONDS = 15;
/** How long the winning venue is shown before the match starts. */
const RESULT_PAUSE_MS = 2200;
/** The same pause for a solo pick: long enough to see it, short enough not to drag. */
const SOLO_PAUSE_MS = 900;

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
  /** The vote's closing timer, or the pause before the match after it. */
  const voteTimerRef = useRef<number | null>(null);
  /** Held so a rematch can clear the AI's carried-over state. */
  const aiRef = useRef<ReturnType<typeof createAi> | null>(null);

  /** Stable reader for the HUD's power meter; follows the current controller. */
  const readCharge = useCallback(() => inputRef.current?.getCharge() ?? 0, []);

  /** Where Customize returns to: the menu, or the name screen when joining. */
  const customizeReturn = useRef<UiScreen>('menu');
  const openCustomize = useCallback(() => {
    playUiClick();
    customizeReturn.current = useStore.getState().screen;
    setScreen('customize');
  }, [setScreen]);

  /*
   * The public room list. Connected for the whole visit, not just on the
   * menu: this browser may be the one holding the list for everyone else,
   * and must keep doing so while its player is in a match.
   */
  const directoryRef = useRef<DirectoryHandle | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handle = connectDirectory({
      onRooms: (rooms, online) => useStore.getState().setDirectory(rooms, online),
      onStatus: (status) => useStore.getState().setDirectoryStatus(status),
    });
    directoryRef.current = handle;
    // Leave promptly on close, so our room (and the list, if we hold it)
    // moves on at once instead of waiting for a timeout.
    const leave = () => handle.close();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      handle.close();
      directoryRef.current = null;
    };
  }, []);

  /*
   * List our room while we are in the lobby waiting for an opponent. It comes
   * down as soon as someone joins, the match starts, or we cancel, so the list
   * only ever shows rooms that can actually be joined.
   */
  const listedCode = useStore((s) => s.roomCode);
  const hostStatus = useStore((s) => s.connection);
  const gameMode = useStore((s) => s.mode);
  const roomPublic = useStore((s) => s.roomPublic);
  useEffect(() => {
    const waiting = hostStatus === 'hosting' || hostStatus === 'waiting-for-rejoin';
    const open =
      gameMode === 'host' && screen === 'lobby' && listedCode !== null && roomPublic && waiting;
    directoryRef.current?.publish(
      open && listedCode
        ? { code: listedCode, name: profile.name.trim() || 'Host', color: profile.color }
        : null,
    );
  }, [gameMode, screen, listedCode, roomPublic, hostStatus, profile.name, profile.color]);

  const setJoinError = useStore((s) => s.setJoinError);

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
      if ((event.code !== 'KeyC' && event.code !== 'KeyV') || event.repeat) return;
      // Ignore it while the player is typing their name.
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const store = useStore.getState();
      if (event.code === 'KeyV') store.setUmpireVoice(!store.umpireVoice);
      else store.cycleCameraMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const umpireVoice = useStore((s) => s.umpireVoice);
  useEffect(() => setUmpireVoice(umpireVoice), [umpireVoice]);

  // The crowd murmurs through a match and its end screen, and falls quiet in
  // the menus.
  useEffect(() => {
    if (screen === 'playing' || screen === 'match-over') startCrowdMurmur();
    else stopCrowdMurmur();
  }, [screen]);

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
  /**
   * Why the current point is ending, so the umpire can open with "Out!" or
   * "Net!". Set by those events and cleared by the next hit, because the call
   * only belongs to the point it ended.
   */
  const pointReason = useRef<'out' | 'net' | null>(null);

  const handleEvents = useCallback(
    (events: GameEvent[]) => {
      const { side: mySide, profiles } = useStore.getState();
      const names: [string, string] = [
        calledName(profiles[0], 0),
        calledName(profiles[1], 1),
      ];
      // A point that wins a game arrives with a 'game' event, and the last one
      // with 'match-over' too. The umpire makes one call per point: the match,
      // else the game, else the score in the game.
      const matchEnds = events.some((e) => e.type === 'match-over');
      const gameEnds = events.some((e) => e.type === 'game');
      const setScore = useStore.getState().setScore;
      for (const event of events) {
        switch (event.type) {
          case 'hit':
            playHit(event.power);
            // Our own hit spends the charge, so holding right click all match
            // cannot power every shot. On a guest this arrives one network
            // delay after the hit, well before the next ball comes back.
            if (event.side === mySide) inputRef.current?.spendCharge();
            pointReason.current = null;
            break;
          case 'bounce':
            playBounce();
            break;
          case 'net':
            playNet();
            showCallout(CALLOUTS.net);
            pointReason.current = 'net';
            break;
          case 'out':
            showCallout(CALLOUTS.out);
            pointReason.current = 'out';
            break;
          case 'score':
            playScore();
            if (!gameEnds) {
              setScore(event.scores);
              cheer(1);
              playCrowdCheer(1);
              announcePoint(event.scores, event.server, names, pointReason.current);
              pointReason.current = null;
            }
            break;
          case 'game':
            // The board shows the new games score and a fresh game at once.
            setScore([0, 0], event.games);
            if (!matchEnds) {
              cheer(1.2);
              playCrowdCheer(1.2);
              announceGame(event.winner, event.games, names, pointReason.current);
            }
            pointReason.current = null;
            break;
          case 'match-over':
            if (event.winner === mySide) playWin();
            else playLose();
            cheer(1.5);
            playCrowdCheer(1.5);
            announceMatch(event.winner, names);
            pointReason.current = null;
            break;
        }
      }
    },
    [showCallout],
  );

  const teardown = useCallback(() => {
    if (voteTimerRef.current !== null) {
      window.clearTimeout(voteTimerRef.current);
      voteTimerRef.current = null;
    }
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
      { ...profile, name: profile.name || 'You' },
      { name: 'Computer', color: '#e8503a', avatar: COMPUTER_AVATAR },
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
      { ...profile, name: profile.name || 'You' },
      { name: 'Wall', color: '#6b7280', avatar: WALL_AVATAR },
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

  // --- Venue vote --------------------------------------------------------

  const clearVoteTimer = useCallback(() => {
    if (voteTimerRef.current !== null) {
      window.clearTimeout(voteTimerRef.current);
      voteTimerRef.current = null;
    }
  }, []);

  /**
   * Host: start the match at the settled venue. A rematch restarts the same
   * engine rather than building a new one: the guest only accepts snapshots
   * whose tick moves forward, and a fresh engine would start again from zero.
   */
  const launchHostedMatch = useCallback(() => {
    if (engineRef.current && useStore.getState().mode === 'host') {
      engineRef.current.restart();
    } else {
      buildEngine('authority', 0, undefined, (snapshot) => {
        hostRef.current?.broadcast({ kind: 'snapshot', snapshot });
      });
    }
    // The host does not ping: `peer.ts` answers the guest's pings inline, and
    // the guest reports the measured round trip back in its input stream.
    syncMatch({ scores: [0, 0], games: [0, 0], phase: 'serving', server: 0, winner: null });
    hostRef.current?.broadcast({ kind: 'start' });
    setScreen('playing');
  }, [buildEngine, setScreen, syncMatch]);

  /** Host: settle the vote, show the result to both players, then play. */
  const hostSettleVote = useCallback(() => {
    const { vote, setVote, setVenue } = useStore.getState();
    if (vote.result) return;
    clearVoteTimer();
    const venue = settleVote(vote.votes);
    setVenue(venue);
    setVote({ result: venue });
    hostRef.current?.broadcast({ kind: 'venue', venue });
    voteTimerRef.current = window.setTimeout(() => {
      voteTimerRef.current = null;
      launchHostedMatch();
    }, RESULT_PAUSE_MS);
  }, [clearVoteTimer, launchHostedMatch]);

  /** Host: record a vote from either side; settle once both are in. */
  const hostCastVote = useCallback(
    (side: PlayerSide, venue: Venue) => {
      const { vote, screen: current, setVote } = useStore.getState();
      if (vote.result || current !== 'vote') return;
      const votes: [Venue | null, Venue | null] = [vote.votes[0], vote.votes[1]];
      votes[side] = venue;
      setVote({ votes });
      hostRef.current?.broadcast({ kind: 'votes', votes });
      if (votes[0] && votes[1]) hostSettleVote();
    },
    [hostSettleVote],
  );

  /** Host: open a vote for both players. Before every match, rematches too. */
  const hostOpenVote = useCallback(() => {
    clearVoteTimer();
    useStore.getState().setVote({
      mode: 'online',
      solo: null,
      votes: [null, null],
      result: null,
      deadline: Date.now() + VOTE_SECONDS * 1000,
    });
    setScreen('vote');
    hostRef.current?.broadcast({ kind: 'vote-start', seconds: VOTE_SECONDS });
    // Nobody is kept waiting by a player who does not vote: when time is up,
    // the votes cast so far decide (or a random venue, if there are none).
    voteTimerRef.current = window.setTimeout(() => {
      voteTimerRef.current = null;
      hostSettleVote();
    }, VOTE_SECONDS * 1000);
  }, [clearVoteTimer, hostSettleVote, setScreen]);

  /*
   * The network callbacks are created once, when hosting starts, so they reach
   * the vote functions through this ref and always call the current ones.
   */
  const hostVote = useRef({ cast: hostCastVote, open: hostOpenVote });
  hostVote.current = { cast: hostCastVote, open: hostOpenVote };

  /** Solo games (vs the computer, practice): a vote of one, picked here. */
  const openSoloVote = useCallback(
    (kind: 'ai' | 'practice') => {
      initAudio();
      playUiClick();
      clearVoteTimer();
      useStore.getState().setVote({
        mode: 'solo',
        solo: kind,
        votes: [null, null],
        result: null,
        deadline: null,
      });
      setScreen('vote');
    },
    [clearVoteTimer, setScreen],
  );

  /** This player picks a venue on the vote screen. */
  const castVote = useCallback(
    (venue: Venue) => {
      const { vote, mode: currentMode, setVote, setVenue } = useStore.getState();
      if (vote.result) return;
      playUiClick();
      if (vote.mode === 'solo') {
        setVote({ votes: [venue, null], result: venue });
        setVenue(venue);
        voteTimerRef.current = window.setTimeout(() => {
          voteTimerRef.current = null;
          if (vote.solo === 'practice') startPractice();
          else startAiMatch();
        }, SOLO_PAUSE_MS);
        return;
      }
      if (currentMode === 'host') {
        hostCastVote(0, venue);
        return;
      }
      // Guest: show our pick at once, and tell the host, who settles it.
      setVote({ votes: [vote.votes[0], venue] });
      guestRef.current?.send({ kind: 'vote', venue });
    },
    [hostCastVote, startAiMatch, startPractice],
  );

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
            { ...profile, name: profile.name || 'Host' },
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
            hostRef.current?.broadcast({ kind: 'venue', venue: useStore.getState().venue });
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
          if (message.kind === 'vote') {
            if (isVenue(message.venue)) hostVote.current.cast(1, message.venue);
            return;
          }
          if (message.kind === 'rematch') {
            // Either player can ask; the next match is voted on like the first.
            if (useStore.getState().screen !== 'vote') hostVote.current.open();
            return;
          }
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
  /** Host: "Start match" in the lobby opens the venue vote. */
  const beginHostedMatch = useCallback(() => {
    playUiClick();
    hostOpenVote();
  }, [hostOpenVote]);

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
              // From the host, so untrusted like any network data.
              setProfiles([
                sanitizeProfile(message.profiles?.[0], 'Host'),
                sanitizeProfile(message.profiles?.[1], 'Player'),
              ]);
              break;
            case 'start':
              // Also sent on a rematch, so clear the stale winner or the
              // match-over effect fires again immediately.
              syncMatch({
                scores: [0, 0],
                games: [0, 0],
                phase: 'serving',
                server: 0,
                winner: null,
              });
              setScreen('playing');
              break;
            case 'vote-start': {
              const seconds = Math.min(60, Math.max(1, Number(message.seconds) || VOTE_SECONDS));
              useStore.getState().setVote({
                mode: 'online',
                solo: null,
                votes: [null, null],
                result: null,
                deadline: Date.now() + seconds * 1000,
              });
              setScreen('vote');
              break;
            }
            case 'votes': {
              const [a, b] = Array.isArray(message.votes) ? message.votes : [null, null];
              useStore.getState().setVote({ votes: [isVenue(a) ? a : null, isVenue(b) ? b : null] });
              break;
            }
            case 'venue':
              if (isVenue(message.venue)) {
                useStore.getState().setVenue(message.venue);
                useStore.getState().setVote({ result: message.venue });
              }
              break;
            case 'full': {
              // Someone else got the seat first (the list can lag by a moment).
              if (pingTimerRef.current !== null) {
                window.clearInterval(pingTimerRef.current);
                pingTimerRef.current = null;
              }
              guestRef.current?.close();
              guestRef.current = null;
              joiningRef.current = false;
              setConnection('error');
              setJoinError('That room is already full. Pick another room.');
              break;
            }
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
          setJoinError(error);
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
    } catch (error) {
      setConnection('error');
      setJoinError(error instanceof Error ? error.message : 'Could not join that room.');
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

  /** Join a room picked from the public list: same path as an invite link. */
  const joinListedRoom = useCallback(
    (code: string) => {
      playUiClick();
      setJoinError(null);
      setJoiningCode(code);
      setScreen('profile');
    },
    [setJoinError, setScreen],
  );

  const confirmProfile = useCallback(() => {
    if (joiningCode) void joinAsGuest();
    else setScreen('menu');
  }, [joinAsGuest, joiningCode, setScreen]);

  const exitToMenu = useCallback(() => {
    playUiClick();
    teardown();
    // Do not let a cheer or a call carry over into the menu.
    resetCrowd();
    hushUmpire();
    useStore.getState().reset();
  }, [teardown]);

  /** Rematch: every match starts with a venue vote, rematches included. */
  const rematch = useCallback(() => {
    const currentMode = useStore.getState().mode;
    if (currentMode === 'ai' || currentMode === 'practice') {
      openSoloVote(currentMode);
      return;
    }
    playUiClick();
    if (currentMode === 'host') {
      hostOpenVote();
      return;
    }
    // Guest: ask the host, who opens the vote for both of us.
    guestRef.current?.send({ kind: 'rematch' });
  }, [hostOpenVote, openSoloVote]);

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
          camera={{ fov: CAMERA_FOV, position: initialCameraPosition(side), near: 0.1, far: 400 }}
        >
          <GameScene
            engine={engineRef.current}
            input={inputRef.current}
            side={side}
          />
        </Canvas>
      )}

      {screen === 'playing' && <Hud getCharge={readCharge} />}
      {screen === 'menu' && (
        <MenuScreen
          onPlayAi={() => openSoloVote('ai')}
          onCustomize={openCustomize}
          onJoinRoom={joinListedRoom}
          onHost={() => void startHosting()}
          onPractice={() => openSoloVote('practice')}
        />
      )}
      {screen === 'vote' && <VoteScreen onVote={castVote} onLeave={exitToMenu} />}
      {screen === 'customize' && (
        <CustomizeScreen
          onDone={() => {
            playUiClick();
            setScreen(customizeReturn.current);
          }}
        />
      )}
      {screen === 'profile' && (
        <ProfileScreen
          joiningCode={joiningCode}
          onConfirm={confirmProfile}
          onCustomize={openCustomize}
          onBack={() => {
            // Also hangs up a join still in progress, so it cannot finish
            // behind the menu and seat us in a room we walked away from.
            setJoiningCode(null);
            exitToMenu();
          }}
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
