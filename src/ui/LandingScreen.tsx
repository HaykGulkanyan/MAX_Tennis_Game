/**
 * The landing page: the game's main menu.
 *
 * One clear main action (Play vs Computer, with its difficulty right beside
 * it), then the ways to play with others, the venues, and how to play. Every
 * control is the real one: difficulty, Customize, the live room list and its
 * Join buttons, the public/private switch for your own room, Create room.
 *
 * It is a scrolling page of its own rather than a centred panel, so it has
 * room for all of that without cramming; the section links in the top bar
 * scroll to each part.
 */

import type React from 'react';

import { MATCH } from '../game/constants';
import { VENUES, VENUE_INFO } from '../game/venues';
import type { Difficulty } from '../game/types';
import { useStore } from '../state/store';
import { ART } from './VoteScreen';
import './landing.css';

const DIFFICULTIES: { value: Difficulty; label: string; note: string }[] = [
  { value: 'easy', label: 'Easy', note: 'Easy: the computer is slow to react and aims down the middle.' },
  { value: 'medium', label: 'Medium', note: 'Medium: a fair rally partner who goes for the lines now and then.' },
  { value: 'hard', label: 'Hard', note: 'Hard: quick, accurate and aims for the corners.' },
];

/** Colour of each venue's court-type label, readable on the dark cards. */
const SURFACE_COLOR = { beach: '#ff9a4a', paris: '#8fd47f', sydney: '#7fb7ff' } as const;

const SECTIONS = [
  { id: 'play', label: 'Play' },
  { id: 'online', label: 'Online rooms' },
  { id: 'venues', label: 'Venues' },
  { id: 'how', label: 'How to play' },
] as const;

/**
 * Scroll to a section without putting a #fragment in the address: the page
 * URL doubles as the invite link, so it is best kept clean.
 */
