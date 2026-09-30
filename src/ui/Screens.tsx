/**
 * Every 2D screen in the game: the menus, the lobby, the in-match HUD and the
 * end cards.
 *
 * These are presentational. They read from the store and call the callbacks the
 * host passes in; none of them start a match, open a peer connection or touch
 * the simulation themselves. That keeps the wiring in one place (App) and lets
 * these render in isolation.
 *
 * The one rule that is easy to break and expensive to debug: the HUD sits on
 * top of the WebGL canvas, so its root must not accept pointer events. Aiming
 * is done by moving the mouse over the canvas, and a full-screen overlay that
 * eats those events makes the game look broken rather than merely ugly. Every
 * interactive control inside the HUD opts back in explicitly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CameraMode, Difficulty, PlayerProfile, PlayerSide } from '../game/types';
import { CAMERA_MODES, CAMERA_MODE_LABELS } from '../game/types';
import { MATCH, SHIRT_COLORS } from '../game/constants';
import { useStore } from '../state/store';
import { inviteUrlFor } from '../net/peer';
import './ui.css';

const DIFFICULTIES: readonly { value: Difficulty; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];

/** A player's name with a sensible stand-in before they have entered one. */
function displayName(profile: PlayerProfile, side: PlayerSide): string {
  const trimmed = profile.name.trim();
  if (trimmed.length > 0) return trimmed;
  return side === 0 ? 'Player 1' : 'Player 2';
}

/**
 * Where an invite link points.
 *
 * This deliberately defers to the network layer rather than formatting the URL
 * here: the joiner parses the query with `roomCodeFromUrl`, so the two have to
 * agree on the parameter name exactly. Duplicating the format in the UI is how
 * you end up shipping invite links that silently never join.
 */
const inviteUrl = inviteUrlFor;

// --- Shared pieces ------------------------------------------------------

function ScreenShell(props: {
  children: React.ReactNode;
  wide?: boolean;
}): React.ReactElement {
  return (
    <div className="screen">
      <div className={props.wide === true ? 'panel panel-wide' : 'panel'}>
        {props.children}
      </div>
    </div>
  );
}

function PlayerChip(props: {
  profile: PlayerProfile;
  side: PlayerSide;
  /** Marks this as the local player, so a lobby of two reads unambiguously. */
  you?: boolean;
}): React.ReactElement {
  return (
    <div className="chip">
      <span
        className="chip-dot"
        style={{ backgroundColor: props.profile.color }}
        aria-hidden="true"
      />
      <span className="chip-name">
        {displayName(props.profile, props.side)}
      </span>
      {props.you === true ? <span className="chip-you">you</span> : null}
    </div>
  );
}

// --- Menu ---------------------------------------------------------------

