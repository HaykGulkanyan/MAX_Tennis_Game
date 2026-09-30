/**
 * Local input capture: keyboard + mouse in, `PlayerInput` out.
 *
 * This module is the only place that knows about the DOM. The simulation is
 * fed plain numbers, so it stays testable and identical on both peers. The
 * controller is deliberately poll-based rather than event-driven downstream:
 * events set flags here, and `sample()` reads those flags once per tick, which
 * is what keeps the guest's input stream aligned with the host's tick rate.
 *
 * Controls:
 *   WASD / arrows  move
 *   mouse          aim (the 3D scene raycasts and calls `setAimPoint`)
 *   left click     hit the ball
 *   hold right     charge power, released at contact
 */

import { SHOT } from './constants';
import type { GameSnapshot, PlayerInput, PlayerSide } from './types';

export type InputController = {
  /** Poll the current input. Satisfies the engine's InputSource signature. */
  sample(snapshot: GameSnapshot, side: PlayerSide): PlayerInput;
  /** Feed the aim point from the 3D raycast each frame (world coords). */
  setAimPoint(x: number, z: number): void;
  /**
   * Feed the camera's right and forward vectors, flattened onto the ground
   * plane, so WASD resolves against what the player actually sees. The scene
   * calls this each frame; without it the controls are only correct for a
   * camera that happens to align with the world axes.
   */
  setCameraBasis(
    right: { x: number; z: number },
    forward: { x: number; z: number },
  ): void;
  /** The latest aim point, for drawing the marker without network delay. */
  getAim(): { x: number; z: number };
  /** Current charge 0..1, for drawing the power bar. */
  getCharge(): number;
  /** True while right mouse is held. */
  isCharging(): boolean;
  attach(target: HTMLElement | Window): void;
  detach(): void;
};

/**
 * Key codes we care about, grouped by intent. `KeyboardEvent.code` is used
 * rather than `.key` so the layout does not matter: on AZERTY or Dvorak the
 * physical WASD cluster still moves the player, which is what people expect
 * from a game.
 */
const MOVE_KEYS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

/** Movement axes in "player-relative" space, before the per-side mapping. */
type Held = { up: boolean; down: boolean; left: boolean; right: boolean };

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Typing a name should not also run the player across the court, so keyboard
 * events originating in a text field are ignored. `isContentEditable` covers
 * rich inputs that are neither <input> nor <textarea>.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (target === null || typeof HTMLElement === 'undefined') return false;
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

