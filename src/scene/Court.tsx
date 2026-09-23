/**
 * Static court scenery: surface, painted lines, net, surrounding stadium shell
 * and the lights that everything else in the scene is lit by.
 *
 * Purely presentational. No state, no store access, no props, so React never
 * re-renders it after mount and three.js can treat every mesh here as static.
 *
 * World axes: X = sideline to sideline, Y = up, Z = baseline to baseline. The
 * net sits at Z = 0; side 0 defends -Z and side 1 defends +Z.
 */

/*
 * Loads the @react-three/fiber module augmentation that registers the three.js
 * elements (mesh, boxGeometry, ...) on JSX.IntrinsicElements. A triple-slash
 * reference rather than an import because nothing here needs a binding from
 * the module, and an unused import would trip `noUnusedLocals`.
 */
/// <reference types="@react-three/fiber" />

import type React from 'react'
import type * as THREE from 'three'

import { COURT } from '../game/constants'

/* ------------------------------------------------------------------ *
 * Derived geometry
 * ------------------------------------------------------------------ */

/** Full playfield extent: the lines plus the runoff players may chase into. */
const FIELD_HALF_X = COURT.halfWidth + COURT.runoffX
const FIELD_HALF_Z = COURT.halfLength + COURT.runoffZ

/**
 * Lines are drawn as flat boxes floating just above the surface rather than
 * being part of it. On a plane this large, coplanar geometry z-fights badly at
 * distance because the depth buffer loses precision, so we lift the paint by a
 * visible-to-the-depth-buffer but not-to-the-eye amount and additionally bias
 * it with polygonOffset. Either alone is flaky at grazing camera angles; both
 * together are stable.
 */
const LINE_Y = 0.01
/** Paint is 2mm thick so the box has real volume and no degenerate normals. */
const LINE_THICKNESS = 0.002
const HALF_LINE = COURT.lineWidth / 2

/** Baseline centre marks, as on a real court: short stubs on the centre line. */
const CENTRE_MARK_LENGTH = 0.3

/** Posts stand just outside the sidelines, as on a real court. */
const POST_X = COURT.halfWidth + 0.4
const POST_RADIUS = 0.055
/** Posts rise slightly above the net so the cord reads as hanging from them. */
const POST_HEIGHT = COURT.netHeight + 0.07

/** Width of the white band capping the top of the net. */
const NET_BAND_HEIGHT = 0.06
/** The mesh panel stops where the band begins so the two do not overlap. */
const NET_MESH_HEIGHT = COURT.netHeight - NET_BAND_HEIGHT
/** Net spans post to post, a little wider than the court itself. */
const NET_HALF_WIDTH = POST_X

/** The surrounding stand sits just beyond the runoff. */
const WALL_HALF_X = FIELD_HALF_X + 1.6
const WALL_HALF_Z = FIELD_HALF_Z + 1.6
const WALL_HEIGHT = 2.6
const WALL_THICKNESS = 0.5

/**
 * Directional light shadow bounds. An orthographic shadow camera spreads its
 * fixed-resolution shadow map over whatever area it covers, so we size it to
 * just contain the playfield (plus a small margin for players and the ball
 * arcing overhead). Making it larger would blur every shadow for no gain; the
 * ball's shadow is the main depth cue for judging where a lob will land, so it
 * needs the texels.
 */
const SHADOW_EXTENT = Math.max(FIELD_HALF_X, FIELD_HALF_Z) + 2

/** Light direction. Offset on X and Z so shadows fall diagonally, not flat. */
const SUN_POSITION: readonly [number, number, number] = [14, 22, 10]

/* ------------------------------------------------------------------ *
 * Palette: clean stylized, flat pleasant colours rather than photoreal.
 * ------------------------------------------------------------------ */

/*
 * Hard-court palette, modelled on a real blue/green stadium court.
 *
 * The in-bounds area is deliberately a different hue from the runoff, not just
 * a darker shade of it: on a real court that contrast is the main thing that
 * makes the playing area legible at a glance, and without it the whole surface
 * reads as one flat slab. Everything is also much lighter than a "dark theme"
 * instinct suggests, because the court is lit daylight and a dim court just
 * looks like an unfinished render.
 */
const COLORS = {
  court: '#2d7dd2',
  runoff: '#3a9e78',
  ground: '#2b6b52',
  line: '#ffffff',
  netMesh: '#1b2733',
  netBand: '#f4f7fa',
  post: '#3e4a56',
  wall: '#1f3446',
  wallCap: '#2c4a63',
} as const

