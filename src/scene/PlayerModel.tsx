/**
 * The player as a rigged, animated 3D model.
 *
 * The model is built in Blender from code (art/player/build_player.py) and
 * exported to public/models/player.glb with every look variant inside it: all
 * hair styles, every face, cap, headband, wristbands and sunglasses. This
 * component clones it per player, recolours its materials from the profile and
 * shows only the variants that profile picked.
 *
 * Names are the contract with the Blender script: parts are found by object
 * name (Hair_short, Mouth_grin...) and recoloured by material name (Skin,
 * Shirt...). Rename something there and it must be renamed here.
 *
 * ANIMATION: the model runs its own mixer every frame. The game feeds it the
 * simulated player state through `drivePlayer(root, drive)` (stored on the
 * root's userData, no React re-render) and the model picks idle, run, swing
 * and celebration clips from that. With no drive at all, as in the Customize
 * preview, it just plays the idle loop.
 */

import { useEffect, useMemo, useRef } from 'react';
import type React from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import type { Avatar } from '../game/avatar';
import { DRACO_PATH } from './draco';

const MODEL_URL = `${import.meta.env.BASE_URL}models/player.glb`;
useGLTF.preload(MODEL_URL, DRACO_PATH);

/* ------------------------------------------------------------------ *
 * The drive: what the game tells the model each frame.
 * ------------------------------------------------------------------ */

export type PlayerDrive = {
  /** World velocity on the ground, m/s. */
  vx: number;
  vz: number;
  /** The simulation's swing timer: jumps up when a shot is struck. */
  swingTimer: number;
  /** Ball offset to the player's racket side (+) or off side (-), metres. */
  ballSide: number;
  /** Ball height when the swing starts decides an overhead. */
  ballY: number;
  /** The ball is on its way to this player and they should get ready. */
  incoming: number;
  /** This player is about to serve. */
  serving: boolean;
  /** This player just won the point. */
  celebrating: boolean;
};

/** Hand the model this frame's state. Cheap: it is a field write. */
export function drivePlayer(root: THREE.Object3D, drive: PlayerDrive): void {
  root.userData.drive = drive;
}

/* ------------------------------------------------------------------ *
 * Looks
 * ------------------------------------------------------------------ */

const FACE_PARTS: Record<Avatar['face'], [string, string]> = {
  happy: ['Brows_neutral', 'Mouth_grin'],
  focused: ['Brows_focused', 'Mouth_line'],
  angry: ['Brows_angry', 'Mouth_frown'],
  surprised: ['Brows_raised', 'Mouth_O'],
  cool: ['Brows_neutral', 'Mouth_smirk'],
};

const HAIR_NODES: Record<Avatar['hairStyle'], string | null> = {
  none: null,
  short: 'Hair_short',
  spiky: 'Hair_spiky',
  long: 'Hair_long',
  ponytail: 'Hair_ponytail',
  afro: 'Hair_afro',
  mohawk: 'Hair_mohawk',
};

/** Every node that is a look option; whichever are not picked are hidden. */
const VARIANTS = new Set<string>([
  ...Object.values(FACE_PARTS).flat(),
  ...Object.values(HAIR_NODES).filter((n): n is string => n !== null),
  'Sunglasses',
  'Cap',
  'Headband',
  'Wristbands',
]);

function visibleVariants(avatar: Avatar): Set<string> {
  const show = new Set<string>(FACE_PARTS[avatar.face]);
  if (avatar.face === 'cool') show.add('Sunglasses');
  // A cap sits over the crown, so only hair that hangs below it still shows.
  const hair = HAIR_NODES[avatar.hairStyle];
  const hairUnderCap = avatar.accessory === 'cap' && avatar.hairStyle !== 'long' && avatar.hairStyle !== 'ponytail';
  if (hair && !hairUnderCap) show.add(hair);
  if (avatar.accessory === 'cap') show.add('Cap');
  if (avatar.accessory === 'headband') show.add('Headband');
  if (avatar.accessory === 'wristbands') show.add('Wristbands');
  return show;
}

/* ------------------------------------------------------------------ *
 * Shirt print. The shirt's UVs wrap around the torso (see the Blender
 * script): front centre at u=0.5, back at u=0/1. Down the image, the top 10%
 * belongs to the sleeves (shoulder to cuff) and the rest is the torso, from
 * the shoulders down to the hem at the bottom edge. glTF UVs are not flipped,
 * so neither is the texture, and it is mirrored in u (repeat.x = -1) so text
 * reads the right way round.
 * ------------------------------------------------------------------ */

