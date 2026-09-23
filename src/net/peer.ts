/**
 * The network layer: a thin, typed wrapper over PeerJS.
 *
 * Topology is a star with the host at the centre. The host owns the only
 * authoritative simulation (see `game/engine.ts`), so every guest is a leaf
 * that sends `ClientMessage`s up and renders the `HostMessage`s that come back.
 * There is no peer-to-peer traffic between guests.
 *
 * This module deliberately knows nothing about the engine. It hands raw,
 * already-filtered messages to its callbacks and lets the caller drive the
 * engine; that keeps the simulation testable without a browser.
 */

import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import type {
  ClientMessage,
  ConnectionStatus,
  HostMessage,
  PeerRole,
  PlayerProfile,
  PlayerSide,
} from '../game/types';

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export type HostHandle = {
  roomCode: string;
  inviteUrl: string;
  /** Broadcast to every connected peer. */
  broadcast(message: HostMessage): void;
  /** Number of connected players (excluding spectators). */
  playerCount(): number;
  close(): void;
};

export type GuestHandle = {
  send(message: ClientMessage): void;
  close(): void;
};

export type HostCallbacks = {
  onStatus(status: ConnectionStatus): void;
  onPeerJoined(role: PeerRole, profile: PlayerProfile): void;
  onPeerLeft(role: PeerRole): void;
  onClientMessage(message: ClientMessage): void;
  onError(error: string): void;
};

export type GuestCallbacks = {
  onStatus(status: ConnectionStatus): void;
  onHostMessage(message: HostMessage): void;
  onError(error: string): void;
};

// --------------------------------------------------------------------------
// Room codes and invite links
// --------------------------------------------------------------------------

/**
 * Codes get read aloud over voice chat and typed by hand, so the alphabet
 * drops every glyph that has a twin in a common font: 0/O, 1/I/L. What is left
 * is unambiguous whether it is spoken, typed, or squinted at on a phone.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/**
 * PeerJS's public broker is a single global namespace shared by every app that
 * uses the default cloud server, so a bare six-character code would collide
 * with unrelated projects (and let them connect to us). Prefixing makes the
 * broker id effectively ours while the code we show the user stays short.
 */
const PEER_ID_PREFIX = 'maxtennis-';

/** Query parameter carrying the room code in an invite link. */
const ROOM_PARAM = 'r';

/** Generate a short, human-readable, unambiguous room code. */
export function generateRoomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);

  // crypto is the right source, but it is absent in some non-browser and
  // insecure-origin contexts; Math.random is a fine fallback for a room code,
  // which is a rendezvous token and not a secret.
  const webCrypto: Crypto | undefined =
    typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;

  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    // Modulo bias across 256 values over a 31-letter alphabet is negligible
    // here; collisions are handled by the broker rejecting a taken id anyway.
    code += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return code;
}

/** Normalise user-typed input: trim, upper-case, drop spaces and dashes. */
function normaliseRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function peerIdForRoom(roomCode: string): string {
  return PEER_ID_PREFIX + normaliseRoomCode(roomCode);
}

/** True when we are running somewhere with a real DOM and a location. */
function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof window.location !== 'undefined';
}

/**
 * Build the shareable invite URL for a room code.
 *
 * GitHub Pages serves this app from a project subpath (`/MAX_Tennis_Game/`),
 * so the base has to be origin + pathname; hardcoding a domain or assuming the
 * root would produce links that 404 for everyone we send them to. Any existing
 * query string is dropped on purpose so re-sharing from a joined page does not
 * accumulate stale parameters.
 */
export function inviteUrlFor(roomCode: string): string {
  const code = normaliseRoomCode(roomCode);
  if (!hasWindow()) return `?${ROOM_PARAM}=${code}`;
  const base = window.location.origin + window.location.pathname;
  return `${base}?${ROOM_PARAM}=${encodeURIComponent(code)}`;
}

