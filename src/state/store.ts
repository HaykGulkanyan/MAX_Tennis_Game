/**
 * The single React-facing store.
 *
 * This is the contract every other module builds against, so it is defined up
 * front and deliberately kept small. The simulation stays the source of truth
 * for *rules*; this holds only what React needs to render and what the network
 * layer needs to coordinate.
 *
 * Deliberately NOT in here: the live snapshot. React re-rendering at 60Hz on
 * ball position would be miserable, so the render loop reads the snapshot from
 * `engineRef` via `useFrame` and mutates THREE objects directly. Only
 * low-frequency state (score, phase, connection) lives in the store and drives
 * re-renders.
 */

import { create } from 'zustand';
import type {
  CameraMode,
  ConnectionStatus,
  Difficulty,
  GameMode,
  PlayerProfile,
  PlayerSide,
  RallyPhase,
} from '../game/types';
import { SHIRT_COLORS } from '../game/constants';

export type UiScreen =
  | 'menu'
  | 'profile'
  | 'lobby'
  | 'playing'
  | 'match-over';

export type StoreState = {
  screen: UiScreen;
  mode: GameMode;
  difficulty: Difficulty;
  /** View preference, local to this client only. */
  cameraMode: CameraMode;

  /** This client's own profile, and which side it controls. */
  profile: PlayerProfile;
  side: PlayerSide;
  /** Both players' profiles, indexed by side. */
  profiles: [PlayerProfile, PlayerProfile];

  connection: ConnectionStatus;
  /** Room code for the invite link, when hosting. */
  roomCode: string | null;
  /** Smoothed round-trip time in ms, for the fairness delay and the HUD. */
  latencyMs: number;

  // --- Low-frequency mirror of the match, for the HUD only. ---
  scores: [number, number];
  phase: RallyPhase;
  /** Which side is serving, so the HUD can say whose serve it is. */
  server: PlayerSide;
  /** Set when a point ends, cleared on the next serve; drives the callout. */
  callout: string | null;
  winner: PlayerSide | null;

  /** True when the browser cannot play (no pointer, e.g. a phone). */
  unsupported: boolean;

  setScreen: (screen: UiScreen) => void;
  setMode: (mode: GameMode) => void;
  setDifficulty: (difficulty: Difficulty) => void;
  setCameraMode: (cameraMode: CameraMode) => void;
  cycleCameraMode: () => void;
  setProfile: (profile: Partial<PlayerProfile>) => void;
  setProfiles: (profiles: [PlayerProfile, PlayerProfile]) => void;
  setSide: (side: PlayerSide) => void;
  setConnection: (connection: ConnectionStatus) => void;
  setRoomCode: (roomCode: string | null) => void;
  setLatency: (latencyMs: number) => void;
  setCallout: (callout: string | null) => void;
  setUnsupported: (unsupported: boolean) => void;
  /** Mirror the parts of the match the HUD shows. Called at most a few Hz. */
  syncMatch: (match: {
    scores: [number, number];
    phase: RallyPhase;
    server: PlayerSide;
    winner: PlayerSide | null;
  }) => void;
  reset: () => void;
};

const defaultProfile = (): PlayerProfile => ({
  name: '',
  color: SHIRT_COLORS[0],
});

const initial = {
  screen: 'menu' as UiScreen,
  mode: 'menu' as GameMode,
  difficulty: 'medium' as Difficulty,
  cameraMode: 'broadcast' as CameraMode,
  profile: defaultProfile(),
  side: 0 as PlayerSide,
  profiles: [defaultProfile(), defaultProfile()] as [PlayerProfile, PlayerProfile],
  connection: 'idle' as ConnectionStatus,
  roomCode: null as string | null,
  latencyMs: 0,
  scores: [0, 0] as [number, number],
  phase: 'serving' as RallyPhase,
  server: 0 as PlayerSide,
  callout: null as string | null,
  winner: null as PlayerSide | null,
  unsupported: false,
};

export const useStore = create<StoreState>((set) => ({
  ...initial,

  setScreen: (screen) => set({ screen }),
  setMode: (mode) => set({ mode }),
  setDifficulty: (difficulty) => set({ difficulty }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  cycleCameraMode: () =>
    set((s) => {
      const order: CameraMode[] = ['broadcast', 'third', 'first'];
      const next = order[(order.indexOf(s.cameraMode) + 1) % order.length];
      return { cameraMode: next };
    }),
  setProfile: (profile) =>
    set((s) => ({ profile: { ...s.profile, ...profile } })),
  setProfiles: (profiles) => set({ profiles }),
  setSide: (side) => set({ side }),
  setConnection: (connection) => set({ connection }),
  setRoomCode: (roomCode) => set({ roomCode }),
  setLatency: (latencyMs) => set({ latencyMs }),
  setCallout: (callout) => set({ callout }),
  setUnsupported: (unsupported) => set({ unsupported }),
  syncMatch: ({ scores, phase, server, winner }) =>
    set((s) => {
      // Avoid pointless re-renders: only write when something actually moved.
      if (
        s.scores[0] === scores[0] &&
        s.scores[1] === scores[1] &&
        s.phase === phase &&
        s.server === server &&
        s.winner === winner
      ) {
        return s;
      }
      return { scores: [scores[0], scores[1]], phase, server, winner };
    }),
  reset: () => set({ ...initial, profile: defaultProfile() }),
}));