const KIT_W = 512;
const KIT_H = 320;
/** Where the torso starts, as a fraction down the image; above is sleeves. */
const TORSO_TOP = 0.1;
/** Middle of the chest, as a fraction down the image. */
const CHEST = 0.42;

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

function paintShirt(shirt: string, avatar: Avatar): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = KIT_W;
  canvas.height = KIT_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.fillStyle = shirt;
  ctx.fillRect(0, 0, KIT_W, KIT_H);
  ctx.fillStyle = avatar.shirtAccent;
  ctx.strokeStyle = avatar.shirtAccent;
  const front = KIT_W * 0.5;
  const chestY = KIT_H * CHEST;

  switch (avatar.shirtDesign) {
    case 'stripes':
      for (let x = 0; x < KIT_W; x += 42) ctx.fillRect(x, 0, 15, KIT_H);
      break;
    case 'hoops':
      for (const y of [0.3, 0.52, 0.74]) ctx.fillRect(0, KIT_H * y, KIT_W, KIT_H * 0.08);
      break;
    case 'sash':
      ctx.lineWidth = 34;
      ctx.beginPath();
      ctx.moveTo(front - 80, KIT_H * TORSO_TOP);
      ctx.lineTo(front + 80, KIT_H * 0.98);
      ctx.stroke();
      break;
    case 'star':
      drawStar(ctx, front, chestY, 40);
      break;
    case 'number': {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = String(avatar.shirtNumber);
      ctx.font = 'bold 64px system-ui, sans-serif';
      ctx.fillText(label, front, chestY);
      // A bigger number on the back, as on a real kit. The back is the seam
      // at both edges of the image, so draw it on both.
      ctx.font = 'bold 110px system-ui, sans-serif';
      ctx.fillText(label, 0, chestY + 14);
      ctx.fillText(label, KIT_W, chestY + 14);
      break;
    }
    case 'plain':
      break;
  }

  // Trim in the accent colour: the sleeve cuffs and the hem.
  ctx.fillStyle = avatar.shirtAccent;
  ctx.fillRect(0, KIT_H * 0.072, KIT_W, KIT_H * 0.016);
  ctx.fillRect(0, KIT_H * 0.985, KIT_W, KIT_H * 0.015);
  return canvas;
}

/** One cell of string net; the strings' UVs tile it across the racket face. */
function stringTexture(): THREE.CanvasTexture {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#eef3f6';
    ctx.fillRect(0, 0, size, 4);
    ctx.fillRect(0, 0, 4, size);
  }
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A shade darker, for eyebrows that match the hair. */
function darker(hex: string, amount: number): string {
  return `#${new THREE.Color(hex).multiplyScalar(1 - amount).getHexString()}`;
}

type Look = { color: string; avatar: Avatar };

function applyLook(model: THREE.Object3D, materials: Map<string, THREE.MeshStandardMaterial>, look: Look) {
  const { avatar, color } = look;
  const set = (name: string, hex: string) => materials.get(name)?.color.set(hex);
  set('Skin', avatar.skin);
  set('Shorts', avatar.shorts);
  set('Shoes', avatar.shoes);
  // White shoes get a grey sole so the two parts still read separately.
  set('Sole', avatar.shoes.toLowerCase() === '#f4f7fa' ? '#c9ced8' : '#f4f7fa');
  set('Hair', avatar.hairColor);
  set('Brow', avatar.hairStyle === 'none' ? '#2a1d14' : darker(avatar.hairColor, 0.25));
  set('Accent', avatar.shirtAccent);
  set('RacketFrame', avatar.racket);

  const shirt = materials.get('Shirt');
  if (shirt) {
    shirt.map?.dispose();
    const t = new THREE.CanvasTexture(paintShirt(color, avatar));
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(-1, 1);
    t.anisotropy = 4;
    shirt.map = t;
    shirt.color.set('#ffffff');
    shirt.needsUpdate = true;
  }

  // Multi-material parts load as a group named after the part, with one
  // child mesh per material; toggling the exact name toggles the whole part.
  const show = visibleVariants(avatar);
  model.traverse((node) => {
    if (VARIANTS.has(node.name)) node.visible = show.has(node.name);
  });
}

