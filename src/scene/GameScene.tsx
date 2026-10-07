/**
 * The render loop: the seam between the simulation and three.js.
 *
 * The single most important rule in this file is that NOTHING here triggers a
 * React re-render per frame. The engine owns a plain mutable snapshot; this
 * component reads it inside `useFrame` and writes straight into THREE objects
 * through refs. React renders the scene graph once; after that, animation is
 * pure mutation. Putting ball position into React state instead would re-render
 * the whole tree 60 times a second and drop the framerate through the floor.
 *
 * The HUD does need to re-render, but only on score and phase changes, which is
 * a few times a minute; that goes through the zustand store, throttled below.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { Court } from './Court';
import { AimMarker, Ball, BallShadow, Player } from './Actors';
import { Engine } from '../game/engine';
import { clampAim } from '../game/simulation';
import type { InputController } from '../game/input';
import { PHYSICS } from '../game/constants';
import { useStore } from '../state/store';
import type { PlayerSide } from '../game/types';

type Props = {
  engine: Engine;
  input: InputController;
  /** Which side this client's camera follows. */
  side: PlayerSide;
};

/**
 * Broadcast camera placement. Kept here rather than inline so the frame loop
 * and the initial camera agree; if they disagree the view lurches on mount.
 */
const CAMERA = {
  /** Sideways offset that turns the end-on corridor into a 3/4 view. */
  sideOffset: 13,
  height: 12,
  /** Distance behind this player's baseline. */
  depth: 18,
  fov: 50,
} as const;

/**
 * Per-mode camera rigs.
 *
 * `fov` is applied to the shared camera each frame rather than at mount, so
 * switching mode mid-rally takes effect immediately.
 *
 * A note on aiming, which constrains these more than looks do: the aim point
 * is the cursor raycast onto the ground plane, so the flatter the camera, the
 * further the aim slides per pixel of mouse movement. Measured over a 5% mouse
 * move, the broadcast rig sweeps about 86m of court depth (coarse but always
 * on court), third person about 0.4m and first person about 0.3m (precise).
 * The closer rigs are therefore better for placement, at the cost of seeing
 * less of the court.
 */
const RIGS = {
  broadcast: {
    fov: 50,
    /** Fixed vantage; does not follow the player's depth. */
    follow: 0.14,
    eyeHeight: CAMERA.height,
    back: CAMERA.depth,
    side: CAMERA.sideOffset,
    lookHeight: 0.6,
    lookAhead: -1.0,
    hideSelf: false,
  },
  third: {
    fov: 62,
    follow: 0.9,
    eyeHeight: 3.4,
    back: 6.2,
    side: 0,
    lookHeight: 1.0,
    lookAhead: 9,
    hideSelf: false,
  },
  first: {
    fov: 72,
    follow: 1,
    eyeHeight: 1.62,
    /*
     * Just behind the player's centre. Sitting exactly on it makes the view
     * pivot around the camera itself, so backing up barely changes the image
     * and depth becomes unreadable; a small offset keeps the motion legible
     * and keeps the racket in frame.
     */
    back: 0.75,
    side: 0,
    lookHeight: 0.72,
    lookAhead: 11,
    /** Your own body would otherwise fill the screen. */
    hideSelf: true,
  },
} as const;

/**
 * Screen height of the horizon, in normalised device coordinates.
 *
 * Anything above this projects into the sky and can never hit the ground
 * plane, so the aim raycast has to be kept below it. Derived from the camera's
 * own orientation, so it stays correct for every rig. The small margin keeps
 * the aim off the horizon itself, where the ray is so near-parallel to the
 * ground that it lands absurdly far away.
 */
function horizonNdcY(camera: THREE.Camera): number {
  scratchHorizon.dir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  // Pitch below horizontal; if the camera looks up, there is no usable ground.
  const pitch = Math.asin(THREE.MathUtils.clamp(-scratchHorizon.dir.y, -1, 1));
  if (!(camera instanceof THREE.PerspectiveCamera)) return 0.9;
  const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  if (pitch <= 0) return -0.15;
  /*
   * Where the horizon falls within the vertical frustum, as -1..1. Looking
   * down puts the horizon ABOVE the centre of the screen, so this is positive.
   * It was once negated, which put the "horizon" at the bottom edge and
   * clamped every pointer position there: the aim froze in one spot whatever
   * the mouse did.
   */
  const y = Math.tan(pitch) / Math.tan(halfFov);
  return THREE.MathUtils.clamp(y - 0.04, -0.98, 0.98);
}

