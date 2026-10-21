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
import { DEFAULT_AVATAR, sanitizeProfile } from '../game/avatar';
import type { Avatar } from '../game/avatar';
import type { DirectoryStatus, RoomInfo } from '../net/directory';

export type UiScreen =
  | 'menu'
  | 'profile'
  | 'customize'
  | 'lobby'
  | 'playing'
  | 'match-over';

export type StoreState = {
  screen: UiScreen;
  mode: GameMode;
  difficulty: Difficulty;
  /** View preference, local to this client only. */
  cameraMode: CameraMode;
  /** Whether the chair umpire calls the score. Remembered between visits. */
  umpireVoice: boolean;

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

  // --- The public room list. Session-wide: kept across menu resets. ---
  rooms: RoomInfo[];
  onlineCount: number;
  directoryStatus: DirectoryStatus;
  /** Whether this host's room is shown in the public list. */
  roomPublic: boolean;
  /** Why joining a room failed, shown on the joining screen. */
  joinError: string | null;

  setScreen: (screen: UiScreen) => void;
  setMode: (mode: GameMode) => void;
  setDifficulty: (difficulty: Difficulty) => void;
  setCameraMode: (cameraMode: CameraMode) => void;
  cycleCameraMode: () => void;
  setUmpireVoice: (on: boolean) => void;
  /** Update this client's profile; it is remembered between visits. */
  setProfile: (profile: Partial<PlayerProfile>) => void;
  /** Change part of this client's look. */
  setAvatar: (avatar: Partial<Avatar>) => void;
  setProfiles: (profiles: [PlayerProfile, PlayerProfile]) => void;
  setSide: (side: PlayerSide) => void;
  setConnection: (connection: ConnectionStatus) => void;
  setRoomCode: (roomCode: string | null) => void;
  setLatency: (latencyMs: number) => void;
  setCallout: (callout: string | null) => void;
  setUnsupported: (unsupported: boolean) => void;
  setDirectory: (rooms: RoomInfo[], onlineCount: number) => void;
  setDirectoryStatus: (status: DirectoryStatus) => void;
  setRoomPublic: (roomPublic: boolean) => void;
  setJoinError: (joinError: string | null) => void;
  /** Mirror the parts of the match the HUD shows. Called at most a few Hz. */
  syncMatch: (match: {
    scores: [number, number];
    phase: RallyPhase;
    server: PlayerSide;
    winner: PlayerSide | null;
  }) => void;
  reset: () => void;
};

const PROFILE_KEY = 'maxtennis.profile';

/** A fresh profile: the saved one if there is one, otherwise the defaults. */
const defaultProfile = (): PlayerProfile => {
  try {
    const saved = window.localStorage.getItem(PROFILE_KEY);
    // Saved data is treated like network data: checked, never trusted.
    if (saved) return sanitizeProfile(JSON.parse(saved));
  } catch {
    // Unreadable or blocked storage: fall through to the defaults.
  }
  return { name: '', color: SHIRT_COLORS[0], avatar: { ...DEFAULT_AVATAR } };
};

function saveProfile(profile: PlayerProfile): void {
  try {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // Not remembered, but still applies for this visit.
  }
}

const UMPIRE_VOICE_KEY = 'maxtennis.umpireVoice';

/** Storage can be blocked (private mode, sandboxed frames); default to on. */
function loadUmpireVoice(): boolean {
  try {
    return window.localStorage.getItem(UMPIRE_VOICE_KEY) !== 'off';
  } catch {
    return true;
  }
}

const initial = {
  screen: 'menu' as UiScreen,
  mode: 'menu' as GameMode,
  difficulty: 'medium' as Difficulty,
  cameraMode: 'broadcast' as CameraMode,
  umpireVoice: typeof window === 'undefined' ? true : loadUmpireVoice(),
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
  rooms: [] as RoomInfo[],
  onlineCount: 0,
  directoryStatus: 'connecting' as DirectoryStatus,
  roomPublic: true,
  joinError: null as string | null,
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
  setUmpireVoice: (umpireVoice) => {
    try {
      window.localStorage.setItem(UMPIRE_VOICE_KEY, umpireVoice ? 'on' : 'off');
    } catch {
      // Not remembered, but still applies for this visit.
    }
    set({ umpireVoice });
  },
  setProfile: (profile) =>
    set((s) => {
      const next = { ...s.profile, ...profile };
      saveProfile(next);
      return { profile: next };
    }),
  setAvatar: (avatar) =>
    set((s) => {
      const next = { ...s.profile, avatar: { ...s.profile.avatar, ...avatar } };
      saveProfile(next);
      return { profile: next };
    }),
  setProfiles: (profiles) => set({ profiles }),
  setSide: (side) => set({ side }),
  setConnection: (connection) => set({ connection }),
  setRoomCode: (roomCode) => set({ roomCode }),
  setLatency: (latencyMs) => set({ latencyMs }),
  setCallout: (callout) => set({ callout }),
  setUnsupported: (unsupported) => set({ unsupported }),
  setDirectory: (rooms, onlineCount) => set({ rooms, onlineCount }),
  setDirectoryStatus: (directoryStatus) => set({ directoryStatus }),
  setRoomPublic: (roomPublic) => set({ roomPublic }),
  setJoinError: (joinError) => set({ joinError }),
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
  // Keep session-wide state: the voice preference and the live room list.
  reset: () =>
    set((s) => ({
      ...initial,
      profile: defaultProfile(),
      umpireVoice: s.umpireVoice,
      rooms: s.rooms,
      onlineCount: s.onlineCount,
      directoryStatus: s.directoryStatus,
    })),
}));