export function MenuScreen(props: {
  onPlayAi: () => void;
  onHost: () => void;
  onPractice: () => void;
}): React.ReactElement {
  const difficulty = useStore((s) => s.difficulty);
  const setDifficulty = useStore((s) => s.setDifficulty);

  return (
    <ScreenShell wide>
      <header className="brand">
        <h1 className="brand-title">MAX Tennis</h1>
        <p className="brand-sub">Fast arcade tennis in your browser</p>
      </header>

      <div className="menu-actions">
        <section className="menu-card">
          <button type="button" className="btn btn-primary" onClick={props.onPlayAi}>
            Play vs Computer
          </button>
          <div
            className="difficulty"
            role="radiogroup"
            aria-label="Computer difficulty"
          >
            {DIFFICULTIES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={difficulty === option.value}
                className={
                  difficulty === option.value
                    ? 'btn btn-chip btn-chip-on'
                    : 'btn btn-chip'
                }
                onClick={() => setDifficulty(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <section className="menu-card">
          <button type="button" className="btn btn-secondary" onClick={props.onHost}>
            Play with a Friend
          </button>
          <p className="menu-note">
            Creates a room and gives you a link to send them.
          </p>
        </section>

        <section className="menu-card">
          <button type="button" className="btn btn-secondary" onClick={props.onPractice}>
            Practice
          </button>
          <p className="menu-note">Solo rally against a wall; no score.</p>
        </section>
      </div>

      <section className="howto">
        <h2 className="howto-title">How to play</h2>
        <dl className="howto-list">
          <div className="howto-row">
            <dt>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd>
            </dt>
            <dd>Move around the court</dd>
          </div>
          <div className="howto-row">
            <dt>Mouse</dt>
            <dd>Aim where the ball should land</dd>
          </div>
          <div className="howto-row">
            <dt>Left click</dt>
            <dd>Hit the ball</dd>
          </div>
          <div className="howto-row">
            <dt>Hold right click</dt>
            <dd>Charge power, then release to fire</dd>
          </div>
          <div className="howto-row">
            <dt>Scoring</dt>
            <dd>First to {MATCH.pointsToWin}, win by 2</dd>
          </div>
        </dl>
        <p className="howto-tip">
          Do not worry about missing a click; auto-swing covers you if you get
          to the ball in time.
        </p>
      </section>
    </ScreenShell>
  );
}

// --- Profile ------------------------------------------------------------

export function ProfileScreen(props: {
  /** Set when arriving via an invite link; shows "joining <code>". */
  joiningCode: string | null;
  onConfirm: () => void;
  onBack: () => void;
}): React.ReactElement {
  const profile = useStore((s) => s.profile);
  const setProfile = useStore((s) => s.setProfile);
  const connection = useStore((s) => s.connection);
  /*
   * Joining leaves this screen up until the host starts the match, so without
   * feedback the button looks dead and people click it again. Lock it while
   * the connection is being made or is waiting on the host.
   */
  const joining =
    props.joiningCode !== null &&
    (connection === 'connecting' || connection === 'connected');
  const ready = profile.name.trim().length > 0 && !joining;

  const submit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (ready) props.onConfirm();
    },
    [ready, props],
  );

  return (
    <ScreenShell>
      <header className="brand brand-compact">
        <h1 className="brand-title">Who are you?</h1>
        {props.joiningCode !== null ? (
          <p className="brand-sub">
            Joining room <strong className="mono">{props.joiningCode}</strong>
          </p>
        ) : (
          <p className="brand-sub">Pick a name and a shirt.</p>
        )}
      </header>

      <form className="form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Your name</span>
          <input
            className="input"
            type="text"
            value={profile.name}
            maxLength={16}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. Max"
            onChange={(event) => setProfile({ name: event.target.value })}
          />
        </label>

        <fieldset className="field">
          <legend className="field-label">Shirt colour</legend>
          <div className="swatches">
            {SHIRT_COLORS.map((color) => {
              const selected = profile.color === color;
              return (
                <button
                  key={color}
                  type="button"
                  className={selected ? 'swatch swatch-on' : 'swatch'}
                  style={{ backgroundColor: color }}
                  aria-label={`Shirt colour ${color}`}
                  aria-pressed={selected}
                  onClick={() => setProfile({ color })}
                />
              );
            })}
          </div>
        </fieldset>

        <div className="row">
          <button type="button" className="btn btn-ghost" onClick={props.onBack}>
            Back
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready}>
            {props.joiningCode === null
              ? 'Continue'
              : connection === 'connecting'
                ? 'Connecting...'
                : connection === 'connected'
                  ? 'Waiting for host...'
                  : 'Join match'}
          </button>
        </div>
      </form>
    </ScreenShell>
  );
}

// --- Lobby --------------------------------------------------------------

