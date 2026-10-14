/**
 * The stadium around the court: tiered stands on all four sides, a crowd,
 * floodlight towers and an umpire's chair.
 *
 * Purely decorative and fully static, like the court itself. Nothing here
 * takes part in the simulation; the ball never collides with any of it.
 *
 * Two constraints shaped the layout:
 *
 *  - Cameras. The broadcast camera sits at x = 13, 12m up, which is above the
 *    side stands, and its sight line to the near corner clears them by metres.
 *    The third-person camera trails up to 6.2m behind a player standing at the
 *    very back of the runoff. The end boards (and so the end stands behind
 *    them) are placed beyond that point by `Court.tsx`, so that camera never
 *    ends up behind the boards or inside the seating.
 *  - Cost. ~1,500 spectators would be ~3,000 meshes drawn one by one. They are
 *    two InstancedMeshes instead (bodies and heads), so the whole crowd is two
 *    draw calls.
 */

/// <reference types="@react-three/fiber" />

import { useLayoutEffect, useMemo, useRef } from 'react'
import type React from 'react'
import * as THREE from 'three'

import { COURT } from '../game/constants'

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

type Props = {
  /** Inner half-extents of the perimeter boards, from the court. */
  readonly wallHalfX: number
  readonly wallHalfZ: number
}

/** Rows of seating in each stand. */
const ROWS = 8
/** Depth of one row, front to back. */
const ROW_DEPTH = 0.9
/** How much higher each row sits than the one in front of it. */
const ROW_RISE = 0.45
/** Height of the front row's step above the ground. */
const FRONT_STEP = 0.5
/** Walkway between the boards and the first row of the side stands. */
const SIDE_GAP = 1.0
/** Walkway behind the end boards (the boards themselves already sit far back). */
const END_GAP = 1.0
/** Spacing between spectators along a row. */
const SEAT_PITCH = 0.75
/** Share of seats that are filled. */
const OCCUPANCY = 0.86

const COLORS = {
  stepA: '#34465c',
  stepB: '#2a3a4e',
  skin: ['#f1c9a5', '#d9a77e', '#b07a52', '#8a5a3b', '#5e3d29'],
  /** Bright, varied shirts so the crowd reads as people, not texture. */
  shirts: [
    '#e8503a', '#2f7fe8', '#37b46b', '#f0b429', '#9b5de5', '#16b3ac',
    '#f4f7fa', '#ff8a1f', '#d6336c', '#1f2937', '#c8f24a', '#4dabf7',
  ],
  pole: '#5b6878',
  lampHousing: '#2a323c',
  lamp: '#fff6d8',
  chair: '#2a5d8f',
  umpireShirt: '#f4f7fa',
} as const

/**
 * Seeded PRNG (mulberry32) so the crowd is identical on every load and on
 * both players' screens, instead of reshuffling each time the scene mounts.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Same trick as the court: compute a static matrix once, then stop updating. */
function freezeTransform(object: THREE.Object3D | null): void {
  if (!object) return
  object.updateMatrix()
  object.matrixAutoUpdate = false
}

/** One step of a stand: a solid block from the ground up to the seat level. */
type Step = {
  position: [number, number, number]
  size: [number, number, number]
  color: string
}

/** A spectator's seat: where they sit, and along which axis the row runs. */
type Seat = { x: number; y: number; z: number }

/**
 * Build the stepped stands and the seats on them.
 *
 * Side stands run along X = +/-, end stands along Z = +/-. Each end row is
 * widened in step with the side rows, so the four stands meet at the corners
 * as a stepped bowl instead of leaving open gaps.
 */
