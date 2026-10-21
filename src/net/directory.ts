/**
 * The public room list, with no server of our own.
 *
 * One online player's browser quietly acts as the "directory": it claims a
 * fixed, well-known PeerJS id, every other online player connects to it, and
 * it keeps the list of open rooms and sends it to everyone. Nobody sees any of
 * this; it is just a page that happens to be holding the list.
 *
 * Election is done by the PeerJS broker itself. Ids are unique, so when a
 * player connects and finds no directory, they try to claim the id; if two
 * try at once, the broker accepts exactly one and the other connects to it.
 * When the directory's player leaves, everyone else notices the connection
 * drop, waits a random moment (so they do not all collide), and the same
 * claim-or-connect step picks a new directory. Each player re-sends their own
 * room to the new directory, so the list rebuilds within a few seconds.
 *
 * A room lives only as long as its host's connection to the directory: closing
 * the tab, cancelling, or starting the match removes it. A heartbeat removes a
 * host whose connection died silently.
 *
 * Trust: anything received here comes from another player's browser, so it is
 * sanitized on arrival, and the directory keeps at most one room per player.
 */

import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';

export type RoomInfo = {
  /** The room code, as in an invite link. */
  code: string;
  /** The host's name, as shown in the list. */
  name: string;
  /** The host's shirt colour, for the list's colour dot. */
  color: string;
};

export type DirectoryStatus = 'connecting' | 'online' | 'offline';

export type DirectoryCallbacks = {
  /** The current open rooms, and how many players are online. */
  onRooms(rooms: RoomInfo[], online: number): void;
  onStatus(status: DirectoryStatus): void;
};

export type DirectoryHandle = {
  /** Show this player's room in the list, or `null` to take it down. */
  publish(room: RoomInfo | null): void;
  close(): void;
};

/** The fixed id the directory claims. Versioned so a protocol change can move it. */
const DIRECTORY_ID = 'maxtennis-directory-v1';
const CONNECTION_OPTIONS = { serialization: 'json', reliable: true } as const;

/** How often members say "still here", and how long silence means gone. */
const HEARTBEAT_MS = 4000;
const MEMBER_TIMEOUT_MS = 15000;
/** The directory re-sends the whole list this often, so nobody drifts. */
const BROADCAST_MS = 5000;
/** Give up waiting for the directory to answer after this long, and claim it. */
const CONNECT_TIMEOUT_MS = 8000;
const MAX_ROOMS = 40;

type MemberMessage =
  | { kind: 'publish'; room: RoomInfo }
  | { kind: 'unpublish' }
  | { kind: 'heartbeat' };
type DirectoryMessage = { kind: 'rooms'; rooms: RoomInfo[]; online: number };

const CODE = /^[A-Z0-9]{4,10}$/;
const HEX = /^#[0-9a-f]{6}$/i;

/** Accept a room from another browser only if every field is sane. */
export function sanitizeRoom(raw: unknown): RoomInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.code !== 'string' || !CODE.test(r.code)) return null;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 16) : '';
  const color = typeof r.color === 'string' && HEX.test(r.color) ? r.color : '#8a94a6';
  return { code: r.code, name, color };
}