/* ------------------------------------------------------------------ *
 * Animation
 * ------------------------------------------------------------------ */

/**
 * Where each swing clip is started. The simulation strikes the ball on the
 * same tick the swing begins, so the clips start just before their contact
 * frame (0.15s) instead of at the top of the backswing; the backswing is
 * shown beforehand by the "ready" blend while the ball is incoming.
 */
const SWING_START: Record<string, number> = { Forehand: 0.07, Backhand: 0.07, Serve: 0.06 };
/** How long a one-shot keeps the stage before handing back to movement. */
const SWING_HOLD: Record<string, number> = { Forehand: 0.62, Backhand: 0.62, Serve: 0.72, Cheer: 1.5 };
/** Above this ball height a groundstroke becomes an overhead. */
const OVERHEAD_HEIGHT = 1.9;

type Rig = {
  mixer: THREE.AnimationMixer;
  idle: THREE.AnimationAction;
  run: THREE.AnimationAction;
  prepForehand: THREE.AnimationAction;
  prepBackhand: THREE.AnimationAction;
  oneShots: Record<string, THREE.AnimationAction>;
};

function buildRig(model: THREE.Object3D, clips: THREE.AnimationClip[]): Rig {
  const mixer = new THREE.AnimationMixer(model);
  const clip = (name: string) => {
    const found = THREE.AnimationClip.findByName(clips, name);
    if (!found) throw new Error(`player.glb is missing the ${name} animation`);
    return found;
  };
  const loop = (name: string) => {
    const a = mixer.clipAction(clip(name));
    a.play();
    a.weight = 0;
    return a;
  };
  /** A clip frozen on its first frame: the wound-up backswing. */
  const pose = (name: string) => {
    const a = mixer.clipAction(clip(name).clone());
    a.play();
    a.paused = true;
    a.time = 0;
    a.weight = 0;
    return a;
  };
  const once = (name: string) => {
    const a = mixer.clipAction(clip(name));
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.weight = 0;
    return a;
  };
  const idle = loop('Idle');
  idle.weight = 1;
  return {
    mixer,
    idle,
    run: loop('Run'),
    prepForehand: pose('Forehand'),
    prepBackhand: pose('Backhand'),
    oneShots: {
      Forehand: once('Forehand'),
      Backhand: once('Backhand'),
      Serve: once('Serve'),
      Cheer: once('Cheer'),
    },
  };
}

function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/* ------------------------------------------------------------------ *
 * The component
 * ------------------------------------------------------------------ */

type Props = {
  color: string;
  avatar: Avatar;
  /** The yaw the parent already applied, so running can turn relative to it. */
  baseYaw: number;
};