function buildStands(wallHalfX: number, wallHalfZ: number) {
  const sideStart = wallHalfX + SIDE_GAP
  const endStart = wallHalfZ + END_GAP
  const steps: Step[] = []
  const seats: Seat[] = []

  for (let row = 0; row < ROWS; row++) {
    const top = FRONT_STEP + row * ROW_RISE
    const color = row % 2 === 0 ? COLORS.stepA : COLORS.stepB
    const near = row * ROW_DEPTH
    const mid = near + ROW_DEPTH / 2

    // Side stands (+X and -X): span the length between the end stands.
    for (const sign of [-1, 1]) {
      steps.push({
        position: [sign * (sideStart + mid), top / 2, 0],
        size: [ROW_DEPTH, top, endStart * 2],
        color,
      })
      for (let z = -endStart + SEAT_PITCH / 2; z < endStart; z += SEAT_PITCH) {
        seats.push({ x: sign * (sideStart + mid + 0.1), y: top, z })
      }
    }

    // End stands (+Z and -Z): widen with each row to close the corners.
    const halfWidth = sideStart + near + ROW_DEPTH
    for (const sign of [-1, 1]) {
      steps.push({
        position: [0, top / 2, sign * (endStart + mid)],
        size: [halfWidth * 2, top, ROW_DEPTH],
        color,
      })
      for (let x = -halfWidth + SEAT_PITCH / 2; x < halfWidth; x += SEAT_PITCH) {
        seats.push({ x, y: top, z: sign * (endStart + mid + 0.1) })
      }
    }
  }

  const outerX = sideStart + ROWS * ROW_DEPTH
  const outerZ = endStart + ROWS * ROW_DEPTH
  return { steps, seats, outerX, outerZ }
}

/* ------------------------------------------------------------------ *
 * Crowd
 * ------------------------------------------------------------------ */

/** Body: a capsule. Head: a sphere. Shared by every spectator. */
const BODY_RADIUS = 0.22
const BODY_LENGTH = 0.42
const HEAD_RADIUS = 0.15