/**
 * Freeze a static object's transform.
 *
 * Nothing in the court ever moves, so recomputing its matrix every frame is
 * waste. But setting `matrixAutoUpdate={false}` as a JSX prop is a trap:
 * three.js then never builds the matrix from `position`/`rotation` AT ALL, so
 * the declared transform is silently discarded and the object renders
 * unrotated at the origin. That is what turned this court into vertical
 * planks floating in the void.
 *
 * Doing it through a ref callback computes the matrix once from the props
 * React has already applied, and only then stops further updates, so the
 * optimisation keeps the transform instead of dropping it.
 */
function freezeTransform(object: THREE.Object3D | null): void {
  if (!object) return
  object.updateMatrix()
  object.matrixAutoUpdate = false
}

/* ------------------------------------------------------------------ *
 * Line helper
 * ------------------------------------------------------------------ */

type LineProps = {
  /** Centre of the stripe, in world XZ. */
  readonly position: readonly [number, number]
  /** Size on X and Z. */
  readonly size: readonly [number, number]
}

/**
 * One painted stripe. Every stripe shares the same unit box geometry via
 * `scale`, so the whole set of lines costs one geometry upload instead of a
 * dozen; three.js reuses the cached buffer for each mesh.
 */
function Line({ position, size }: LineProps) {
  return (
    <mesh
      position={[position[0], LINE_Y, position[1]]}
      scale={[size[0], LINE_THICKNESS, size[1]]}
      ref={freezeTransform}
      receiveShadow
    >
      <boxGeometry args={[1, 1, 1]} />
      {/*
        polygonOffset pushes the rasterised depth of the paint toward the
        camera, which stops the surface below from punching through when the
        camera is nearly edge-on to the court.
      */}
      <meshStandardMaterial
        color={COLORS.line}
        roughness={0.85}
        metalness={0}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  )
}

/* ------------------------------------------------------------------ *
 * Court
 * ------------------------------------------------------------------ */