export function createInputController(): InputController {
  const held: Held = { up: false, down: false, left: false, right: false };

  let aimX = 0;
  let aimZ = 0;
  let seq = 0;

  /**
   * Click latch. A left click sets this true and only `sample()` clears it,
   * so a click landing between two ticks is still delivered on the next tick
   * (never missed), and a single click can never be consumed twice (never
   * double-fires). Both failure modes are very visible in a tennis game: a
   * dropped click feels like the game ignored you, a doubled one swings twice.
   */
  let shootLatched = false;

  /** Right mouse state and the timestamp it went down, for the charge ramp. */
  let charging = false;
  let chargeStart = 0;

  /**
   * Charge value carried over from the moment of release. The ordering here
   * matters: the player releases right mouse and clicks (or the auto-swing
   * fires) in the same instant, but the release event almost always arrives
   * before the next `sample()`. If release reset the charge to 0 immediately,
   * the shot would always read 0 charge and charging would do nothing at all.
   * So on release we stash the level reached here, `sample()` reports it once,
   * and then clears it. One sample of hold-over, exactly as agreed.
   */
  let releasedCharge = 0;

  /** Ground-plane camera basis, fed by the scene each frame. */
  const cameraBasis = {
    ready: false,
    right: { x: 1, z: 0 },
    forward: { x: 0, z: 1 },
  };

  /** The element listeners are bound to; null while detached. */
  let bound: HTMLElement | Window | null = null;

  /** Live charge from held time, or the stashed release value. */
  function currentCharge(): number {
    if (charging) {
      // Real elapsed time, not tick count, so the ramp is frame-rate
      // independent and matches the power bar the user is watching.
      const elapsed = (nowMs() - chargeStart) / 1000;
      return clamp01(elapsed / SHOT.chargeTime);
    }
    return releasedCharge;
  }

  function nowMs(): number {
    // Guarded so the module is importable in a non-browser context (SSR,
    // unit tests) without throwing at call time.
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  /**
   * Drop every held key and abandon any charge. Called on blur and on
   * visibility change, because the browser stops delivering keyup once the
   * window loses focus: alt-tab while holding W and the key "sticks" down
   * forever, sending the player jogging off on their own until you press and
   * release W again. Clearing on blur is the fix.
   */
  function releaseAll(): void {
    held.up = false;
    held.down = false;
    held.left = false;
    held.right = false;
    charging = false;
    // A charge interrupted by losing focus was not aimed at anything, so it is
    // discarded outright rather than held over for the next sample.
    releasedCharge = 0;
    chargeStart = 0;
  }

  const onKeyDown = (event: Event): void => {
    const ke = event as KeyboardEvent;
    if (isTextEntry(ke.target)) return;
    const action = MOVE_KEYS[ke.code];
    if (action === undefined) return;
    held[action] = true;
  };

  const onKeyUp = (event: Event): void => {
    const ke = event as KeyboardEvent;
    // Deliberately NOT filtered by `isTextEntry`: if a key went down on the
    // canvas and the user focused a field before releasing it, we still want
    // the release, otherwise that key sticks.
    const action = MOVE_KEYS[ke.code];
    if (action === undefined) return;
    held[action] = false;
  };

  const onMouseDown = (event: Event): void => {
    const me = event as MouseEvent;
    if (me.button === 0) {
      shootLatched = true;
    } else if (me.button === 2) {
      // Restart the ramp from zero on every fresh press.
      charging = true;
      chargeStart = nowMs();
      releasedCharge = 0;
    }
  };

  const onMouseUp = (event: Event): void => {
    const me = event as MouseEvent;
    if (me.button !== 2 || !charging) return;
    // Freeze the level reached so the shot taken on this release gets it.
    releasedCharge = currentCharge();
    charging = false;
    chargeStart = 0;
  };

  /**
   * Right click must not open the context menu, or holding to charge pops a
   * menu over the court and swallows the mouseup, which leaves charge stuck on.
   */
  const onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  const onBlur = (): void => {
    releaseAll();
  };

  const onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.hidden) releaseAll();
  };

  function attach(target: HTMLElement | Window): void {
    // Re-attaching without detaching would double every listener, so detach
    // first. Makes `attach` idempotent for React strict-mode double effects.
    if (bound !== null) detach();
    if (typeof window === 'undefined') return;

    bound = target;

    // Keys go on window, not the target: the canvas only receives key events
    // while it holds focus, and the user has no reason to click it first.
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    target.addEventListener('mousedown', onMouseDown);
    target.addEventListener('contextmenu', onContextMenu);
    // Mouseup goes on window so a button released outside the canvas (or
    // outside the window entirely) still ends the charge.
    window.addEventListener('mouseup', onMouseUp);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  }

  function detach(): void {
    if (bound === null) return;
    const target = bound;
    bound = null;

    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mouseup', onMouseUp);
    }

    target.removeEventListener('mousedown', onMouseDown);
    target.removeEventListener('contextmenu', onContextMenu);

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }

    // Leaving the screen mid-hold must not carry state into the next mount.
    releaseAll();
    shootLatched = false;
  }

  function sample(_snapshot: GameSnapshot, side: PlayerSide): PlayerInput {
    seq += 1;

    /*
     * Camera-relative movement.
     *
     * The camera is an angled broadcast view, not an end-on one, so the world
     * axes do not line up with the screen: moving along world +X shifts the
     * player diagonally on screen. Mapping keys to fixed world axes (even with
     * the signs flipped per side) therefore feels wrong in a way no amount of
     * sign-juggling fixes; pressing D has to move the player toward the right
     * of the screen whatever angle the camera sits at.
     *
     * So the basis is taken from the camera itself. `setCameraBasis` is fed
     * the camera's right and forward vectors flattened onto the ground plane,
     * and the keys are resolved against those. This stays correct for both
     * sides and survives any future change to the camera angle, which the
     * previous hardcoded approach did not.
     */
    const rawX = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    const rawZ = (held.up ? 1 : 0) - (held.down ? 1 : 0);

    // Fall back to a sensible end-on basis before the scene has reported one,
    // so the very first frames are not dead.
    const fallbackForward = side === 0 ? 1 : -1;
    const basisRight = cameraBasis.ready
      ? cameraBasis.right
      : { x: side === 0 ? -1 : 1, z: 0 };
    const basisForward = cameraBasis.ready
      ? cameraBasis.forward
      : { x: 0, z: fallbackForward };

    let moveX = rawX * basisRight.x + rawZ * basisForward.x;
    let moveZ = rawX * basisRight.z + rawZ * basisForward.z;

    // Re-normalise: combining two unit vectors can exceed length 1, and the
    // simulation treats magnitude as intent, not just direction.
    const mag = Math.hypot(moveX, moveZ);
    if (mag > 1) {
      moveX /= mag;
      moveZ /= mag;
    }

    /*
     * Charge / shoot ordering, read in this exact sequence:
     *   1. take the charge value (live while held, or the stashed release
     *      level for the one sample after the button came up),
     *   2. take and clear the shoot latch,
     *   3. clear the stashed release level.
     * Because step 3 runs after step 1, the sample that reports the shot also
     * reports the power that was charged for it; the sample after that reads 0.
     */
    const charge = currentCharge();
    const shoot = shootLatched;
    shootLatched = false;
    releasedCharge = 0;

    return { seq, moveX, moveZ, aimX, aimZ, shoot, charge };
  }

  return {
    sample,
    setAimPoint(x: number, z: number): void {
      // Guard against a raycast miss handing us NaN, which would otherwise
      // poison the aim point and travel to the host over the wire.
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      aimX = x;
      aimZ = z;
    },
    setCameraBasis(right, forward): void {
      if (
        !Number.isFinite(right.x) || !Number.isFinite(right.z) ||
        !Number.isFinite(forward.x) || !Number.isFinite(forward.z)
      ) {
        return;
      }
      cameraBasis.right.x = right.x;
      cameraBasis.right.z = right.z;
      cameraBasis.forward.x = forward.x;
      cameraBasis.forward.z = forward.z;
      cameraBasis.ready = true;
    },
    getAim: () => ({ x: aimX, z: aimZ }),
    getCharge: currentCharge,
    isCharging: () => charging,
    attach,
    detach,
  };
}