export function PlayerModel({ color, avatar, baseYaw }: Props): React.ReactElement {
  const gltf = useGLTF(MODEL_URL, DRACO_PATH);
  const turn = useRef<THREE.Group>(null);

  // One deep clone per player: its own skeleton and its own materials.
  const { model, materials } = useMemo(() => {
    const model = cloneSkinned(gltf.scene);
    const materials = new Map<string, THREE.MeshStandardMaterial>();
    const strings = stringTexture();
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      // Animated bodies leave their bind-pose bounds; culling them by those
      // bounds makes limbs blink out at the screen edge. Two players: cheap.
      mesh.frustumCulled = false;
      const source = mesh.material as THREE.MeshStandardMaterial;
      let material = materials.get(source.name);
      if (!material) {
        material = source.clone();
        materials.set(source.name, material);
        if (source.name === 'Strings') {
          material.map = strings;
          material.color.set('#ffffff');
          material.transparent = false;
          material.alphaTest = 0.5;
          material.side = THREE.DoubleSide;
          mesh.castShadow = false;
        }
      }
      mesh.material = material;
    });
    return { model, materials };
  }, [gltf.scene]);

  const rig = useMemo(() => buildRig(model, gltf.animations), [model, gltf.animations]);

  useEffect(() => {
    applyLook(model, materials, { color, avatar });
  }, [model, materials, color, avatar]);

  useEffect(
    () => () => {
      rig.mixer.stopAllAction();
      materials.forEach((m) => {
        m.map?.dispose();
        m.dispose();
      });
    },
    [rig, materials],
  );

  /** Animation state that lives across frames but never needs a render. */
  const anim = useRef({
    runW: 0,
    prepW: 0,
    prepForehand: 1,
    yaw: 0,
    lastSwing: 0,
    wasServing: false,
    wasCelebrating: false,
    shot: null as THREE.AnimationAction | null,
    shotLeft: 0,
    shotW: 0,
  });

  /** Play a one-shot clip (a swing or the celebration) from `at` seconds. */
  const startShot = (name: string, at: number) => {
    const s = anim.current;
    const action = rig.oneShots[name];
    if (s.shot && s.shot !== action) s.shot.weight = 0;
    action.reset();
    action.time = at;
    action.play();
    s.shot = action;
    s.shotLeft = SWING_HOLD[name];
    // Strike instantly: a fade-in would smear the contact frame. The
    // celebration eases in instead.
    if (name !== 'Cheer') s.shotW = 1;
  };

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const s = anim.current;
    const root = turn.current?.parent;
    const drive = root?.userData.drive as PlayerDrive | undefined;

    if (drive) {
      // A new swing: the timer jumped up since last frame.
      if (drive.swingTimer > s.lastSwing + 0.05) {
        const name =
          s.wasServing || drive.ballY > OVERHEAD_HEIGHT ? 'Serve' : drive.ballSide >= 0 ? 'Forehand' : 'Backhand';
        startShot(name, SWING_START[name]);
      }
      s.lastSwing = drive.swingTimer;
      s.wasServing = drive.serving;

      if (drive.celebrating && !s.wasCelebrating && !s.shot) startShot('Cheer', 0);
      s.wasCelebrating = drive.celebrating;
    }

    // One-shot weight: in fast, held, then handed back to movement.
    if (s.shot) {
      s.shotLeft -= delta;
      const target = s.shotLeft > 0.18 ? 1 : 0;
      s.shotW = approach(s.shotW, target, target ? 14 : 10, delta);
      if (s.shotLeft <= 0 && s.shotW < 0.02) {
        s.shot.stop();
        s.shot.weight = 0;
        s.shot = null;
        s.shotW = 0;
      }
    }

    const vx = drive?.vx ?? 0;
    const vz = drive?.vz ?? 0;
    const speed = Math.hypot(vx, vz);
    s.runW = approach(s.runW, THREE.MathUtils.smoothstep(speed, 0.35, 2.2), 10, delta);

    // Get ready while the ball comes: wind up on the side it is coming to.
    const incoming = drive ? drive.incoming : 0;
    s.prepW = approach(s.prepW, s.shot ? 0 : incoming * 0.85, 7, delta);
    if (drive) s.prepForehand = approach(s.prepForehand, drive.ballSide >= 0 ? 1 : 0, 8, delta);

    // Turn toward where we run; face the net to hit, wait and celebrate.
    let targetYaw = 0;
    let runDirection = 1;
    if (speed > 0.6 && !s.shot && s.prepW < 0.5) {
      targetYaw = wrapAngle(Math.atan2(-vx, -vz) - baseYaw);
      // Running backwards: keep facing the net and backpedal instead.
      if (Math.abs(targetYaw) > 2.1) {
        targetYaw = wrapAngle(targetYaw + Math.PI);
        runDirection = -1;
      }
      // Sidesteps over short distances stay mostly square to the net.
      targetYaw *= THREE.MathUtils.smoothstep(speed, 0.6, 3.5);
    }
    s.yaw += wrapAngle(targetYaw - s.yaw) * (1 - Math.exp(-(s.shot ? 20 : 9) * delta));
    if (turn.current) turn.current.rotation.y = s.yaw;

    // Weights always sum to one, so the mixer never blends toward the T-pose.
    const base = 1 - s.shotW;
    const prep = base * s.prepW;
    const move = base - prep;
    rig.idle.weight = move * (1 - s.runW);
    rig.run.weight = move * s.runW;
    rig.run.timeScale = runDirection * THREE.MathUtils.clamp(speed / 4.2, 0.7, 1.7);
    rig.prepForehand.weight = prep * s.prepForehand;
    rig.prepBackhand.weight = prep * (1 - s.prepForehand);
    if (s.shot) s.shot.weight = s.shotW;

    rig.mixer.update(delta);
  });

  return (
    <group ref={turn}>
      <primitive object={model} />
    </group>
  );
}
