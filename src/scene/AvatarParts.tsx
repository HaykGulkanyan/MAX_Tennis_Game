/**
 * The customisable parts of a player: torso (shirt and shorts), head (face,
 * hair, accessory) and shoes. Shared by the on-court `Player` and the
 * Customize screen's preview, so both always show exactly the same look.
 *
 * All primitives, like the rest of the scene. The one exception is the torso,
 * which wears a small canvas-painted texture: that is how stripes, a star or a
 * shirt number can sit on a capsule without any modelled geometry.
 *
 * Facing: an avatar looks down -Z in its own space (the parent turns it toward
 * the net), so the face and the front of the shirt are on the -Z side.
 */

/// <reference types="@react-three/fiber" />

import { useEffect, useMemo } from 'react';
import type React from 'react';
import * as THREE from 'three';

import { PLAYER } from '../game/constants';
import type { Avatar } from '../game/avatar';

/* ------------------------------------------------------------------ *
 * Proportions, derived from the collision capsule so the body always
 * matches what the simulation actually collides with.
 * ------------------------------------------------------------------ */

export const HEAD_RADIUS = PLAYER.radius * 0.52;
/** Torso occupies everything below the head. */
export const TORSO_HEIGHT = PLAYER.height - HEAD_RADIUS * 2;
/** Capsule arg is the cylindrical span, excluding the two hemisphere caps. */
const TORSO_CYLINDER = Math.max(0.05, TORSO_HEIGHT - PLAYER.radius * 2);
const TORSO_CENTER_Y = PLAYER.radius + TORSO_CYLINDER / 2;
export const HEAD_CENTER_Y = TORSO_HEIGHT + HEAD_RADIUS;

const R = HEAD_RADIUS;
const DARK = '#15181e';

/* ------------------------------------------------------------------ *
 * Shirt texture
 * ------------------------------------------------------------------ */

/*
 * How the capsule's UVs land on the body (three.js 0.180 CapsuleGeometry):
 * u runs around the body with x = -cos(2*pi*u), z = sin(2*pi*u), so the front
 * (-Z) is u = 0.75 and the back (+Z) is u = 0.25; v runs bottom to top by arc
 * length. The canvas is sized so a pixel covers about the same distance both
 * ways, which keeps a star round instead of squashed.
 */
const TEX_W = 512;
const TEX_H = 360;
const FRONT_X = TEX_W * 0.75;
const BACK_X = TEX_W * 0.25;
/** Waistband height as a v coordinate: about 0.55m off the ground. */
const SHORTS_TOP_V = 0.43;
const SHORTS_TOP_Y = (1 - SHORTS_TOP_V) * TEX_H;
/** Middle of the chest, where a star or number sits. */
const CHEST_Y = (1 - 0.56) * TEX_H;

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number): void {
  const inner = outer * 0.45;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  }
  ctx.closePath();
  ctx.fill();
}

/** Paint the shirt, its design and the shorts onto one texture. */
function paintKit(shirt: string, avatar: Avatar): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.fillStyle = shirt;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // The design, clipped to the shirt so it never spills onto the shorts.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, TEX_W, SHORTS_TOP_Y);
  ctx.clip();
  ctx.fillStyle = avatar.shirtAccent;
  ctx.strokeStyle = avatar.shirtAccent;

  switch (avatar.shirtDesign) {
    case 'stripes':
      for (let x = 0; x < TEX_W; x += 48) ctx.fillRect(x, 0, 18, TEX_H);
      break;
    case 'hoops':
      for (const y of [58, 112, 166]) ctx.fillRect(0, y, TEX_W, 24);
      break;
    case 'sash':
      ctx.lineWidth = 36;
      ctx.beginPath();
      ctx.moveTo(FRONT_X - 95, 40);
      ctx.lineTo(FRONT_X + 95, SHORTS_TOP_Y + 10);
      ctx.stroke();
      break;
    case 'star':
      drawStar(ctx, FRONT_X, CHEST_Y, 48);
      break;
    case 'number': {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = String(avatar.shirtNumber);
      ctx.font = 'bold 74px system-ui, sans-serif';
      ctx.fillText(label, FRONT_X, CHEST_Y);
      // A bigger number on the back, as on a real kit.
      ctx.font = 'bold 120px system-ui, sans-serif';
      ctx.fillText(label, BACK_X, CHEST_Y - 10);
      break;
    }
    case 'plain':
      break;
  }
  ctx.restore();

  // Shorts below the waistband, with a thin band in the shirt's accent colour.
  ctx.fillStyle = avatar.shorts;
  ctx.fillRect(0, SHORTS_TOP_Y, TEX_W, TEX_H - SHORTS_TOP_Y);
  ctx.fillStyle = avatar.shirtAccent;
  ctx.fillRect(0, SHORTS_TOP_Y, TEX_W, 5);

  return canvas;
}

