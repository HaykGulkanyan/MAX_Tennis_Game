/**
 * The moving objects on the court: the two players, the ball, the aim marker
 * and the ball's drop shadow.
 *
 * ARCHITECTURE: none of these components read game state. They take no
 * position props, they never touch the store, and they render exactly once.
 * The reason is throughput: the simulation runs at 60 Hz, and asking React to
 * reconcile a subtree sixty times a second to move a sphere would burn far
 * more time than the physics itself. Instead every actor forwards a `ref` to
 * its root `THREE.Group`, and the parent mutates `ref.current.position`,
 * `.rotation`, `.scale` and material uniforms directly inside `useFrame`.
 * three.js reads those objects straight off the scene graph, so the mutation
 * is the whole update; React is not involved after mount.
 *
 * Consequence for callers: do NOT try to move these by re-rendering with new
 * props. There are no such props. Hold the refs, drive them per frame.
 */

import { forwardRef, useCallback, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { PHYSICS, PLAYER } from '../game/constants';
import type { PlayerSide } from '../game/types';

/** Neutral skin tone for heads; deliberately not tied to the shirt colour. */
const SKIN_COLOR = '#d9a377';
/** Racket frame; dark so it reads against both shirt colours and the court. */
const RACKET_COLOR = '#22262e';
/** Regulation-ish optic yellow. */
const BALL_COLOR = '#d8f224';

/**
 * Body proportions derived from the gameplay constants, so the avatar always
 * matches the capsule the simulation actually collides with. PLAYER.height is
 * the full standing height and PLAYER.radius the collision radius.
 */
const HEAD_RADIUS = PLAYER.radius * 0.52;
/** Torso occupies everything below the head. */
const TORSO_HEIGHT = PLAYER.height - HEAD_RADIUS * 2;
/** Capsule arg is the cylindrical span, excluding the two hemisphere caps. */
const TORSO_CYLINDER = Math.max(0.05, TORSO_HEIGHT - PLAYER.radius * 2);
const TORSO_CENTER_Y = PLAYER.radius + TORSO_CYLINDER / 2;
const HEAD_CENTER_Y = TORSO_HEIGHT + HEAD_RADIUS;

/** Where the racket pivot sits relative to the body: out to the right, chest high. */
const RACKET_PIVOT: [number, number, number] = [
  PLAYER.radius * 0.95,
  TORSO_HEIGHT * 0.72,
  0,
];
const HANDLE_LENGTH = 0.42;
const RACKET_HEAD_RADIUS = 0.24;

type PlayerProps = {
  /** Shirt colour for this player, from SHIRT_COLORS or a profile. */
  color: string;
  /** 0 defends -Z and so faces +Z; 1 defends +Z and faces -Z. */
  side: PlayerSide;
};

/**
 * A player avatar built from primitives only: a capsule torso, a sphere head
 * and a two-part racket.
 *
 * The forwarded ref points at the root group. The parent sets its `position`
 * each frame from the simulated player state.
 *
 * SWING HANDLE: the racket lives in its own nested group, and that group is
 * published on the root's `userData.racket`. So a parent holding only the root
 * ref can reach the racket without a second ref or a prop:
 *
 *   const racket = playerRef.current.userData.racket as THREE.Group | undefined;
 *   if (racket) racket.rotation.x = -swingPhase * Math.PI;
 *
 * The racket group's own origin is the grip, so rotating it swings the head
 * around the hand, which is what a swing actually looks like. `userData` is a
 * plain mutable field on Object3D, so publishing through it costs nothing and
 * survives for the lifetime of the mounted object.
 */
export const Player = forwardRef<THREE.Group, PlayerProps>(function Player(
  { color, side },
  ref,
) {
  const racketRef = useRef<THREE.Group>(null);

  /**
   * One ref callback that both publishes the racket handle and forwards the
   * root to the parent. Children mount before their parent's ref runs, so
   * `racketRef` is already populated by the time this fires, and the handle is
   * therefore in place before the parent can possibly read it. Doing it here
   * rather than in an effect also means it is set for the very first frame.
   */
  const attachRoot = useCallback(
    (group: THREE.Group | null) => {
      if (group) group.userData.racket = racketRef.current;

      if (typeof ref === 'function') ref(group);
      else if (ref) ref.current = group;
    },
    [ref],
  );

  /**
   * Base yaw so the avatar looks across the net. Side 0 stands at -Z and must
   * look toward +Z, which is a half turn from the default -Z facing; side 1
   * already faces -Z, so it needs no turn.
   */
  const baseYaw = side === 0 ? Math.PI : 0;

  /**
   * Geometries and materials are memoised rather than declared inline, so a
   * re-render (a colour change, a remount by the parent) reuses the same GPU
   * resources instead of allocating a fresh set.
   */
  const shirtMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.04 }),
    [color],
  );
  const skinMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: SKIN_COLOR, roughness: 0.78 }),
    [],
  );
  const racketMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: RACKET_COLOR, roughness: 0.45, metalness: 0.2 }),
    [],
  );
  /** The strings: translucent so the racket face reads as a frame, not a paddle. */
  const stringMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#e8f0f5',
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  return (
    <group ref={attachRoot} rotation={[0, baseYaw, 0]}>
      {/* Torso. Capsule origin is its own centre, so lift it to stand on y=0. */}
      <mesh castShadow position={[0, TORSO_CENTER_Y, 0]} material={shirtMaterial}>
        <capsuleGeometry args={[PLAYER.radius, TORSO_CYLINDER, 4, 12]} />
      </mesh>

      {/* Head. */}
      <mesh castShadow position={[0, HEAD_CENTER_Y, 0]} material={skinMaterial}>
        <sphereGeometry args={[HEAD_RADIUS, 16, 12]} />
      </mesh>

      {/*
        Racket, held out to the player's right. Its group origin is the grip,
        so a rotation here swings the head through an arc around the hand.
      */}
      <group ref={racketRef} position={RACKET_PIVOT} rotation={[0, 0, -0.5]}>
        {/* Handle: a thin cylinder running outward along +X from the grip. */}
        <mesh
          castShadow
          position={[HANDLE_LENGTH / 2, 0, 0]}
          rotation={[0, 0, Math.PI / 2]}
          material={racketMaterial}
        >
          <cylinderGeometry args={[0.028, 0.032, HANDLE_LENGTH, 8]} />
        </mesh>

        {/* Frame: a flat torus standing in the player's sagittal plane. */}
        <mesh
          castShadow
          position={[HANDLE_LENGTH + RACKET_HEAD_RADIUS * 0.9, 0, 0]}
          rotation={[0, Math.PI / 2, 0]}
          material={racketMaterial}
        >
          <torusGeometry args={[RACKET_HEAD_RADIUS, 0.026, 6, 20]} />
        </mesh>

        {/* Strings: a circle filling the frame. No shadow, it is nearly clear. */}
        <mesh
          position={[HANDLE_LENGTH + RACKET_HEAD_RADIUS * 0.9, 0, 0]}
          rotation={[0, Math.PI / 2, 0]}
          material={stringMaterial}
        >
          <circleGeometry args={[RACKET_HEAD_RADIUS, 20]} />
        </mesh>
      </group>
    </group>
  );
});