export function Court(): React.ReactElement {
  return (
    <group>
      {/* ---------- Lighting ---------- */}

      {/*
        Ambient keeps shadowed faces readable; the directional light does the
        actual shaping. Kept fairly high because a fully dark shadow side makes
        the stylized flat colours look muddy.
      */}
      <ambientLight intensity={0.55} color="#cfe3f2" />

      <directionalLight
        position={[...SUN_POSITION]}
        intensity={2.1}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        shadow-camera-near={1}
        shadow-camera-far={60}
        /*
          Small bias values fight shadow acne on the big flat court without
          detaching the ball's shadow from the ball, which would break the
          depth cue players use to read a bounce. normalBias handles the
          curved player and ball meshes; bias handles the flat surface.
        */
        shadow-bias={-0.0005}
        shadow-normalBias={0.02}
      />

      {/* ---------- Court surface ---------- */}

      {/*
        planeGeometry is authored in XY, so it needs rotating onto the XZ
        ground plane. It covers the full playfield including the runoff.
      */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, 0]}
        receiveShadow
        ref={freezeTransform}
      >
        <planeGeometry args={[FIELD_HALF_X * 2, FIELD_HALF_Z * 2]} />
        <meshStandardMaterial
          color={COLORS.runoff}
          roughness={0.95}
          metalness={0}
        />
      </mesh>

      {/*
        The in-bounds area in a lighter blue, lifted a hair above the runoff so
        the two coplanar planes cannot z-fight with each other.
      */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.004, 0]}
        receiveShadow
        ref={freezeTransform}
      >
        <planeGeometry args={[COURT.halfWidth * 2, COURT.halfLength * 2]} />
        <meshStandardMaterial
          color={COLORS.court}
          roughness={0.95}
          metalness={0}
        />
      </mesh>

      {/* ---------- Painted lines ---------- */}

      {/* Sidelines: full length of the court, one per side. */}
      <Line
        position={[-COURT.halfWidth + HALF_LINE, 0]}
        size={[COURT.lineWidth, COURT.halfLength * 2]}
      />
      <Line
        position={[COURT.halfWidth - HALF_LINE, 0]}
        size={[COURT.lineWidth, COURT.halfLength * 2]}
      />

      {/* Baselines: across the full width at each end. */}
      <Line
        position={[0, -COURT.halfLength + HALF_LINE]}
        size={[COURT.halfWidth * 2, COURT.lineWidth]}
      />
      <Line
        position={[0, COURT.halfLength - HALF_LINE]}
        size={[COURT.halfWidth * 2, COURT.lineWidth]}
      />

      {/* Service lines, one either side of the net. */}
      <Line
        position={[0, -COURT.serviceLine]}
        size={[COURT.halfWidth * 2, COURT.lineWidth]}
      />
      <Line
        position={[0, COURT.serviceLine]}
        size={[COURT.halfWidth * 2, COURT.lineWidth]}
      />

      {/* Centre service line: runs service line to service line through Z = 0. */}
      <Line
        position={[0, 0]}
        size={[COURT.lineWidth, COURT.serviceLine * 2]}
      />

      {/* Centre marks: short stubs on each baseline, pointing into the court. */}
      <Line
        position={[0, -COURT.halfLength + CENTRE_MARK_LENGTH / 2]}
        size={[COURT.lineWidth, CENTRE_MARK_LENGTH]}
      />
      <Line
        position={[0, COURT.halfLength - CENTRE_MARK_LENGTH / 2]}
        size={[COURT.lineWidth, CENTRE_MARK_LENGTH]}
      />

      {/* ---------- Net ---------- */}

      <group position={[0, 0, 0]}>
        {/*
          The mesh panel. A real net is see-through, and an opaque wall at the
          centre of the court would hide the far player's feet, so this is a
          semi-transparent dark panel. depthWrite is off so transparent pixels
          do not occlude whatever is drawn behind them in an arbitrary order.
        */}
        <mesh
          position={[0, NET_MESH_HEIGHT / 2, 0]}
          ref={freezeTransform}
        >
          <boxGeometry args={[NET_HALF_WIDTH * 2, NET_MESH_HEIGHT, 0.02]} />
          <meshStandardMaterial
            color={COLORS.netMesh}
            roughness={0.9}
            metalness={0}
            transparent
            opacity={0.55}
            depthWrite={false}
          />
        </mesh>

        {/* White band capping the top edge, the thing that reads as "net". */}
        <mesh
          position={[0, NET_MESH_HEIGHT + NET_BAND_HEIGHT / 2, 0]}
          castShadow
          ref={freezeTransform}
        >
          <boxGeometry args={[NET_HALF_WIDTH * 2, NET_BAND_HEIGHT, 0.035]} />
          <meshStandardMaterial
            color={COLORS.netBand}
            roughness={0.7}
            metalness={0}
          />
        </mesh>

        {/* Posts, just outside each sideline. */}
        <mesh
          position={[-POST_X, POST_HEIGHT / 2, 0]}
          castShadow
          receiveShadow
          ref={freezeTransform}
        >
          <cylinderGeometry args={[POST_RADIUS, POST_RADIUS, POST_HEIGHT, 10]} />
          <meshStandardMaterial
            color={COLORS.post}
            roughness={0.5}
            metalness={0.3}
          />
        </mesh>
        <mesh
          position={[POST_X, POST_HEIGHT / 2, 0]}
          castShadow
          receiveShadow
          ref={freezeTransform}
        >
          <cylinderGeometry args={[POST_RADIUS, POST_RADIUS, POST_HEIGHT, 10]} />
          <meshStandardMaterial
            color={COLORS.post}
            roughness={0.5}
            metalness={0.3}
          />
        </mesh>
      </group>

      {/* ---------- Surroundings ---------- */}

      {/*
        A large darker ground plane under everything, so the court reads as
        sitting inside a venue rather than floating in the void. Dropped below
        the court surface to keep the two from z-fighting.
      */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.05, 0]}
        receiveShadow
        ref={freezeTransform}
      >
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial
          color={COLORS.ground}
          roughness={1}
          metalness={0}
        />
      </mesh>

      {/*
        Four low walls forming the stand. Boxes rather than a hollow extrusion:
        the inner faces are all the camera ever sees, and four boxes is cheaper
        than any lathe or shape geometry would be.
      */}
      {[
        // [x, z, sizeX, sizeZ]
        [0, -WALL_HALF_Z, WALL_HALF_X * 2, WALL_THICKNESS],
        [0, WALL_HALF_Z, WALL_HALF_X * 2, WALL_THICKNESS],
        [-WALL_HALF_X, 0, WALL_THICKNESS, WALL_HALF_Z * 2],
        [WALL_HALF_X, 0, WALL_THICKNESS, WALL_HALF_Z * 2],
      ].map(([x, z, sx, sz], index) => (
        <mesh
          key={index}
          position={[x, WALL_HEIGHT / 2, z]}
          castShadow
          receiveShadow
          ref={freezeTransform}
        >
          <boxGeometry args={[sx, WALL_HEIGHT, sz]} />
          <meshStandardMaterial
            color={index < 2 ? COLORS.wall : COLORS.wallCap}
            roughness={0.9}
            metalness={0}
          />
        </mesh>
      ))}
    </group>
  )
}