function goTo(event: React.MouseEvent<HTMLAnchorElement>, id: string): void {
  event.preventDefault();
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

function Kbd({ children }: { children: string }): React.ReactElement {
  return <kbd className="lp-kbd">{children}</kbd>;
}

/** The hero picture: a court from behind the baseline, ball in flight. */
function CourtArt(): React.ReactElement {
  return (
    <svg viewBox="0 0 520 440" className="lp-court" role="img" aria-label="A blue tennis court seen from behind the baseline, with a ball in flight over the net">
      <rect x="0" y="0" width="520" height="440" rx="24" fill="#12203a" />
      <polygon points="40,420 480,420 400,120 120,120" fill="#2f8ade" />
      <polygon points="78,404 442,404 378,136 142,136" fill="#1f6ec7" />
      <polygon points="78,404 442,404 378,136 142,136" fill="none" stroke="#ffffff" strokeWidth="3" />
      <line x1="260" y1="136" x2="260" y2="404" stroke="#ffffff" strokeWidth="2.5" />
      <line x1="112" y1="300" x2="408" y2="300" stroke="#ffffff" strokeWidth="2.5" />
      <line x1="156" y1="196" x2="364" y2="196" stroke="#ffffff" strokeWidth="2" />
      <rect x="118" y="236" width="284" height="30" fill="rgba(11,18,32,0.55)" />
      <line x1="118" y1="236" x2="402" y2="236" stroke="#f4f7fa" strokeWidth="4" />
      <line x1="116" y1="236" x2="116" y2="270" stroke="#3e4a56" strokeWidth="5" />
      <line x1="404" y1="236" x2="404" y2="270" stroke="#3e4a56" strokeWidth="5" />
      <path d="M170 380 Q250 90 330 170" fill="none" stroke="rgba(216,242,36,0.55)" strokeWidth="3" strokeDasharray="6 8" />
      <circle cx="332" cy="172" r="11" fill="#d8f224" />
      <ellipse cx="310" cy="214" rx="12" ry="4" fill="rgba(0,0,0,0.3)" />
      <circle cx="300" cy="214" r="22" fill="none" stroke="#ff8a1f" strokeWidth="3" />
    </svg>
  );
}

/** Feature icons: simple stroke drawings, decorative. */
const FEATURES: { title: string; text: string; icon: React.ReactElement }[] = [
  {
    title: 'Aim where it lands',
    text: 'The marker on the court is exactly where your shot goes.',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="14" cy="14" r="4" fill="currentColor" />
      </svg>
    ),
  },
  {
    title: 'Charge for power',
    text: 'Hold right click until the bar turns green.',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <rect x="3" y="11" width="22" height="7" rx="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <rect x="5" y="13" width="12" height="3" rx="1.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    title: 'A real chair umpire',
    text: '"Deuce!" "Advantage, Hayk!" Every point called aloud.',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M6 11 L11 11 L17 6 L17 22 L11 17 L6 17 Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M21 10 Q24 14 21 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: 'Play friends online',
    text: 'Open a room or join one. No account needed.',
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="9" cy="10" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="19" cy="10" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M3 22 C3 16 15 16 15 22 M13 22 C13 16 25 16 25 22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
];

/** Live list of rooms other players have opened. */
function RoomList(props: { onJoin: (code: string) => void }): React.ReactElement {
  const rooms = useStore((s) => s.rooms);
  const status = useStore((s) => s.directoryStatus);
  return (
    <div className="lp-card lp-rooms">
      {rooms.length > 0 ? (
        <ul className="lp-room-list" aria-label="Open rooms">
          {rooms.map((room) => (
            <li key={room.code} className="lp-room">
              <span className="lp-room-avatar" style={{ backgroundColor: room.color }} aria-hidden="true">
                {(room.name || '?').charAt(0).toUpperCase()}
              </span>
              <span className="lp-room-text">
                <span className="lp-room-name">{room.name ? `${room.name}'s room` : 'Open room'}</span>
                <span className="lp-room-meta">
                  Room <span className="mono">{room.code}</span> · waiting for an opponent
                </span>
              </span>
              <button type="button" className="lp-btn lp-btn-accent lp-btn-join" onClick={() => props.onJoin(room.code)}>
                Join
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="lp-rooms-empty">
          {status === 'offline'
            ? 'The room list is unavailable right now. Invite links still work.'
            : status === 'connecting'
              ? 'Looking for open rooms...'
              : 'No open rooms right now. Open one and it will show up here for everyone.'}
        </p>
      )}
      <p className="lp-rooms-note">Rooms disappear as soon as someone joins or the match starts.</p>
    </div>
  );
}

export function LandingScreen(props: {
  onPlayAi: () => void;
  onHost: () => void;
  onPractice: () => void;
  onCustomize: () => void;
  onJoinRoom: (code: string) => void;
}): React.ReactElement {
  const difficulty = useStore((s) => s.difficulty);
  const setDifficulty = useStore((s) => s.setDifficulty);
  const profile = useStore((s) => s.profile);
  const online = useStore((s) => s.onlineCount);
  const status = useStore((s) => s.directoryStatus);
  const roomPublic = useStore((s) => s.roomPublic);
  const setRoomPublic = useStore((s) => s.setRoomPublic);

  const name = profile.name.trim();
  const note = DIFFICULTIES.find((d) => d.value === difficulty)?.note ?? '';

  return (
    <div className="landing">
      <header className="lp-topbar">
        <nav className="lp-nav lp-wrap" aria-label="Main">
          <a href="#play" className="lp-logo" onClick={(e) => goTo(e, 'play')}>
            <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
              <circle cx="15" cy="15" r="13" fill="#d8f224" />
              <path d="M5 8 Q15 15 5 22 M25 8 Q15 15 25 22" fill="none" stroke="#0b1220" strokeWidth="2" />
            </svg>
            <span>MAX Tennis</span>
          </a>
          <div className="lp-nav-links">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} onClick={(e) => goTo(e, s.id)}>
                {s.label}
              </a>
            ))}
          </div>
          <div className="lp-nav-player">
            <span className="lp-player-chip">
              <span className="lp-player-avatar" style={{ backgroundColor: profile.color }} aria-hidden="true">
                {(name || 'P').charAt(0).toUpperCase()}
              </span>
              <span>{name || 'Player'}</span>
            </span>
            <button type="button" className="lp-btn lp-btn-outline" onClick={props.onCustomize}>
              Customize
            </button>
          </div>
        </nav>
      </header>

      <main>
        <section id="play" className="lp-hero lp-wrap" aria-labelledby="hero-title">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow">Arcade tennis in your browser</p>
            <h1 id="hero-title" className="lp-title">
              Aim it. Charge it. Win the point.
            </h1>
            <p className="lp-lead">
              Real tennis scoring, a chair umpire who calls every point, and a crowd that roars.
              Play the computer, rally in practice, or take on a friend online.
            </p>

            <div className="lp-card lp-play-card">
              <div className="lp-diff-row">
                <span id="diff-label" className="lp-label">
                  Computer difficulty
                </span>
                <div className="lp-segmented" role="group" aria-labelledby="diff-label">
                  {DIFFICULTIES.map((d) => (
                    <button
                      key={d.value}
                      type="button"
                      aria-pressed={difficulty === d.value}
                      className={difficulty === d.value ? 'is-on' : undefined}
                      onClick={() => setDifficulty(d.value)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              <button type="button" className="lp-btn lp-btn-accent lp-btn-hero" onClick={props.onPlayAi}>
                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M6 4 L16 10 L6 16 Z" fill="currentColor" />
                </svg>
                Play vs Computer
              </button>
              <p className="lp-note" aria-live="polite">
                {note}
              </p>
            </div>

            <div className="lp-hero-more">
              <a href="#online" className="lp-btn lp-btn-blue" onClick={(e) => goTo(e, 'online')}>
                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="7" cy="7" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <circle cx="14" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M2 17 C2 13 12 13 12 17 M11 14 C12 12 18 12 18 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                Play with a Friend
              </a>
              <button type="button" className="lp-btn lp-btn-outline" onClick={props.onPractice}>
                Practice
              </button>
            </div>
          </div>

          <div className="lp-hero-art">
            <CourtArt />
            {/* The in-game scoreboard, mid-match, so the scoring is clear at a glance. */}
            <div className="lp-score-chip" aria-hidden="true">
              <span className="lp-score-name">{name || 'You'}</span>
              <span className="lp-score-games">1</span>
              <span className="lp-score-pts">40</span>
              <span className="lp-score-deuce">DEUCE</span>
              <span className="lp-score-pts">40</span>
              <span className="lp-score-games">1</span>
              <span className="lp-score-name">Computer</span>
            </div>
          </div>
        </section>

        <section className="lp-features" aria-label="What makes it fun">
          <ul className="lp-wrap lp-feature-list">
            {FEATURES.map((f) => (
              <li key={f.title} className="lp-feature">
                <span className="lp-feature-icon">{f.icon}</span>
                <span>
                  <span className="lp-feature-title">{f.title}</span>
                  <span className="lp-feature-text">{f.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section id="online" className="lp-section lp-wrap" aria-labelledby="online-title">
          <div className="lp-section-head">
            <div>
              <h2 id="online-title" className="lp-h2">
                Play online
              </h2>
              <p className="lp-sub">Join an open room, or open your own and share the link.</p>
            </div>
            <p className="lp-online" role="status">
              <span className={status === 'online' ? 'lp-dot is-ok' : 'lp-dot'} aria-hidden="true" />
              {status === 'online'
                ? `${online} ${online === 1 ? 'player' : 'players'} online`
                : status === 'connecting'
                  ? 'Connecting...'
                  : 'Offline'}
            </p>
          </div>

          <div className="lp-online-grid">
            <RoomList onJoin={props.onJoinRoom} />

            <div className="lp-card lp-open-room">
              <h3 className="lp-h3">Open your own room</h3>
              <p className="lp-body">
                You get a room code and a link to send. Before the match, both players vote on the venue.
              </p>
              <button
                type="button"
                className={roomPublic ? 'lp-switch is-on' : 'lp-switch'}
                aria-pressed={roomPublic}
                onClick={() => setRoomPublic(!roomPublic)}
              >
                <span className="lp-switch-track" aria-hidden="true">
                  <span className="lp-switch-thumb" />
                </span>
                <span className="lp-switch-text">
                  <span className="lp-switch-title">Show in online rooms</span>
                  <span className="lp-switch-note">
                    {roomPublic ? 'Anyone online can see and join.' : 'Private: only people with your link can join.'}
                  </span>
                </span>
              </button>
              <button type="button" className="lp-btn lp-btn-blue" onClick={props.onHost}>
                Create room
              </button>
            </div>
          </div>
        </section>

        <section id="venues" className="lp-section lp-wrap" aria-labelledby="venues-title">
          <h2 id="venues-title" className="lp-h2">
            Three venues, one vote
          </h2>
          <p className="lp-sub">Before every match, pick where to play. Online, both players vote.</p>
          <div className="lp-venues">
            {VENUES.map((venue) => {
              const Art = ART[venue];
              const info = VENUE_INFO[venue];
              return (
                <article key={venue} className="lp-card lp-venue">
                  <Art />
                  <div className="lp-venue-body">
                    <p className="lp-venue-surface" style={{ color: SURFACE_COLOR[venue] }}>
                      {info.surface}
                    </p>
                    <h3 className="lp-venue-name">{info.name}</h3>
                    <p className="lp-venue-blurb">{info.blurb}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section id="how" className="lp-section lp-section-last lp-wrap" aria-labelledby="how-title">
          <h2 id="how-title" className="lp-h2">
            How to play
          </h2>
          <div className="lp-how-grid">
            <div className="lp-card lp-controls">
              <dl>
                <div className="lp-control">
                  <dt>
                    <Kbd>W</Kbd>
                    <Kbd>A</Kbd>
                    <Kbd>S</Kbd>
                    <Kbd>D</Kbd>
                  </dt>
                  <dd>Move around the court</dd>
                </div>
                <div className="lp-control">
                  <dt>Mouse</dt>
                  <dd>Aim where the ball should land</dd>
                </div>
                <div className="lp-control">
                  <dt>Left click</dt>
                  <dd>Hit the ball</dd>
                </div>
                <div className="lp-control">
                  <dt>Hold right click</dt>
                  <dd>Charge power, then hit</dd>
                </div>
                <div className="lp-control">
                  <dt>
                    <Kbd>C</Kbd>
                    <Kbd>V</Kbd>
                  </dt>
                  <dd>Switch camera · Umpire on or off</dd>
                </div>
              </dl>
            </div>

            <div className="lp-card lp-scoring">
              <h3 className="lp-h3">Scoring, the real way</h3>
              <ol className="lp-points" aria-label="Points in a game">
                <li>Love</li>
                <li>15</li>
                <li>30</li>
                <li>40</li>
                <li className="is-game">Game</li>
              </ol>
              <p className="lp-body">
                At 40-40 it is deuce. Win the next point for advantage, then one more for the game.
                First to {MATCH.gamesToWin} games wins the match.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-row">
          <span>MAX Tennis · Best on a desktop with a keyboard and mouse.</span>
          <a href="#play" onClick={(e) => goTo(e, 'play')}>
            Back to top
          </a>
        </div>
      </footer>
    </div>
  );
}
