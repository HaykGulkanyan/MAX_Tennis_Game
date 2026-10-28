/**
 * The venue vote, shown before every match.
 *
 * Three cards, each with a small drawn scene. Against the computer or in
 * practice it is a plain choice. Online, both players vote while a countdown
 * runs; each card shows who voted for it, and the result is announced before
 * the match starts. The host settles the vote (see App.tsx); this screen only
 * shows the state and reports this player's pick.
 */

import { useEffect, useState } from 'react';
import type React from 'react';

import { VENUES, VENUE_INFO } from '../game/venues';
import type { Venue } from '../game/venues';
import type { PlayerProfile } from '../game/types';
import { useStore } from '../state/store';
import { ScreenShell } from './Screens';

/* ------------------------------------------------------------------ *
 * Illustrations: tiny inline SVG scenes, one per venue.
 * ------------------------------------------------------------------ */

function BeachArt(): React.ReactElement {
  return (
    <svg viewBox="0 0 160 90" aria-hidden="true">
      <defs>
        <linearGradient id="sky-beach" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b8fe0" />
          <stop offset="1" stopColor="#cde8f6" />
        </linearGradient>
      </defs>
      <rect width="160" height="90" fill="url(#sky-beach)" />
      <circle cx="122" cy="20" r="9" fill="#ffe08a" />
      <rect y="40" width="160" height="14" fill="#1f8fc9" />
      <rect y="52" width="160" height="3" fill="#e9f6fb" />
      <rect y="55" width="160" height="35" fill="#e6cf98" />
      <polygon points="42,88 118,88 104,62 56,62" fill="#c8643b" />
      <polygon points="80,62 80,88" stroke="#f7efe3" strokeWidth="1.2" />
      <path d="M26 82 Q28 60 36 44" stroke="#8a6a45" strokeWidth="3.2" fill="none" />
      <path d="M36 44 q-14 -2 -20 8 M36 44 q-10 -10 -22 -6 M36 44 q4 -12 16 -10 M36 44 q14 -2 18 10" stroke="#2f8f3e" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function ParisArt(): React.ReactElement {
  return (
    <svg viewBox="0 0 160 90" aria-hidden="true">
      <defs>
        <linearGradient id="sky-paris" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6b98d6" />
          <stop offset="1" stopColor="#f2d9b8" />
        </linearGradient>
      </defs>
      <rect width="160" height="90" fill="url(#sky-paris)" />
      {/* Rooftops. */}
      <path d="M0 56 h18 v-8 h14 v6 h16 v-9 h12 v11 H100 v-7 h16 v5 h14 v-8 h16 v8 h14 v20 H0 z" fill="#c9bba2" />
      {/* The tower. */}
      <path d="M78 6 L80 6 L82 22 L86 40 L92 56 L86 56 Q79 46 72 56 L66 56 L72 40 L76 22 z" fill="#6f5a46" />
      <rect x="71" y="38" width="16" height="3" fill="#6f5a46" />
      <rect x="74.5" y="22" width="9" height="2" fill="#6f5a46" />
      <rect y="62" width="160" height="28" fill="#557f3e" />
      <polygon points="42,88 118,88 104,64 56,64" fill="#4f9b45" />
      <polygon points="45,82 115,82 111,76 49,76" fill="#5cab50" />
      <polygon points="51,72 109,72 106,67 54,67" fill="#5cab50" />
      <polygon points="80,64 80,88" stroke="#ffffff" strokeWidth="1.2" />
    </svg>
  );
}

function SydneyArt(): React.ReactElement {
  return (
    <svg viewBox="0 0 160 90" aria-hidden="true">
      <defs>
        <linearGradient id="sky-sydney" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2f80d8" />
          <stop offset="1" stopColor="#c4e2f6" />
        </linearGradient>
      </defs>
      <rect width="160" height="90" fill="url(#sky-sydney)" />
      {/* The bridge. */}
      <path d="M96 44 Q124 14 152 44" stroke="#76808b" strokeWidth="3" fill="none" />
      <rect x="92" y="42" width="64" height="2.5" fill="#5e6872" />
      <rect y="44" width="160" height="16" fill="#1d6aa3" />
      {/* The Opera House sails. */}
      <rect x="18" y="42" width="58" height="5" fill="#c9a88a" />
      <path d="M22 42 Q30 22 40 42 z M34 42 Q44 18 54 42 z M48 42 Q58 24 66 42 z M58 42 Q66 30 74 42 z" fill="#f4f1e8" stroke="#d9d4c7" strokeWidth="0.6" />
      <rect y="60" width="160" height="30" fill="#8b949c" />
      <polygon points="42,88 118,88 104,64 56,64" fill="#2f8ade" />
      <polygon points="50,84 110,84 101,67 59,67" fill="#1f6ec7" />
      <polygon points="80,67 80,84" stroke="#ffffff" strokeWidth="1.2" />
    </svg>
  );
}

const ART: Record<Venue, () => React.ReactElement> = {
  beach: BeachArt,
  paris: ParisArt,
  sydney: SydneyArt,
};

/* ------------------------------------------------------------------ *
 * Screen
 * ------------------------------------------------------------------ */

function useSecondsLeft(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [deadline]);
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

function Voter({ profile, fallback }: { profile: PlayerProfile; fallback: string }): React.ReactElement {
  return (
    <span className="voter">
      <span className="chip-dot" style={{ backgroundColor: profile.color }} aria-hidden="true" />
      {profile.name.trim() || fallback}
    </span>
  );
}

export function VoteScreen(props: { onVote: (venue: Venue) => void; onLeave: () => void }): React.ReactElement {
  const vote = useStore((s) => s.vote);
  const profiles = useStore((s) => s.profiles);
  const profile = useStore((s) => s.profile);
  const side = useStore((s) => s.side);
  const secondsLeft = useSecondsLeft(vote.result ? null : vote.deadline);

  const online = vote.mode === 'online';
  const myVote = online ? vote.votes[side] : vote.votes[0];
  const split = online && vote.votes[0] !== null && vote.votes[1] !== null && vote.votes[0] !== vote.votes[1];

  let status: string;
  if (vote.result) {
    status = split
      ? `Votes were split, so a coin flip picked ${VENUE_INFO[vote.result].name}!`
      : `${VENUE_INFO[vote.result].name} it is!`;
  } else if (!online) {
    status = 'Pick where to play.';
  } else if (myVote) {
    status = 'Waiting for the other vote...';
  } else {
    status = 'Vote for where to play.';
  }

  return (
    <ScreenShell wide>
      <header className="brand brand-compact">
        <h1 className="brand-title">Choose the venue</h1>
        <p className="brand-sub" role="status">
          {status}
          {online && secondsLeft !== null ? (
            <span className="vote-timer"> {secondsLeft}s</span>
          ) : null}
        </p>
      </header>

      <div className="venues">
        {VENUES.map((venue) => {
          const info = VENUE_INFO[venue];
          const Art = ART[venue];
          const chosen = vote.result === venue;
          const faded = vote.result !== null && !chosen;
          const mine = myVote === venue;
          return (
            <button
              key={venue}
              type="button"
              className={['venue', mine ? 'is-mine' : '', chosen ? 'is-chosen' : '', faded ? 'is-faded' : '']
                .filter(Boolean)
                .join(' ')}
              aria-pressed={mine}
              disabled={vote.result !== null}
              onClick={() => props.onVote(venue)}
            >
              <span className="venue-art">
                <Art />
              </span>
              <span className="venue-name">{info.name}</span>
              <span className="venue-surface">{info.surface}</span>
              <span className="venue-blurb">{info.blurb}</span>
              <span className="venue-voters">
                {online ? (
                  <>
                    {vote.votes[0] === venue ? <Voter profile={profiles[0]} fallback="Player 1" /> : null}
                    {vote.votes[1] === venue ? <Voter profile={profiles[1]} fallback="Player 2" /> : null}
                  </>
                ) : mine ? (
                  <Voter profile={profile} fallback="You" />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      <div className="row">
        <button type="button" className="btn btn-ghost" onClick={props.onLeave}>
          {online ? 'Leave room' : 'Back to menu'}
        </button>
      </div>
    </ScreenShell>
  );
}