/**
 * The ball.
 *
 * Low-poly on purpose: it is never more than a few dozen pixels across, it is
 * always moving, and it is the one object guaranteed to be redrawn every
 * single frame. 16x12 segments is already past the point where more detail is
 * visible. The parent sets `ref.current.position` from the simulated ball.
 */
export const Ball = forwardRef<THREE.Group>(function Ball(_props, ref) {
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: BALL_COLOR,
        roughness: 0.85,
        metalness: 0,
        /** A touch of self-lit green keeps it visible against the dark net. */
        emissive: new THREE.Color('#4a6b00'),
        emissiveIntensity: 0.35,
      }),
    [],
  );

  return (
    <group ref={ref}>
      <mesh castShadow material={material}>
        <sphereGeometry args={[PHYSICS.ballRadius, 16, 12]} />
      </mesh>
    </group>
  );
});

/**
 * Ring marker showing where the current player is aiming.
 *
 * Lies flat on the court, so the ring geometry (authored in XY like every
 * other planar geometry in three) is rotated -PI/2 about X. Lifted a few
 * millimetres off the surface and given depthWrite:false so it composites over
 * the court lines instead of fighting them for the depth buffer.
 *
 * The parent moves `ref.current.position` to the aim point; it may also scale
 * the group to pulse the marker with charge level.
 */
export const AimMarker = forwardRef<THREE.Group>(function AimMarker(_props, ref) {
  /** Hot orange: maximum separation from a blue court and a yellow ball. */
  const ringMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#ff8a1f',
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );
  /** A fainter inner disc so the target reads as a spot, not just an outline. */
  const fillMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#ffd07a',
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  return (
    <group ref={ref}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} material={ringMaterial}>
        <ringGeometry args={[0.46, 0.6, 32]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} material={fillMaterial}>
        <circleGeometry args={[0.46, 32]} />
      </mesh>
    </group>
  );
});

/**
 * Soft blob shadow for the ball.
 *
 * In a game where the ball's whole story is told by its height, a real shadow
 * map is too soft and too slow to be the depth cue. This fake one is the cue:
 * the parent parks it directly under the ball each frame and scales it down as
 * the ball climbs, so "small and faint" reads instantly as "high up".
 *
 *   shadowRef.current.position.set(ball.x, 0.008, ball.z);
 *   const s = THREE.MathUtils.clamp(1 - ball.y / 6, 0.25, 1);
 *   shadowRef.current.scale.setScalar(s);
 *   (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = 0.45 * s;
 *
 * The forwarded ref is the `THREE.Mesh` itself, not a wrapper group, so the
 * parent can reach `.material` for that opacity fade without another lookup.
 *
 * The soft edge comes from a tiny radial-gradient canvas baked once at mount:
 * no image file, no network request, and one 64x64 texture for the whole game.
 */
export const BallShadow = forwardRef<THREE.Mesh>(function BallShadow(_props, ref) {
  const material = useMemo(() => {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      const gradient = ctx.createRadialGradient(
        size / 2,
        size / 2,
        0,
        size / 2,
        size / 2,
        size / 2,
      );
      // Opaque core fading to nothing at the rim: a penumbra without a blur pass.
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(0.45, 'rgba(0,0,0,0.78)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Clamped, or the transparent rim wraps and rings the shadow.
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;

    return new THREE.MeshBasicMaterial({
      map: texture,
      color: '#0b1c2a',
      transparent: true,
      opacity: 0.45,
      // Never occlude the court or the ball; it is a decal, not geometry.
      depthWrite: false,
      toneMapped: false,
    });
  }, []);

  return (
    /*
      planeGeometry is authored in XY, so lay it flat with -PI/2 about X. The
      8 mm lift clears the court surface and stops the two coplanar polygons
      from z-fighting.
    */
    <mesh
      ref={ref}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.008, 0]}
      material={material}
      renderOrder={1}
    >
      <planeGeometry args={[PHYSICS.ballRadius * 6, PHYSICS.ballRadius * 6]} />
    </mesh>
  );
});