/** Read the room code from the current URL (?r=CODE), or null. */
export function roomCodeFromUrl(): string | null {
  if (!hasWindow()) return null;
  try {
    const raw = new URLSearchParams(window.location.search).get(ROOM_PARAM);
    if (!raw) return null;
    const code = normaliseRoomCode(raw);
    return code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

/**
 * PeerJS error `type`s are terse machine strings that would be meaningless in
 * the UI, so translate them once here rather than at every call site.
 */
function humanError(error: unknown): string {
  const type =
    typeof error === 'object' && error !== null && 'type' in error
      ? String((error as { type: unknown }).type)
      : '';

  switch (type) {
    case 'peer-unavailable':
      return 'That room code was not found. Check the code, or ask the host to start a new match.';
    case 'unavailable-id':
      return 'That room code is already in use. Try starting a new match.';
    case 'invalid-id':
    case 'invalid-key':
      return 'That room code is not valid.';
    case 'browser-incompatible':
      return 'This browser does not support the peer-to-peer features the game needs.';
    case 'network':
      return 'Lost contact with the matchmaking server. Check your connection and try again.';
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'The matchmaking server is unreachable right now. Please try again in a moment.';
    case 'ssl-unavailable':
      return 'A secure connection to the matchmaking server could not be established.';
    case 'disconnected':
      return 'Disconnected from the matchmaking server.';
    case 'webrtc':
    case 'negotiation-failed':
      return 'Could not open a direct connection to the other player; a firewall or VPN may be blocking it.';
    case 'connection-closed':
      return 'The connection was closed.';
    case 'not-open-yet':
      return 'The connection is not ready yet.';
    case 'message-too-big':
      return 'A network message was too large to send.';
    default:
      break;
  }

  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'An unexpected network error occurred.';
}

/**
 * Callbacks are supplied by React components that can throw (a bad render, a
 * stale ref). A throw inside a PeerJS event handler escapes into the library's
 * emitter and can tear the connection down, so every call is fenced.
 */
function safely(run: () => void, onError?: (message: string) => void): void {
  try {
    run();
  } catch (error) {
    if (!onError) return;
    try {
      onError(humanError(error));
    } catch {
      // Nothing sensible left to do; swallow so PeerJS keeps running.
    }
  }
}

/**
 * Shared connection options. `json` keeps our plain-object messages
 * round-tripping predictably: PeerJS's default binary pack would also work but
 * it mangles some values and makes wire captures unreadable while debugging.
 */
const CONNECTION_OPTIONS = { serialization: 'json', reliable: true } as const;

/** Narrow unknown wire data to one of our message unions. */
function asMessage<T extends { kind: string }>(data: unknown): T | null {
  if (typeof data !== 'object' || data === null) return null;
  if (typeof (data as { kind?: unknown }).kind !== 'string') return null;
  return data as T;
}

const FALLBACK_PROFILE: PlayerProfile = { name: 'Player', color: '#ffffff' };

// --------------------------------------------------------------------------
// Host
// --------------------------------------------------------------------------

/** Per-connection bookkeeping the host keeps for each joiner. */
type HostPeerRecord = {
  connection: DataConnection;
  role: PeerRole;
  side: PlayerSide;
  profile: PlayerProfile;
};

/**
 * Start hosting. Resolves once the broker has assigned an id.
 *
 * Rejects only if the room could not be opened at all; once open, later
 * failures arrive through `callbacks.onError` instead.
 */
export function startHost(callbacks: HostCallbacks): Promise<HostHandle> {
  return new Promise<HostHandle>((resolve, reject) => {
    if (!hasWindow()) {
      reject(new Error('Hosting requires a browser environment.'));
      return;
    }

    const roomCode = generateRoomCode();
    const peer = new Peer(peerIdForRoom(roomCode), { debug: 0 });

    const peers = new Map<string, HostPeerRecord>();

    /**
     * Whose connection currently owns side 1. Null means the seat is free, so
     * the next joiner asking to play takes it. This is what makes a rejoin work
     * after a drop: we do not pin the seat to a peer id, because PeerJS hands a
     * guest a brand new random id on every page load, so the returning human
     * would otherwise be demoted to a spectator forever.
     */
    let playerConnectionId: string | null = null;

    let settled = false;
    let closed = false;

    const fail = (message: string) => safely(() => callbacks.onError(message));
    const status = (value: ConnectionStatus) =>
      safely(() => callbacks.onStatus(value), (m) => fail(m));

    const handle: HostHandle = {
      roomCode,
      inviteUrl: inviteUrlFor(roomCode),

      broadcast(message: HostMessage): void {
        if (closed) return;
        for (const record of peers.values()) {
          if (!record.connection.open) continue;
          try {
            record.connection.send(message);
          } catch {
            // A send can throw if the channel died between the open check and
            // here. The 'close' handler will clean the record up shortly.
          }
        }
      },

      playerCount(): number {
        let count = 0;
        for (const record of peers.values()) {
          if (record.role === 'player') count += 1;
        }
        // The host itself always occupies side 0.
        return count + 1;
      },

      close(): void {
        if (closed) return;
        closed = true;
        for (const record of peers.values()) {
          record.connection.removeAllListeners();
          try {
            record.connection.close();
          } catch {
            // Already gone.
          }
        }
        peers.clear();
        playerConnectionId = null;
        peer.removeAllListeners();
        try {
          peer.destroy();
        } catch {
          // Already destroyed.
        }
        status('closed');
      },
    };

    const handleConnection = (connection: DataConnection) => {
      if (closed) {
        try {
          connection.close();
        } catch {
          /* ignore */
        }
        return;
      }

      // Side 1 is the only guest player seat; everyone else watches. This is
      // decided at open time, not connect time, so a seat freed by a drop is
      // already available to whoever reconnects next.
      connection.on('open', () => {
        const wantsPlayer =
          (connection.metadata as { role?: unknown } | undefined)?.role !== 'spectator';
        const seatFree = playerConnectionId === null;
        const role: PeerRole = wantsPlayer && seatFree ? 'player' : 'spectator';

        // Side 1 either way: the host is always side 0, and a spectator still
        // needs a side so the engine knows which end to put its camera behind.
        const side: PlayerSide = 1;

        const metaProfile = (connection.metadata as { profile?: PlayerProfile } | undefined)
          ?.profile;
        const profile: PlayerProfile =
          metaProfile && typeof metaProfile.name === 'string'
            ? metaProfile
            : { ...FALLBACK_PROFILE };

        if (role === 'player') playerConnectionId = connection.connectionId;

        peers.set(connection.connectionId, { connection, role, side, profile });

        // The joiner cannot render anything until it knows which side it is,
        // so welcome goes out before any snapshot.
        try {
          connection.send({ kind: 'welcome', side, role } satisfies HostMessage);
        } catch (error) {
          fail(humanError(error));
        }

        safely(() => callbacks.onPeerJoined(role, profile), fail);
        if (role === 'player') status('connected');
      });

      connection.on('data', (data: unknown) => {
        const message = asMessage<ClientMessage>(data);
        if (!message) return;

        const record = peers.get(connection.connectionId);

        // Ping is answered here rather than surfaced, so latency measurement
        // stays honest even while the match is paused or the sender is only
        // spectating. The guest computes RTT from the echoed `sent` stamp.
        if (message.kind === 'ping') {
          if (connection.open) {
            try {
              connection.send({ kind: 'pong', sent: message.sent } satisfies HostMessage);
            } catch {
              /* the close handler will tidy up */
            }
          }
          return;
        }

        // A late profile message can upgrade what we show, but never the role:
        // the seat was assigned on open and re-asking must not steal it.
        if (message.kind === 'profile' && record) {
          record.profile = message.profile;
        }

        // Spectator inputs are dropped here, at the edge, so the engine can
        // never be nudged by an onlooker. Every other kind passes through.
        if (message.kind === 'input' && record?.role !== 'player') return;

        safely(() => callbacks.onClientMessage(message), fail);
      });

      const detach = () => {
        const record = peers.get(connection.connectionId);
        if (!record) return;
        peers.delete(connection.connectionId);
        connection.removeAllListeners();

        if (record.role !== 'player') {
          // A spectator leaving is a non-event for the match; nobody is waiting
          // on them, so the simulation keeps running.
          safely(() => callbacks.onPeerLeft('spectator'), fail);
          return;
        }

        // Free the seat before announcing the drop, so a fast reconnect that
        // lands during the callback is still seated as the player.
        if (playerConnectionId === connection.connectionId) playerConnectionId = null;

        if (!closed) status('waiting-for-rejoin');
        safely(() => callbacks.onPeerLeft('player'), fail);
      };

      connection.on('close', detach);
      connection.on('error', (error: unknown) => {
        fail(humanError(error));
        detach();
      });
    };

    peer.on('open', () => {
      if (settled) return;
      settled = true;
      status('hosting');
      resolve(handle);
    });

    peer.on('connection', handleConnection);

    peer.on('disconnected', () => {
      // The broker link dropped but existing data channels may still be live.
      // Reconnecting reclaims the same id so late joiners can still find us.
      if (closed || peer.destroyed) return;
      try {
        peer.reconnect();
      } catch {
        /* the error handler reports it */
      }
    });

    peer.on('error', (error: unknown) => {
      const message = humanError(error);
      if (!settled) {
        settled = true;
        peer.removeAllListeners();
        try {
          peer.destroy();
        } catch {
          /* ignore */
        }
        reject(new Error(message));
        return;
      }
      fail(message);
      status('error');
    });
  });
}

// --------------------------------------------------------------------------
// Guest
// --------------------------------------------------------------------------

/**
 * Join an existing room by code. Resolves once the data channel is open and
 * the host can be talked to.
 */
export function joinRoom(
  roomCode: string,
  role: PeerRole,
  profile: PlayerProfile,
  callbacks: GuestCallbacks,
): Promise<GuestHandle> {
  return new Promise<GuestHandle>((resolve, reject) => {
    if (!hasWindow()) {
      reject(new Error('Joining requires a browser environment.'));
      return;
    }

    const code = normaliseRoomCode(roomCode);
    if (!code) {
      reject(new Error('Enter a room code to join a match.'));
      return;
    }

    // The guest takes a broker-assigned random id; only the host needs a
    // predictable one, and asking for a fixed id here would collide whenever
    // the same person opened the link in two tabs.
    const peer = new Peer({ debug: 0 });

    let connection: DataConnection | null = null;
    let settled = false;
    let closed = false;

    const fail = (message: string) => safely(() => callbacks.onError(message));
    const status = (value: ConnectionStatus) =>
      safely(() => callbacks.onStatus(value), (m) => fail(m));

    const handle: GuestHandle = {
      send(message: ClientMessage): void {
        if (closed || !connection || !connection.open) return;
        try {
          connection.send(message);
        } catch {
          // Dropped in flight; the close handler reports the disconnect.
        }
      },

      close(): void {
        if (closed) return;
        closed = true;
        if (connection) {
          connection.removeAllListeners();
          try {
            connection.close();
          } catch {
            /* already gone */
          }
          connection = null;
        }
        peer.removeAllListeners();
        try {
          peer.destroy();
        } catch {
          /* already destroyed */
        }
        status('closed');
      },
    };

    const settleError = (message: string) => {
      if (settled) {
        fail(message);
        status('error');
        return;
      }
      settled = true;
      peer.removeAllListeners();
      try {
        peer.destroy();
      } catch {
        /* ignore */
      }
      reject(new Error(message));
    };

    status('connecting');

    peer.on('open', () => {
      if (closed) return;

      // Role and profile ride along as connection metadata so the host can seat
      // this joiner the instant the channel opens, before any message arrives.
      const outgoing = peer.connect(peerIdForRoom(code), {
        ...CONNECTION_OPTIONS,
        metadata: { role, profile },
      });
      connection = outgoing;

      outgoing.on('open', () => {
        if (closed) return;
        if (!settled) {
          settled = true;
          status('connected');
          resolve(handle);
        }
        // Resend the profile on the channel itself; metadata is best effort and
        // the host may want the name after a rejoin re-seats us.
        try {
          outgoing.send({ kind: 'profile', profile, role } satisfies ClientMessage);
        } catch {
          /* non-fatal */
        }
      });

      outgoing.on('data', (data: unknown) => {
        const message = asMessage<HostMessage>(data);
        if (!message) return;
        // Pong is delivered like anything else; RTT is the caller's arithmetic.
        safely(() => callbacks.onHostMessage(message), fail);
      });

      outgoing.on('close', () => {
        if (closed) return;
        outgoing.removeAllListeners();
        connection = null;
        if (!settled) {
          settleError('The host closed the connection before the match started.');
          return;
        }
        status('closed');
      });

      outgoing.on('error', (error: unknown) => {
        if (closed) return;
        settleError(humanError(error));
      });
    });

    peer.on('error', (error: unknown) => {
      if (closed) return;
      settleError(humanError(error));
    });

    peer.on('disconnected', () => {
      if (closed || peer.destroyed) return;
      try {
        peer.reconnect();
      } catch {
        /* reported by the error handler */
      }
    });
  });
}