function Crowd({ seats }: { seats: Seat[] }): React.ReactElement {
  const bodies = useRef<THREE.InstancedMesh>(null)
  const heads = useRef<THREE.InstancedMesh>(null)

  // Decide who is in which seat once, from the fixed seed.
  const people = useMemo(() => {
    const random = seededRandom(20261014)
    return seats
      .filter(() => random() < OCCUPANCY)
      .map((seat) => ({
        ...seat,
        // A little jitter so rows do not look machine-placed.
        jitterX: (random() - 0.5) * 0.12,
        jitterZ: (random() - 0.5) * 0.12,
        scale: 0.9 + random() * 0.2,
        shirt: COLORS.shirts[Math.floor(random() * COLORS.shirts.length)],
        skin: COLORS.skin[Math.floor(random() * COLORS.skin.length)],
      }))
  }, [seats])

  useLayoutEffect(() => {
    const body = bodies.current
    const head = heads.current
    if (!body || !head) return

    const matrix = new THREE.Matrix4()
    const color = new THREE.Color()
    const bodyHalf = BODY_RADIUS + BODY_LENGTH / 2

    people.forEach((person, i) => {
      const x = person.x + person.jitterX
      const z = person.z + person.jitterZ
      const s = person.scale

      matrix.makeScale(s, s, s).setPosition(x, person.y + bodyHalf * s, z)
      body.setMatrixAt(i, matrix)
      body.setColorAt(i, color.set(person.shirt))

      matrix
        .makeScale(s, s, s)
        .setPosition(x, person.y + (bodyHalf * 2 + HEAD_RADIUS * 0.8) * s, z)
      head.setMatrixAt(i, matrix)
      head.setColorAt(i, color.set(person.skin))
    })

    for (const mesh of [body, head]) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }, [people])

  /*
   * frustumCulled is off because an InstancedMesh is culled by its base
   * geometry's bounds, which sit at the origin; the crowd surrounds the court,
   * so culling by those bounds could drop the whole crowd from view at once.
   */
  return (
    <>
      <instancedMesh
        ref={bodies}
        args={[undefined, undefined, people.length]}
        frustumCulled={false}
      >
        <capsuleGeometry args={[BODY_RADIUS, BODY_LENGTH, 3, 8]} />
        <meshStandardMaterial roughness={0.9} metalness={0} />
      </instancedMesh>
      <instancedMesh
        ref={heads}
        args={[undefined, undefined, people.length]}
        frustumCulled={false}
      >
        <sphereGeometry args={[HEAD_RADIUS, 10, 8]} />
        <meshStandardMaterial roughness={0.8} metalness={0} />
      </instancedMesh>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Floodlights and umpire
 * ------------------------------------------------------------------ */

const POLE_HEIGHT = 17
const LAMP_SIZE: [number, number, number] = [3.2, 1.6, 0.4]

function Floodlight({ x, z }: { x: number; z: number }): React.ReactElement {
  // Turn the lamp bank to face the centre of the court.
  const yaw = Math.atan2(-x, -z)
  return (
    <group position={[x, 0, z]} rotation={[0, yaw, 0]} ref={freezeTransform}>
      <mesh position={[0, POLE_HEIGHT / 2, 0]} ref={freezeTransform}>
        <cylinderGeometry args={[0.18, 0.3, POLE_HEIGHT, 10]} />
        <meshStandardMaterial color={COLORS.pole} roughness={0.6} metalness={0.4} />
      </mesh>
      {/* Tilted down toward the court, as real stadium lights are. */}
      <group position={[0, POLE_HEIGHT, 0.3]} rotation={[0.45, 0, 0]} ref={freezeTransform}>
        <mesh ref={freezeTransform}>
          <boxGeometry args={LAMP_SIZE} />
          <meshStandardMaterial color={COLORS.lampHousing} roughness={0.7} metalness={0.3} />
        </mesh>
        {/* The glowing face. Emissive only: real lights here would cost a lot. */}
        <mesh position={[0, 0, LAMP_SIZE[2] / 2 + 0.01]} ref={freezeTransform}>
          <planeGeometry args={[LAMP_SIZE[0] - 0.3, LAMP_SIZE[1] - 0.3]} />
          <meshStandardMaterial
            color={COLORS.lamp}
            emissive={COLORS.lamp}
            emissiveIntensity={1.6}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  )
}

/**
 * Umpire's chair at the net, on the far sideline from the broadcast camera so
 * it frames the court instead of blocking it. Players can run "through" it;
 * there is no collision, but it sits at the edge of the runoff where play
 * rarely reaches.
 */
function UmpireChair({ x }: { x: number }): React.ReactElement {
  const seatY = 1.9
  return (
    <group position={[x, 0, 0]} ref={freezeTransform}>
      {[-0.35, 0.35].flatMap((dx) =>
        [-0.35, 0.35].map((dz) => (
          <mesh key={`${dx}${dz}`} position={[dx, seatY / 2, dz]} ref={freezeTransform}>
            <boxGeometry args={[0.08, seatY, 0.08]} />
            <meshStandardMaterial color={COLORS.chair} roughness={0.6} />
          </mesh>
        )),
      )}
      <mesh position={[0, seatY, 0]} ref={freezeTransform}>
        <boxGeometry args={[0.85, 0.1, 0.85]} />
        <meshStandardMaterial color={COLORS.chair} roughness={0.6} />
      </mesh>
      {/* Backrest on the side away from the court. */}
      <mesh position={[Math.sign(x) * 0.4, seatY + 0.4, 0]} ref={freezeTransform}>
        <boxGeometry args={[0.08, 0.8, 0.85]} />
        <meshStandardMaterial color={COLORS.chair} roughness={0.6} />
      </mesh>
      {/* The umpire. */}
      <mesh position={[0, seatY + 0.42, 0]} castShadow ref={freezeTransform}>
        <capsuleGeometry args={[0.22, 0.4, 3, 8]} />
        <meshStandardMaterial color={COLORS.umpireShirt} roughness={0.8} />
      </mesh>
      <mesh position={[0, seatY + 0.92, 0]} ref={freezeTransform}>
        <sphereGeometry args={[0.15, 10, 8]} />
        <meshStandardMaterial color={COLORS.skin[1]} roughness={0.8} />
      </mesh>
    </group>
  )
}

/* ------------------------------------------------------------------ *
 * Stadium
 * ------------------------------------------------------------------ */

export function Stadium({ wallHalfX, wallHalfZ }: Props): React.ReactElement {
  const { steps, seats, outerX, outerZ } = useMemo(
    () => buildStands(wallHalfX, wallHalfZ),
    [wallHalfX, wallHalfZ],
  )

  return (
    <group>
      {steps.map((step, i) => (
        <mesh key={i} position={step.position} receiveShadow ref={freezeTransform}>
          <boxGeometry args={step.size} />
          <meshStandardMaterial color={step.color} roughness={0.95} metalness={0} />
        </mesh>
      ))}

      <Crowd seats={seats} />

      {[-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => (
          <Floodlight key={`${sx}${sz}`} x={sx * (outerX + 1.5)} z={sz * (outerZ + 1.5)} />
        )),
      )}

      {/* The broadcast camera sits on +X, so the chair goes on -X. */}
      <UmpireChair x={-(COURT.halfWidth + COURT.runoffX + 0.6)} />
    </group>
  )
}