/* ------------------------------------------------------------------ *
 * Torso
 * ------------------------------------------------------------------ */

export function Torso({ shirt, avatar }: { shirt: string; avatar: Avatar }): React.ReactElement {
  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(paintKit(shirt, avatar));
    // The canvas holds sRGB colours, like every material colour in the scene.
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
    // Repaint only when something painted on the kit actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shirt, avatar.shirtDesign, avatar.shirtAccent, avatar.shirtNumber, avatar.shorts]);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <mesh castShadow position={[0, TORSO_CENTER_Y, 0]}>
      <capsuleGeometry args={[PLAYER.radius, TORSO_CYLINDER, 4, 24]} />
      <meshStandardMaterial map={texture} roughness={0.62} metalness={0.04} />
    </mesh>
  );
}

/* ------------------------------------------------------------------ *
 * Shoes
 * ------------------------------------------------------------------ */

export function Shoes({ color }: { color: string }): React.ReactElement {
  // White shoes get a grey sole so the two parts still read separately.
  const sole = color.toLowerCase() === '#f4f7fa' ? '#c9ced8' : '#f4f7fa';
  return (
    <>
      {[-0.16, 0.16].map((x) => (
        <group key={x} position={[x, 0, -0.16]}>
          {/* Upper: a capsule lying along the foot, toe poking out in front. */}
          <mesh castShadow position={[0, 0.08, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <capsuleGeometry args={[0.075, 0.16, 3, 10]} />
            <meshStandardMaterial color={color} roughness={0.55} />
          </mesh>
          <mesh position={[0, 0.018, 0]}>
            <boxGeometry args={[0.16, 0.036, 0.34]} />
            <meshStandardMaterial color={sole} roughness={0.8} />
          </mesh>
        </group>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Face
 * ------------------------------------------------------------------ */

/** Depth of the face surface at a given offset from the head's centre. */
function faceZ(x: number, y: number, lift = 0.004): number {
  return -Math.sqrt(Math.max(0, R * R - x * x - y * y)) - lift;
}

function Eye({ x, scale = 1 }: { x: number; scale?: number }): React.ReactElement {
  const y = 0.03;
  return (
    <mesh position={[x, y, faceZ(x, y, -0.006)]} scale={scale}>
      <sphereGeometry args={[0.024, 8, 6]} />
      <meshStandardMaterial color={DARK} roughness={0.4} />
    </mesh>
  );
}

function Brow({ x, tilt, y = 0.085 }: { x: number; tilt: number; y?: number }): React.ReactElement {
  // A positive tilt lowers the brow's inner end: angry or determined.
  const inward = x > 0 ? tilt : -tilt;
  return (
    <mesh position={[x, y, faceZ(x, y)]} rotation={[0, 0, inward]}>
      <boxGeometry args={[0.07, 0.014, 0.012]} />
      <meshStandardMaterial color={DARK} roughness={0.6} />
    </mesh>
  );
}

/**
 * A curved mouth: half a torus. Unrotated, the half-torus arches upward (a
 * frown); turned half a revolution it dips (a smile).
 */
function CurvedMouth({ smile, width = 0.05 }: { smile: boolean; width?: number }): React.ReactElement {
  const y = smile ? -0.055 : -0.085;
  return (
    <mesh position={[0, y, faceZ(0, y)]} rotation={[0, 0, smile ? Math.PI : 0]}>
      <torusGeometry args={[width, 0.011, 6, 14, Math.PI]} />
      <meshStandardMaterial color={DARK} roughness={0.6} />
    </mesh>
  );
}

function FaceFeatures({ face }: { face: Avatar['face'] }): React.ReactElement {
  const eyeX = 0.072;
  switch (face) {
    case 'happy':
      return (
        <>
          <Eye x={-eyeX} />
          <Eye x={eyeX} />
          <CurvedMouth smile />
        </>
      );
    case 'focused':
      return (
        <>
          <Eye x={-eyeX} />
          <Eye x={eyeX} />
          <Brow x={-eyeX} tilt={0.18} />
          <Brow x={eyeX} tilt={0.18} />
          <mesh position={[0, -0.075, faceZ(0, -0.075)]}>
            <boxGeometry args={[0.08, 0.014, 0.012]} />
            <meshStandardMaterial color={DARK} roughness={0.6} />
          </mesh>
        </>
      );
    case 'angry':
      return (
        <>
          <Eye x={-eyeX} />
          <Eye x={eyeX} />
          <Brow x={-eyeX} tilt={0.5} y={0.078} />
          <Brow x={eyeX} tilt={0.5} y={0.078} />
          <CurvedMouth smile={false} width={0.045} />
        </>
      );
    case 'surprised':
      return (
        <>
          <Eye x={-eyeX} scale={1.35} />
          <Eye x={eyeX} scale={1.35} />
          <Brow x={-eyeX} tilt={-0.15} y={0.11} />
          <Brow x={eyeX} tilt={-0.15} y={0.11} />
          {/* An "O" mouth: a small full ring. */}
          <mesh position={[0, -0.08, faceZ(0, -0.08)]}>
            <torusGeometry args={[0.028, 0.011, 6, 14]} />
            <meshStandardMaterial color={DARK} roughness={0.6} />
          </mesh>
        </>
      );
    case 'cool':
      return (
        <>
          {/* Sunglasses: two dark lenses and a bridge. */}
          {[-eyeX, eyeX].map((x) => (
            <mesh key={x} position={[x, 0.03, faceZ(x, 0.03, 0.012)]}>
              <boxGeometry args={[0.085, 0.05, 0.02]} />
              <meshStandardMaterial color="#0b0d12" roughness={0.15} metalness={0.6} />
            </mesh>
          ))}
          <mesh position={[0, 0.04, faceZ(0, 0.04, 0.012)]}>
            <boxGeometry args={[0.07, 0.012, 0.012]} />
            <meshStandardMaterial color="#0b0d12" roughness={0.3} />
          </mesh>
          <CurvedMouth smile width={0.035} />
        </>
      );
  }
}

/* ------------------------------------------------------------------ *
 * Hair and accessories
 * ------------------------------------------------------------------ */

/**
 * A dome over the top of the head, tilted back so the forehead stays clear.
 * `cover` is how far down from the crown it reaches, as a fraction of a half
 * turn.
 */
function Dome({
  color,
  radius = R * 1.06,
  cover = 0.45,
  tilt = 0.32,
  y = 0,
}: {
  color: string;
  radius?: number;
  cover?: number;
  tilt?: number;
  y?: number;
}): React.ReactElement {
  return (
    <mesh castShadow position={[0, y, 0]} rotation={[tilt, 0, 0]}>
      <sphereGeometry args={[radius, 18, 10, 0, Math.PI * 2, 0, Math.PI * cover]} />
      <meshStandardMaterial color={color} roughness={0.85} side={THREE.DoubleSide} />
    </mesh>
  );
}

/**
 * Spikes for the spiky style: a ring of five around the crown plus one on
 * top, set on the scalp and pointing straight out of it. The ring is tilted
 * back like the dome, so the fringe stays off the face.
 */
const SPIKES = (() => {
  const up = new THREE.Vector3(0, 1, 0);
  const tiltBack = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.32);
  const directions = [new THREE.Vector3(0, 1, 0)];
  for (let i = 0; i < 5; i++) {
    const phi = (i / 5) * Math.PI * 2;
    const theta = 0.6;
    directions.push(
      new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)),
    );
  }
  return directions.map((direction) => {
    const normal = direction.clone().normalize().applyQuaternion(tiltBack);
    return {
      position: normal.clone().multiplyScalar(R * 1.08).toArray() as [number, number, number],
      quaternion: new THREE.Quaternion().setFromUnitVectors(up, normal),
    };
  });
})();

/**
 * Curl positions for the afro: a ring around the upper head, set back so the
 * face stays clear, plus one on top. The ring skips the front-centre spot.
 */
const AFRO_PUFFS: [number, number, number][] = (() => {
  const puffs: [number, number, number][] = [[0, R * 1.05, R * 0.2]];
  for (let i = 0; i < 8; i++) {
    const phi = (i / 8) * Math.PI * 2;
    const x = Math.cos(phi);
    const z = Math.sin(phi);
    // Front is -Z; leave the forehead open.
    if (z < -0.9) continue;
    puffs.push([x * R * 0.95, R * (z < -0.3 ? 0.75 : 0.5), z * R * 0.95 + R * 0.15]);
  }
  return puffs;
})();

function Hair({ style, color }: { style: Avatar['hairStyle']; color: string }): React.ReactElement | null {
  const material = <meshStandardMaterial color={color} roughness={0.85} />;
  switch (style) {
    case 'none':
      return null;
    case 'short':
      return <Dome color={color} />;
    case 'spiky':
      return (
        <>
          <Dome color={color} />
          {SPIKES.map((spike, i) => (
            <mesh key={i} castShadow position={spike.position} quaternion={spike.quaternion}>
              <coneGeometry args={[0.045, 0.14, 6]} />
              {material}
            </mesh>
          ))}
        </>
      );
    case 'long':
      return (
        <>
          <Dome color={color} cover={0.5} />
          {/* Hair falling down the back to the shoulders. */}
          <mesh castShadow position={[0, -0.1, R * 0.55]}>
            <capsuleGeometry args={[R * 0.82, 0.2, 4, 12]} />
            {material}
          </mesh>
        </>
      );
    case 'ponytail':
      return (
        <>
          <Dome color={color} />
          <mesh position={[0, R * 0.35, R * 0.98]}>
            <sphereGeometry args={[0.05, 10, 8]} />
            {material}
          </mesh>
          <mesh castShadow position={[0, R * -0.15, R * 1.18]} rotation={[0.25, 0, 0]}>
            <capsuleGeometry args={[0.055, 0.2, 4, 8]} />
            {material}
          </mesh>
        </>
      );
    case 'afro':
      // A round puff: a dome plus overlapping curls around the crown, so the
      // outline is bumpy and full rather than a smooth bowl.
      return (
        <>
          <Dome color={color} radius={R * 1.12} cover={0.55} tilt={0.4} />
          {AFRO_PUFFS.map((position, i) => (
            <mesh key={i} castShadow position={position}>
              <sphereGeometry args={[R * 0.62, 12, 10]} />
              {material}
            </mesh>
          ))}
        </>
      );
    case 'mohawk':
      return (
        <mesh castShadow position={[0, R * 0.92, R * 0.05]} rotation={[0.15, 0, 0]}>
          <boxGeometry args={[0.055, 0.16, R * 1.7]} />
          {material}
        </mesh>
      );
  }
}

function Accessory({ kind, color }: { kind: Avatar['accessory']; color: string }): React.ReactElement | null {
  switch (kind) {
    case 'cap':
      return (
        <>
          {/* Tilted back so its front edge sits above the brows, not over them. */}
          <Dome color={color} radius={R * 1.12} cover={0.45} tilt={0.3} />
          {/* The peak, sticking out over the face from that front edge. */}
          <mesh castShadow position={[0, R * 0.5, -R * 1.1]} rotation={[0.12, 0, 0]}>
            <boxGeometry args={[R * 1.3, 0.018, R * 0.85]} />
            <meshStandardMaterial color={color} roughness={0.7} />
          </mesh>
        </>
      );
    case 'headband':
      return (
        <mesh position={[0, R * 0.38, 0]} rotation={[Math.PI / 2 + 0.12, 0, 0]}>
          <torusGeometry args={[R * 0.97, 0.026, 6, 24]} />
          <meshStandardMaterial color={color} roughness={0.7} />
        </mesh>
      );
    default:
      // Wristbands are on the racket hand; `Player` places those.
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Head
 * ------------------------------------------------------------------ */

/** Head with face, hair and any head accessory, centred on its own origin. */
export function Head({ avatar }: { avatar: Avatar }): React.ReactElement {
  // A cap replaces the top of the hair; hair still shows below it at the back.
  const hairUnderCap = avatar.accessory === 'cap' && avatar.hairStyle !== 'long' && avatar.hairStyle !== 'ponytail';
  return (
    <group position={[0, HEAD_CENTER_Y, 0]}>
      <mesh castShadow>
        <sphereGeometry args={[R, 18, 14]} />
        <meshStandardMaterial color={avatar.skin} roughness={0.78} />
      </mesh>
      <FaceFeatures face={avatar.face} />
      {hairUnderCap ? null : <Hair style={avatar.hairStyle} color={avatar.hairColor} />}
      <Accessory kind={avatar.accessory} color={avatar.shirtAccent} />
    </group>
  );
}