export function LobbyScreen(props: {
  onStart: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const roomCode = useStore((s) => s.roomCode);
  const connection = useStore((s) => s.connection);
  const profiles = useStore((s) => s.profiles);
  const side = useStore((s) => s.side);

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  const url = useMemo(
    () => (roomCode === null ? '' : inviteUrl(roomCode)),
    [roomCode],
  );

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const copy = useCallback(() => {
    if (url === '') return;
    const done = (): void => {
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    };
    // Clipboard access can be refused (insecure origin, denied permission), so
    // fall back to selecting the text and letting the player copy it manually.
    void navigator.clipboard
      ?.writeText(url)
      .then(done)
      .catch(() => {
        const input = document.getElementById('invite-url');
        if (input instanceof HTMLInputElement) input.select();
      });
  }, [url]);

  const opponentReady = connection === 'connected';
  const status =
    connection === 'connected'
      ? 'Your friend is here. Start when you are ready.'
      : connection === 'error'
        ? 'Something went wrong setting up the room.'
        : connection === 'closed'
          ? 'The room closed.'
          : 'Waiting for your friend to join...';

  return (
    <ScreenShell>
      <header className="brand brand-compact">
        <h1 className="brand-title">Your room</h1>
        <p className="brand-sub">Send the link, then start the match.</p>
      </header>

      <div className="code-block">
        <span className="code-label">Room code</span>
        <span className="code-value mono">{roomCode ?? '......'}</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="invite-url">
          Invite link
        </label>
        <div className="copy-row">
          <input
            id="invite-url"
            className="input mono"
            type="text"
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
          />
          <button
            type="button"
            className="btn btn-secondary btn-copy"
            onClick={copy}
            disabled={url === ''}
          >
            {copied ? 'Copied!' : 'Copy link'}
          </button>
        </div>
        <p className="status" role="status">
          {!opponentReady ? <span className="spinner" aria-hidden="true" /> : null}
          {status}
        </p>
      </div>

      <div className="lobby-players">
        <PlayerChip profile={profiles[0]} side={0} you={side === 0} />
        <span className="vs">vs</span>
        {opponentReady ? (
          <PlayerChip profile={profiles[1]} side={1} you={side === 1} />
        ) : (
          <div className="chip chip-empty">
            <span className="chip-name">Empty seat</span>
          </div>
        )}
      </div>

      <div className="row">
        <button type="button" className="btn btn-ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={props.onStart}
          disabled={!opponentReady}
        >
          Start match
        </button>
      </div>
    </ScreenShell>
  );
}

// --- HUD ----------------------------------------------------------------

export function Hud(): React.ReactElement {
  const profiles = useStore((s) => s.profiles);
  const scores = useStore((s) => s.scores);
  const phase = useStore((s) => s.phase);
  const server = useStore((s) => s.server);
  const callout = useStore((s) => s.callout);
  const side = useStore((s) => s.side);
  const mode = useStore((s) => s.mode);
  const connection = useStore((s) => s.connection);
  const latencyMs = useStore((s) => s.latencyMs);

  const networked = mode === 'host' || mode === 'guest' || mode === 'spectator';
  // The store mirrors phase but not the server, so the side that is behind on
  // the clock is not knowable here; "your serve" keys off the local side only
  // while serving, which is the moment the hint is actually useful.
  const serving = phase === 'serving';
  const waiting = connection === 'waiting-for-rejoin';

  return (
    <div className="hud" aria-live="polite">
      <div className="scoreboard">
        <div className="score-side">
          <span
            className="score-dot"
            style={{ backgroundColor: profiles[0].color }}
            aria-hidden="true"
          />
          <span className="score-name">{displayName(profiles[0], 0)}</span>
          <span className="score-value">{scores[0]}</span>
        </div>
        <span className="score-sep" aria-hidden="true">
          :
        </span>
        <div className="score-side score-side-right">
          <span className="score-value">{scores[1]}</span>
          <span className="score-name">{displayName(profiles[1], 1)}</span>
          <span
            className="score-dot"
            style={{ backgroundColor: profiles[1].color }}
            aria-hidden="true"
          />
        </div>
      </div>

      {serving ? (
        <p className="serve-hint">
          {server === side
            ? 'Your serve, click to hit'
            : `${displayName(profiles[server], server)} to serve`}
        </p>
      ) : null}

      <CameraSwitcher />

      {networked ? (
        <div className="net-indicator">
          <span
            className={
              connection === 'connected'
                ? 'net-dot net-dot-ok'
                : 'net-dot net-dot-bad'
            }
            aria-hidden="true"
          />
          <span>{Math.round(latencyMs)} ms</span>
        </div>
      ) : null}

      {callout !== null && callout !== '' ? (
        <div className="callout" key={callout}>
          {callout}
        </div>
      ) : null}

      {waiting ? (
        <div className="hud-blocker">
          <div className="panel panel-tight">
            <span className="spinner spinner-lg" aria-hidden="true" />
            <p className="waiting-text">
              Opponent disconnected, waiting for them to rejoin...
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- Match over ---------------------------------------------------------

export function MatchOverScreen(props: {
  onRematch: () => void;
  onExit: () => void;
}): React.ReactElement {
  const winner = useStore((s) => s.winner);
  const profiles = useStore((s) => s.profiles);
  const scores = useStore((s) => s.scores);
  const side = useStore((s) => s.side);

  const youWon = winner !== null && winner === side;
  const heading =
    winner === null
      ? 'Match over'
      : youWon
        ? 'You win!'
        : `${displayName(profiles[winner], winner)} wins`;

  return (
    <ScreenShell>
      <header className="brand brand-compact">
        <h1 className="brand-title">{heading}</h1>
      </header>

      <div className="final-score">
        <div className="final-side">
          <span
            className="score-dot"
            style={{ backgroundColor: profiles[0].color }}
            aria-hidden="true"
          />
          <span className="final-name">{displayName(profiles[0], 0)}</span>
          <span className="final-value">{scores[0]}</span>
        </div>
        <div className="final-side">
          <span
            className="score-dot"
            style={{ backgroundColor: profiles[1].color }}
            aria-hidden="true"
          />
          <span className="final-name">{displayName(profiles[1], 1)}</span>
          <span className="final-value">{scores[1]}</span>
        </div>
      </div>

      <div className="row">
        <button type="button" className="btn btn-ghost" onClick={props.onExit}>
          Exit to menu
        </button>
        <button type="button" className="btn btn-primary" onClick={props.onRematch}>
          Rematch
        </button>
      </div>
    </ScreenShell>
  );
}

// --- Unsupported --------------------------------------------------------

export function UnsupportedScreen(): React.ReactElement {
  return (
    <ScreenShell>
      <header className="brand brand-compact">
        <h1 className="brand-title">MAX Tennis</h1>
        <p className="brand-sub">Nice to see you; this one needs a desktop.</p>
      </header>
      <p className="body-text">
        The game is played with <strong>WASD</strong> to move and the mouse to
        aim, so it needs a computer with a keyboard and a mouse or trackpad.
      </p>
      <p className="body-text">
        Open this link again on a laptop or desktop and you are good to go.
      </p>
    </ScreenShell>
  );
}


/**
 * Camera picker, shown during a match.
 *
 * Needs `pointer-events: auto` because the HUD root disables them so the
 * mouse can reach the court for aiming.
 */
function CameraSwitcher(): React.ReactElement {
  const cameraMode = useStore((s) => s.cameraMode);
  const setCameraMode = useStore((s) => s.setCameraMode);

  return (
    <div className="camera-switcher" role="radiogroup" aria-label="Camera view">
      {CAMERA_MODES.map((mode: CameraMode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={cameraMode === mode}
          className={cameraMode === mode ? 'cam-btn is-active' : 'cam-btn'}
          onClick={() => setCameraMode(mode)}
        >
          {CAMERA_MODE_LABELS[mode]}
        </button>
      ))}
      <span className="cam-hint">press C</span>
    </div>
  );
}