const scratchHorizon = { dir: new THREE.Vector3() };

/** Reusable scratch objects, so the frame loop never allocates. */
const scratch = {
  ray: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
  courtPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
  hit: new THREE.Vector3(),
  desiredCamera: new THREE.Vector3(),
  desiredTarget: new THREE.Vector3(),
  camRight: new THREE.Vector3(),
  camForward: new THREE.Vector3(),
};

export function GameScene({ engine, input, side }: Props) {
  const { camera, gl } = useThree();

  const player0 = useRef<THREE.Group>(null);
  const player1 = useRef<THREE.Group>(null);
  const ball = useRef<THREE.Group>(null);
  const ballShadow = useRef<THREE.Mesh>(null);
  const aim = useRef<THREE.Group>(null);

  const profiles = useStore((s) => s.profiles);
  const syncMatch = useStore((s) => s.syncMatch);
  /*
   * Subscribing here re-renders the scene when the player switches camera,
   * which is exactly once per switch rather than per frame, so it is cheap.
   * The frame loop reads the value through this binding.
   */
  const cameraMode = useStore((s) => s.cameraMode);

  /**
   * Smoothed camera target, so the view glides instead of snapping. It starts
   * where the frame loop will want it rather than at the origin, or the view
   * visibly swings across the court for the first half second after mounting.
   */
  const cameraLook = useMemo(
    () => new THREE.Vector3(0, 0.6, (side === 0 ? -1 : 1) * -1.0),
    [side],
  );
  const pointerRef = useRef({ x: 0, y: 0, inside: false });

  // Track the pointer in normalised device coordinates. We raycast from this
  // each frame onto the court plane to get the aim point in world space.
  useEffect(() => {
    const canvas = gl.domElement;

    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      pointerRef.current.inside = true;
    };
    const onLeave = () => {
      pointerRef.current.inside = false;
    };

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [gl]);

  // Throttle the HUD mirror. The score only changes a handful of times a
  // match, but comparing every frame would still churn the store, so we only
  // look a few times a second.
  const lastSync = useRef(0);

  useFrame((_, delta) => {
    // 1. Aim: project the pointer onto the court plane and hand the world
    // coordinates to the input controller, which folds them into the input.
    if (pointerRef.current.inside) {
      /*
       * A ray aimed above the horizon never meets the ground, so it returns
       * nothing and the aim would silently freeze wherever it last landed.
       * That is rare in the broadcast view but constant in first person, where
       * the camera looks nearly level and the whole upper half of the screen
       * is sky. Clamping the pointer below the horizon keeps aiming continuous
       * instead of sticking, so the marker always tracks the mouse.
       */
      const horizonY = horizonNdcY(camera);
      const clampedY = Math.min(pointerRef.current.y, horizonY);
      scratch.pointer.set(pointerRef.current.x, clampedY);
      scratch.ray.setFromCamera(scratch.pointer, camera);
      if (scratch.ray.ray.intersectPlane(scratch.courtPlane, scratch.hit)) {
        input.setAimPoint(scratch.hit.x, scratch.hit.z);
      }
    }

    // 2. Advance the simulation. The engine runs its own fixed-step clock
    // internally, so a variable frame delta is fine here.
    engine.advance(delta);

    const snapshot = engine.snapshot;

    // 3. Push state into the scene graph.
    const groups: [THREE.Group | null, THREE.Group | null] = [
      player0.current,
      player1.current,
    ];
    for (let i = 0; i < 2; i++) {
      const group = groups[i];
      if (!group) continue;
      const state = snapshot.players[i];
      group.position.set(state.position.x, 0, state.position.z);

      // Swing animation. `swingTimer` counts DOWN from SWING_WINDOW, so it has
      // to be inverted into 0..1 progress; using it raw snaps the racket to
      // the fully wound position and then drifts back, which reads as a flinch
      // rather than a stroke. Rotating on Y sweeps the racket across the body,
      // which is the arc a groundstroke actually follows.
      const racket = group.userData.racket as THREE.Object3D | undefined;
      if (racket) {
        const SWING_WINDOW = 0.22;
        const remaining = Math.max(0, state.swingTimer);
        const progress = 1 - remaining / SWING_WINDOW;
        // Wind back, then whip through: a single smooth arc from -50 to +80
        // degrees over the window, resting at 0 when idle.
        racket.rotation.y =
          remaining > 0 ? (-0.9 + progress * 2.3) : 0;
      }
    }

    if (ball.current) {
      const p = snapshot.ball.position;
      if (engine.role === 'guest' || engine.role === 'spectator') {
        /*
         * A guest's snapshot only updates at the host's 20Hz broadcast rate,
         * so snapping the ball straight to it makes the ball jump three frames
         * at a time and look like it is teleporting or disappearing. Easing
         * toward the authoritative position renders the 60Hz motion between
         * snapshots. The target is still fully authoritative; only the visual
         * catch-up is smoothed.
         */
        const blend = 1 - Math.exp(-28 * delta);
        ball.current.position.x += (p.x - ball.current.position.x) * blend;
        ball.current.position.y += (p.y - ball.current.position.y) * blend;
        ball.current.position.z += (p.z - ball.current.position.z) * blend;
      } else {
        ball.current.position.set(p.x, p.y, p.z);
      }
    }

    // The blob shadow is the main height cue: it sits under the ball and
    // shrinks and fades as the ball rises.
    if (ballShadow.current) {
      const p = snapshot.ball.position;
      // Falloff is tuned to the heights the ball actually reaches: a rally
      // apexes around 3m, so a gentler curve would leave the shadow nearly
      // constant and useless. Depth is already hard to read on this camera, so
      // the shadow has to carry it.
      // Track the RENDERED ball, not the raw snapshot: on a guest the ball is
      // eased between snapshots, and a shadow following the snapshot directly
      // would visibly detach from the ball it belongs to.
      const shown = ball.current?.position;
      const bx = shown ? shown.x : p.x;
      const by = shown ? shown.y : p.y;
      const bz = shown ? shown.z : p.z;
      const height = Math.max(0, by - PHYSICS.ballRadius);
      const scale = THREE.MathUtils.clamp(1 - height / 6, 0.25, 1);
      ballShadow.current.position.set(bx, 0.02, bz);
      ballShadow.current.scale.setScalar(scale);
      const material = ballShadow.current.material as THREE.Material & {
        opacity: number;
      };
      material.opacity = THREE.MathUtils.clamp(0.42 * scale, 0.05, 0.42);
    }

    // The aim marker must show where the ball will ACTUALLY land, which is the
    // clamped target, not the raw cursor position. Drawing the raw aim let the
    // ring sit on your own half or behind your baseline while the shot went
    // somewhere else entirely, so the marker was actively misleading.
    if (aim.current) {
      /*
       * Drawn from the live mouse aim rather than the snapshot. On the host the
       * snapshot's aim trails the mouse by the fairness delay, and on a guest
       * it is overwritten by each host update, so the ring visibly lagged and
       * stuttered behind the cursor. The shot uses the same point once the
       * input is applied. A spectator has no aim of its own, so it keeps the
       * snapshot's.
       */
      const raw =
        engine.role === 'spectator' ? snapshot.players[side].aim : input.getAim();
      const target = clampAim(raw.x, raw.z, side);
      aim.current.position.set(target.x, 0.02, target.z);
      // Hide it when there is no shot to aim: between points and once the
      // match is decided.
      const live =
        snapshot.match.phase === 'rally' || snapshot.match.phase === 'serving';
      aim.current.visible = live;
    }

    /*
     * 4. Camera. Three rigs, chosen by the player; see RIGS above.
     *
     * The broadcast rig is offset to one side because a camera placed directly
     * behind the player looking down the court reads as a narrow corridor: the
     * court is 8.2m wide but 23.8m long, so end-on it covers about 30% of the
     * screen's width against 56% of its height. Viewed diagonally it covers
     * roughly 52x58%, which is why real tennis is televised from that angle.
     *
     * `follow` controls how much the rig tracks the player's own position.
     * Aiming raycasts the cursor onto the ground, so camera motion slides the
     * aim point under a stationary mouse; the broadcast rig therefore stays
     * put (follow 0.14 sideways, none in depth) while the closer rigs must
     * follow the player to be usable at all, and accept that the aim moves
     * with them.
     */
    const self = snapshot.players[side];
    const behind = side === 0 ? -1 : 1;
    const rig = RIGS[cameraMode];

    if (cameraMode === 'broadcast') {
      scratch.desiredCamera.set(
        rig.side + self.position.x * rig.follow,
        rig.eyeHeight,
        behind * rig.back,
      );
      scratch.desiredTarget.set(
        self.position.x * 0.08,
        rig.lookHeight,
        behind * rig.lookAhead,
      );
    } else {
      // Sit behind the player, looking down the court toward the opponent.
      scratch.desiredCamera.set(
        self.position.x * rig.follow,
        rig.eyeHeight,
        self.position.z + behind * rig.back,
      );
      scratch.desiredTarget.set(
        self.position.x * rig.follow * 0.6,
        rig.lookHeight,
        self.position.z - behind * rig.lookAhead,
      );
    }

    if (camera instanceof THREE.PerspectiveCamera && camera.fov !== rig.fov) {
      camera.fov = rig.fov;
      camera.updateProjectionMatrix();
    }

    // Exponential smoothing, framerate independent. The close rigs snap harder
    // so the view does not lag behind the player they are attached to.
    const followRate = cameraMode === 'broadcast' ? 6 : 16;
    const blend = 1 - Math.exp(-followRate * delta);
    camera.position.lerp(scratch.desiredCamera, blend);
    cameraLook.lerp(scratch.desiredTarget, blend);
    camera.lookAt(cameraLook);

    // Hide our own body in first person, or it fills the screen.
    const ownGroup = side === 0 ? player0.current : player1.current;
    if (ownGroup) ownGroup.visible = !rig.hideSelf;

    /*
     * 5. Hand the input controller the camera's basis, flattened onto the
     * ground. With an angled camera the world axes no longer line up with the
     * screen, so WASD has to resolve against what the player actually sees or
     * pressing D sends them diagonally. Doing it here means the controls stay
     * correct automatically if the camera angle is ever retuned.
     */
    scratch.camRight
      .set(1, 0, 0)
      .applyQuaternion(camera.quaternion)
      .setY(0)
      .normalize();
    scratch.camForward
      .set(0, 0, -1)
      .applyQuaternion(camera.quaternion)
      .setY(0)
      .normalize();
    input.setCameraBasis(
      { x: scratch.camRight.x, z: scratch.camRight.z },
      { x: scratch.camForward.x, z: scratch.camForward.z },
    );

    // 5. Mirror the low-frequency match state for the HUD.
    lastSync.current += delta;
    if (lastSync.current >= 0.15) {
      lastSync.current = 0;
      syncMatch({
        scores: snapshot.match.scores,
        phase: snapshot.match.phase,
        server: snapshot.match.server,
        winner: snapshot.match.winner,
      });
    }
  });

  return (
    <>
      <Court />
      <Player ref={player0} color={profiles[0].color} side={0} />
      <Player ref={player1} color={profiles[1].color} side={1} />
      <Ball ref={ball} />
      <BallShadow ref={ballShadow} />
      <AimMarker ref={aim} />
    </>
  );
}

/**
 * Where the camera starts. This must match what the frame loop immediately
 * settles on, or the first frames show a visible lurch into position.
 */
export function initialCameraPosition(side: PlayerSide): [number, number, number] {
  const behind = side === 0 ? -1 : 1;
  return [CAMERA.sideOffset, CAMERA.height, behind * CAMERA.depth];
}

/** Field of view, exported so the Canvas and the frame loop cannot disagree. */
export const CAMERA_FOV = CAMERA.fov;