function randomDelay(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function connectDirectory(callbacks: DirectoryCallbacks): DirectoryHandle {
  let closed = false;
  let myRoom: RoomInfo | null = null;

  /** This player's ordinary peer, used to reach the directory. */
  let member: Peer | null = null;
  /** The live link to the directory, when this player is a member. */
  let link: DataConnection | null = null;
  /** Set while this player IS the directory. */
  let directory: Peer | null = null;

  const timers = new Set<number>();
  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };
  const every = (fn: () => void, ms: number) => {
    const id = window.setInterval(fn, ms);
    timers.add(id);
    return id;
  };
  const stop = (id: number | null) => {
    if (id === null) return;
    window.clearTimeout(id);
    window.clearInterval(id);
    timers.delete(id);
  };

  const status = (s: DirectoryStatus) => {
    try {
      callbacks.onStatus(s);
    } catch {
      /* a UI callback must never take the directory down */
    }
  };
  const deliver = (rooms: RoomInfo[], online: number) => {
    try {
      callbacks.onRooms(rooms, online);
    } catch {
      /* as above */
    }
  };

  /* ---------------- Member side ---------------- */

  let heartbeat: number | null = null;
  let connectTimeout: number | null = null;
  /** True between asking for the directory and hearing back. */
  let seeking = false;

  const sendToDirectory = (message: MemberMessage) => {
    if (!link || !link.open) return;
    try {
      link.send(message);
    } catch {
      /* the close handler will re-elect */
    }
  };

  const announce = () => {
    sendToDirectory(myRoom ? { kind: 'publish', room: myRoom } : { kind: 'unpublish' });
  };

  /** Lost the directory: try again after a random pause, so we do not all collide. */
  const retry = (minMs = 300, maxMs = 1500) => {
    if (closed || directory) return;
    link = null;
    stop(heartbeat);
    heartbeat = null;
    status('connecting');
    later(seek, randomDelay(minMs, maxMs));
  };

  /** Connect to the directory, or claim it if there is none. */
  function seek(): void {
    if (closed || directory || !member || member.destroyed || seeking) return;
    if (member.disconnected) {
      // Lost the broker; reconnect first and come back here when it opens.
      try {
        member.reconnect();
      } catch {
        retry(2000, 4000);
      }
      return;
    }
    seeking = true;
    status('connecting');

    const conn = member.connect(DIRECTORY_ID, CONNECTION_OPTIONS);
    connectTimeout = later(() => {
      // No answer: whoever held the id may be gone. Try to take it over.
      seeking = false;
      conn.removeAllListeners();
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      claim();
    }, CONNECT_TIMEOUT_MS);

    conn.on('open', () => {
      stop(connectTimeout);
      seeking = false;
      if (closed) return;
      link = conn;
      status('online');
      announce();
      heartbeat = every(() => sendToDirectory({ kind: 'heartbeat' }), HEARTBEAT_MS);
    });
    conn.on('data', (data: unknown) => {
      const message = data as Partial<DirectoryMessage> | null;
      if (!message || message.kind !== 'rooms' || !Array.isArray(message.rooms)) return;
      const rooms = message.rooms
        .map(sanitizeRoom)
        .filter((r): r is RoomInfo => r !== null)
        .slice(0, MAX_ROOMS);
      const online = Number.isFinite(message.online) ? Math.max(1, Number(message.online)) : 1;
      deliver(rooms, online);
    });
    const lost = () => {
      if (link === conn) retry();
    };
    conn.on('close', lost);
    conn.on('error', lost);
  }

  /** Try to become the directory. The broker decides if two try at once. */
  function claim(): void {
    if (closed || directory) return;
    const candidate = new Peer(DIRECTORY_ID, { debug: 0 });
    candidate.on('open', () => {
      if (closed) {
        candidate.destroy();
        return;
      }
      becomeDirectory(candidate);
    });
    candidate.on('error', (error: unknown) => {
      if (directory === candidate) return;
      const type = (error as { type?: string } | null)?.type;
      try {
        candidate.destroy();
      } catch {
        /* ignore */
      }
      // 'unavailable-id': someone else got there first, so join them instead.
      if (type === 'unavailable-id') retry(200, 800);
      else retry(3000, 6000);
    });
  }

  /* ---------------- Directory side ---------------- */

  type Member = { conn: DataConnection; room: RoomInfo | null; lastSeen: number };
  const members = new Map<string, Member>();

  const roomList = (): RoomInfo[] => {
    const rooms: RoomInfo[] = [];
    if (myRoom) rooms.push(myRoom);
    for (const m of members.values()) {
      if (m.room && rooms.length < MAX_ROOMS) rooms.push(m.room);
    }
    return rooms;
  };

  const broadcast = () => {
    if (!directory) return;
    const rooms = roomList();
    // Members plus the directory's own player.
    const online = members.size + 1;
    const message: DirectoryMessage = { kind: 'rooms', rooms, online };
    for (const m of members.values()) {
      if (!m.conn.open) continue;
      try {
        m.conn.send(message);
      } catch {
        /* the close handler tidies up */
      }
    }
    deliver(rooms, online);
  };

  function becomeDirectory(peer: Peer): void {
    directory = peer;
    // We no longer need a link to someone else's directory.
    if (link) {
      link.removeAllListeners();
      try {
        link.close();
      } catch {
        /* ignore */
      }
      link = null;
    }
    stop(heartbeat);
    heartbeat = null;
    status('online');

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        members.set(conn.connectionId, { conn, room: null, lastSeen: Date.now() });
        broadcast();
      });
      conn.on('data', (data: unknown) => {
        const m = members.get(conn.connectionId);
        if (!m) return;
        m.lastSeen = Date.now();
        const message = data as Partial<MemberMessage> | null;
        if (message?.kind === 'publish') {
          m.room = sanitizeRoom(message.room);
          broadcast();
        } else if (message?.kind === 'unpublish') {
          m.room = null;
          broadcast();
        }
      });
      const gone = () => {
        if (members.delete(conn.connectionId)) broadcast();
      };
      conn.on('close', gone);
      conn.on('error', gone);
    });

    // Keep the broker link alive so new players can still find us.
    peer.on('disconnected', () => {
      if (!closed && !peer.destroyed) {
        try {
          peer.reconnect();
        } catch {
          /* the sweep below keeps serving existing members meanwhile */
        }
      }
    });
    peer.on('error', () => {
      /* individual connection failures are handled per connection */
    });

    // Drop members that went silent (a tab closed without a clean goodbye),
    // and refresh everyone's list.
    every(() => {
      const now = Date.now();
      for (const [id, m] of members) {
        if (now - m.lastSeen > MEMBER_TIMEOUT_MS) {
          members.delete(id);
          try {
            m.conn.close();
          } catch {
            /* ignore */
          }
        }
      }
      broadcast();
    }, BROADCAST_MS);

    broadcast();
  }

  /* ---------------- Start ---------------- */

  try {
    member = new Peer({ debug: 0 });
    member.on('open', () => seek());
    member.on('error', (error: unknown) => {
      const type = (error as { type?: string } | null)?.type;
      if (type === 'peer-unavailable' && seeking) {
        // Nobody holds the directory id: claim it.
        seeking = false;
        stop(connectTimeout);
        claim();
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error') {
        status('offline');
        retry(4000, 8000);
      }
    });
    member.on('disconnected', () => {
      if (!closed) retry(1000, 3000);
    });
  } catch {
    status('offline');
  }

  return {
    publish(room: RoomInfo | null): void {
      myRoom = room;
      if (directory) broadcast();
      else announce();
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const id of timers) {
        window.clearTimeout(id);
        window.clearInterval(id);
      }
      timers.clear();
      for (const peer of [member, directory]) {
        if (!peer) continue;
        peer.removeAllListeners();
        try {
          peer.destroy();
        } catch {
          /* ignore */
        }
      }
      member = null;
      directory = null;
      link = null;
      members.clear();
    },
  };
}
