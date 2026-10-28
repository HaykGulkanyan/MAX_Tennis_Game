/**
 * Per-venue scenery: the sky, and what stands around the stadium.
 *
 *  - Beach: sea with surf, palm trees, umbrellas, a lifeguard tower, a boat.
 *  - Paris: the Eiffel Tower, a row of Haussmann buildings, plane trees.
 *  - Sydney: the Opera House, the Harbour Bridge, the harbour and a skyline.
 *
 * The landmark is placed beyond the FAR end of the court as this player sees
 * it (`farSign`), so both players get it in front of them rather than behind
 * their own back. Each browser draws its own scenery, so the two players'
 * views need not match, and nothing here affects play.
 *
 * Distances are chosen to stay inside the camera's far plane (400m) from every
 * camera position, with the fog fading the farthest pieces into the horizon.
 */

/// <reference types="@react-three/fiber" />

import { useEffect, useMemo } from 'react';
import type React from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

import type { Venue, VenuePalette } from '../game/venues';

type Vec = [number, number, number];

/* ------------------------------------------------------------------ *
 * Sky
 * ------------------------------------------------------------------ */

/**
 * A gradient sky as the scene background, plus matching fog. A background
 * texture (rather than a sky dome mesh) sits behind everything at any
 * distance, so it never runs into the camera's far plane.
 */
export function Sky({ palette }: { palette: VenuePalette }): null {
  const { scene } = useThree();
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Equirectangular: top row is straight up, the middle row the horizon.
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, palette.skyTop);
      g.addColorStop(0.42, palette.horizon);
      g.addColorStop(0.5, palette.horizon);
      g.addColorStop(1, palette.ground);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 4, 256);
    }
    const t = new THREE.CanvasTexture(canvas);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [palette.skyTop, palette.horizon, palette.ground]);

  useEffect(() => {
    const previousBackground = scene.background;
    const previousFog = scene.fog;
    scene.background = texture;
    scene.fog = new THREE.Fog(palette.horizon, 110, 390);
    return () => {
      scene.background = previousBackground;
      scene.fog = previousFog;
      texture.dispose();
    };
  }, [scene, texture, palette.horizon]);

  return null;
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

const UP = new THREE.Vector3(0, 1, 0);

/** A tapered beam from one point to another (a cylinder, oriented). */
function Beam({
  from,
  to,
  r0,
  r1,
  color,
  sides = 4,
}: {
  from: Vec;
  to: Vec;
  r0: number;
  r1: number;
  color: string;
  sides?: number;
}): React.ReactElement {
  const { position, quaternion, length } = useMemo(() => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const dir = b.clone().sub(a);
    return {
      position: a.clone().add(b).multiplyScalar(0.5).toArray() as Vec,
      quaternion: new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize()),
      length: dir.length(),
    };
  }, [from, to]);
  return (
    <mesh position={position} quaternion={quaternion}>
      <cylinderGeometry args={[r1, r0, length, sides]} />
      <meshStandardMaterial color={color} roughness={0.7} metalness={0.2} />
    </mesh>
  );
}

/** Water: a big flat plane, a little self-lit so it reads blue at distance. */
function Water({ farSign, start, color }: { farSign: number; start: number; color: string }): React.ReactElement {
  const depth = 700;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, farSign * (start + depth / 2)]}>
      <planeGeometry args={[900, depth]} />
      <meshStandardMaterial color={color} roughness={0.25} metalness={0.15} emissive={color} emissiveIntensity={0.12} />
    </mesh>
  );
}

/* ------------------------------------------------------------------ *
 * Beach
 * ------------------------------------------------------------------ */

function PalmTree({ position, lean = 0, scale = 1 }: { position: Vec; lean?: number; scale?: number }): React.ReactElement {
  // A trunk of three segments that curve over, crowned with drooping fronds.
  const segments: Vec[] = [
    [0, 0, 0],
    [lean * 0.6, 3.2, 0],
    [lean * 1.6, 6.2, 0],
    [lean * 3, 8.8, 0],
  ];
  const top = segments[segments.length - 1];
  return (
    <group position={position} scale={scale}>
      {segments.slice(1).map((point, i) => (
        <Beam key={i} from={segments[i]} to={point} r0={0.32 - i * 0.06} r1={0.26 - i * 0.06} color="#8a6a45" sides={7} />
      ))}
      {Array.from({ length: 7 }, (_, i) => {
        const angle = (i / 7) * Math.PI * 2;
        const tip: Vec = [top[0] + Math.cos(angle) * 3.4, top[1] - 1.3, top[2] + Math.sin(angle) * 3.4];
        return <Beam key={`f${i}`} from={top} to={tip} r0={0.5} r1={0.05} color="#2f8f3e" sides={3} />;
      })}
      {[0, 2.1, 4.2].map((a) => (
        <mesh key={a} position={[top[0] + Math.cos(a) * 0.35, top[1] - 0.3, top[2] + Math.sin(a) * 0.35]}>
          <sphereGeometry args={[0.25, 8, 6]} />
          <meshStandardMaterial color="#5b3f22" roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

function Umbrella({ position, color }: { position: Vec; color: string }): React.ReactElement {
  return (
    <group position={position}>
      <Beam from={[0, 0, 0]} to={[0, 2.3, 0]} r0={0.05} r1={0.05} color="#f4f7fa" sides={6} />
      <mesh position={[0, 2.3, 0]}>
        <coneGeometry args={[1.5, 0.6, 10]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      {/* A towel beside it. */}
      <mesh position={[1.1, 0.02, 0.4]} rotation={[-Math.PI / 2, 0, 0.3]}>
        <planeGeometry args={[0.9, 1.8]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
    </group>
  );
}

function Beach({ farSign }: { farSign: number }): React.ReactElement {
  const shore = 48;
  const palms: [number, number, number, number][] = [
    // x, z (toward far end), lean, scale
    [-24, 4, 1, 1.1], [-27, -14, -0.8, 1], [-23, 22, 0.6, 1.2], [24, 8, -1, 1.15],
    [27, -18, 0.7, 1], [23, 24, -0.6, 1.1], [-34, 38, 1, 1.3], [34, 40, -1.1, 1.25],
    [-14, 42, 0.5, 1.1], [14, 43, -0.5, 1.2], [-40, -30, 0.8, 1.2], [40, -34, -0.8, 1.1],
  ];
  const umbrellas: [number, number, string][] = [
    [-8, 38, '#e8503a'], [0, 40, '#f0b429'], [9, 38, '#2f7fe8'], [-18, 41, '#37b46b'], [20, 40, '#e05aa8'],
  ];
  return (
    <group>
      <Water farSign={farSign} start={shore} color="#1f8fc9" />
      {/* Surf: a pale band where the waves meet the sand. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, farSign * (shore + 1.5)]}>
        <planeGeometry args={[900, 3]} />
        <meshStandardMaterial color="#e9f6fb" roughness={0.6} emissive="#cfeaf5" emissiveIntensity={0.2} />
      </mesh>
      {palms.map(([x, z, lean, s], i) => (
        <PalmTree key={i} position={[x, 0, farSign * z]} lean={lean} scale={s} />
      ))}
      {umbrellas.map(([x, z, color], i) => (
        <Umbrella key={i} position={[x, 0, farSign * z]} color={color} />
      ))}
      {/* Lifeguard tower on the sand. */}
      <group position={[30, 0, farSign * 44]}>
        {[-0.8, 0.8].flatMap((dx) =>
          [-0.8, 0.8].map((dz) => (
            <Beam key={`${dx}${dz}`} from={[dx, 0, dz]} to={[dx * 0.8, 3, dz * 0.8]} r0={0.08} r1={0.08} color="#f4f7fa" sides={5} />
          )),
        )}
        <mesh position={[0, 3.6, 0]}>
          <boxGeometry args={[2.2, 1.4, 2.2]} />
          <meshStandardMaterial color="#e8503a" roughness={0.7} />
        </mesh>
        <mesh position={[0, 4.5, 0]}>
          <coneGeometry args={[1.8, 0.8, 4]} />
          <meshStandardMaterial color="#f4f7fa" roughness={0.7} />
        </mesh>
      </group>
      {/* A sailing boat out at sea. */}
      <group position={[-60, 0, farSign * 120]}>
        <mesh position={[0, 0.6, 0]}>
          <boxGeometry args={[8, 1.2, 2.4]} />
          <meshStandardMaterial color="#f4f7fa" roughness={0.6} />
        </mesh>
        <mesh position={[0, 5.4, 0]} rotation={[0, Math.PI / 2, 0]}>
          <coneGeometry args={[3, 8.5, 3]} />
          <meshStandardMaterial color="#f7efe3" roughness={0.7} />
        </mesh>
      </group>
      {/* A distant headland on the horizon. */}
      <mesh position={[110, 0, farSign * 260]} scale={[1, 0.22, 0.6]}>
        <sphereGeometry args={[70, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#5f8f5a" roughness={1} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Paris
 * ------------------------------------------------------------------ */

const IRON = '#6f5a46';

/** The Eiffel Tower, about 95m tall: legs, arches, two decks and the spire. */
function EiffelTower({ position }: { position: Vec }): React.ReactElement {
  const base = 15;
  const deck1 = { y: 24, half: 8 };
  const deck2 = { y: 48, half: 4.4 };
  const corners: [number, number][] = [
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  return (
    <group position={position}>
      {/* Four splayed legs up to the first deck. */}
      {corners.map(([sx, sz]) => (
        <Beam
          key={`${sx}${sz}`}
          from={[sx * base, 0, sz * base]}
          to={[sx * deck1.half, deck1.y, sz * deck1.half]}
          r0={2.3}
          r1={1.4}
          color={IRON}
        />
      ))}
      {/* The arches between the legs, one per face. */}
      {[0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((yaw) => (
        <group key={yaw} rotation={[0, yaw, 0]}>
          <mesh position={[0, 6, 12]}>
            <torusGeometry args={[9.5, 0.55, 6, 24, Math.PI]} />
            <meshStandardMaterial color={IRON} roughness={0.7} metalness={0.2} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, deck1.y, 0]}>
        <boxGeometry args={[deck1.half * 2 + 4, 2.6, deck1.half * 2 + 4]} />
        <meshStandardMaterial color={IRON} roughness={0.7} metalness={0.2} />
      </mesh>
      {/* Middle section, tapering to the second deck. */}
      {corners.map(([sx, sz]) => (
        <Beam
          key={`m${sx}${sz}`}
          from={[sx * deck1.half, deck1.y, sz * deck1.half]}
          to={[sx * deck2.half, deck2.y, sz * deck2.half]}
          r0={1.3}
          r1={0.9}
          color={IRON}
        />
      ))}
      <mesh position={[0, deck2.y, 0]}>
        <boxGeometry args={[deck2.half * 2 + 2.4, 1.8, deck2.half * 2 + 2.4]} />
        <meshStandardMaterial color={IRON} roughness={0.7} metalness={0.2} />
      </mesh>
      {/* The long upper section to the top, then the spire. */}
      <mesh position={[0, (deck2.y + 86) / 2, 0]} rotation={[0, Math.PI / 4, 0]}>
        <cylinderGeometry args={[0.9, deck2.half * 1.25, 86 - deck2.y, 4]} />
        <meshStandardMaterial color={IRON} roughness={0.7} metalness={0.2} />
      </mesh>
      <mesh position={[0, 87, 0]}>
        <boxGeometry args={[2.4, 2.4, 2.4]} />
        <meshStandardMaterial color={IRON} roughness={0.7} metalness={0.2} />
      </mesh>
      <Beam from={[0, 88, 0]} to={[0, 96, 0]} r0={0.25} r1={0.08} color={IRON} sides={6} />
    </group>
  );
}

/** A Haussmann block: cream stone with a grey-blue mansard roof. */
function Building({ position, width, height, depth }: { position: Vec; width: number; height: number; depth: number }): React.ReactElement {
  return (
    <group position={position}>
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color="#e9dcc3" roughness={0.9} />
      </mesh>
      {/* Mansard roof: a squat four-sided frustum. */}
      <mesh position={[0, height + 1.6, 0]} rotation={[0, Math.PI / 4, 0]} scale={[width / depth, 1, 1]}>
        <cylinderGeometry args={[depth * 0.42, depth * 0.72, 3.2, 4]} />
        <meshStandardMaterial color="#5d6b7c" roughness={0.8} />
      </mesh>
    </group>
  );
}

function ParkTree({ position, scale = 1 }: { position: Vec; scale?: number }): React.ReactElement {
  return (
    <group position={position} scale={scale}>
      <Beam from={[0, 0, 0]} to={[0, 3.4, 0]} r0={0.3} r1={0.22} color="#6b4e33" sides={6} />
      <mesh position={[0, 5.2, 0]}>
        <sphereGeometry args={[2.6, 10, 8]} />
        <meshStandardMaterial color="#3f7d36" roughness={0.95} />
      </mesh>
    </group>
  );
}

function Paris({ farSign }: { farSign: number }): React.ReactElement {
  const blocks = useMemo(() => {
    const out: { x: number; z: number; w: number; h: number; d: number }[] = [];
    // Two rows of buildings framing the view, set apart around the tower.
    for (let i = 0; i < 14; i++) {
      const x = -130 + i * 20;
      if (Math.abs(x + 22) < 30) continue; // keep the tower clear
      out.push({ x, z: 95 + (i % 3) * 6, w: 16 + (i % 2) * 3, h: 14 + (i % 4) * 2.5, d: 12 });
    }
    for (let i = 0; i < 10; i++) {
      out.push({ x: -60 + i * 14, z: -70 - (i % 2) * 8, w: 12, h: 13 + (i % 3) * 2, d: 11 });
    }
    return out;
  }, []);
  const trees: [number, number, number][] = [
    [-25, 0, 1.1], [-26, 18, 1], [-25, -18, 1.2], [25, 4, 1.1], [26, -16, 1], [25, 20, 1.15],
    [-12, 42, 1.2], [12, 42, 1.1], [-38, 44, 1.3], [38, 46, 1.25], [0, 50, 1.1], [-50, 30, 1.2], [50, 30, 1.2],
  ];
  return (
    <group>
      {/* Far enough back, and scaled, that the whole tower fits in view. */}
      <group scale={0.85}>
        <EiffelTower position={[-26, 0, farSign * 225]} />
      </group>
      {blocks.map((b, i) => (
        <Building key={i} position={[b.x, 0, farSign * b.z]} width={b.w} height={b.h} depth={b.d} />
      ))}
      {trees.map(([x, z, s], i) => (
        <ParkTree key={i} position={[x, 0, farSign * z]} scale={s} />
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Sydney
 * ------------------------------------------------------------------ */

const SHELL = '#fbf8f0';

/**
 * One sail of the Opera House: a quarter of a sphere, stretched tall, leaning
 * back from its open face the way the real shells do.
 */
function Sail({ position, size, yaw = 0 }: { position: Vec; size: number; yaw?: number }): React.ReactElement {
  // Narrow and tall, leaning back: from a distance that reads as the
  // building's pointed white sails rather than as a row of round domes.
  return (
    <mesh position={position} rotation={[-0.28, yaw, 0]} scale={[size * 0.42, size * 1.7, size]}>
      <sphereGeometry args={[1, 18, 12, 0, Math.PI, 0, Math.PI / 2]} />
      <meshStandardMaterial
        color={SHELL}
        roughness={0.3}
        metalness={0.05}
        emissive={SHELL}
        emissiveIntensity={0.28}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function OperaHouse({ position, facing }: { position: Vec; facing: number }): React.ReactElement {
  // Two main halls side by side, each a run of sails shrinking toward the
  // back, plus a small restaurant hall in front. A sail's rounded, bright
  // outer side is its local +Z; `facing` turns that side toward the court.
  const hall = (x: number) =>
    [11, 9, 7, 5].map((size, i) => (
      <Sail key={`${x}${i}`} position={[x, 5, -i * 7.5]} size={size} />
    ));
  return (
    <group position={position} rotation={[0, facing, 0]}>
      <mesh position={[0, 2.5, -10]}>
        <boxGeometry args={[46, 5, 44]} />
        <meshStandardMaterial color="#c9a88a" roughness={0.9} />
      </mesh>
      {hall(-10)}
      {hall(10)}
      <Sail position={[0, 5, 12]} size={4.5} />
    </group>
  );
}

function HarbourBridge({ position }: { position: Vec }): React.ReactElement {
  const span = 46;
  return (
    <group position={position}>
      {/* The arch. */}
      <mesh position={[0, 8, 0]} scale={[1, 0.62, 1]}>
        <torusGeometry args={[span, 1.8, 8, 40, Math.PI]} />
        <meshStandardMaterial color="#76808b" roughness={0.6} metalness={0.4} />
      </mesh>
      {/* The deck, running under the arch and out past the pylons. */}
      <mesh position={[0, 12, 0]}>
        <boxGeometry args={[span * 2 + 40, 1.4, 6]} />
        <meshStandardMaterial color="#5e6872" roughness={0.7} metalness={0.3} />
      </mesh>
      {/* Hangers from the arch to the deck. */}
      {Array.from({ length: 9 }, (_, i) => {
        const x = -span * 0.8 + (i * span * 1.6) / 8;
        const archY = 8 + Math.sqrt(Math.max(0, span * span - x * x)) * 0.62;
        return <Beam key={i} from={[x, 12, 0]} to={[x, archY, 0]} r0={0.25} r1={0.25} color="#76808b" sides={4} />;
      })}
      {/* Granite pylons at each end. */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (span + 6), 9, 0]}>
          <boxGeometry args={[7, 18, 8]} />
          <meshStandardMaterial color="#b8a58c" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function Sydney({ farSign }: { farSign: number }): React.ReactElement {
  const towers = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => ({
        x: 60 + i * 9 + (i % 3) * 2,
        h: 25 + ((i * 37) % 45),
        w: 7 + (i % 3) * 2,
        color: ['#9fb3c6', '#7f93a8', '#c2ccd6', '#6f8296'][i % 4],
      })),
    [],
  );
  return (
    <group>
      <Water farSign={farSign} start={46} color="#1d6aa3" />
      {/* A harbour-side promenade along the water's edge. */}
      <mesh position={[0, 0.3, farSign * 45]}>
        <boxGeometry args={[220, 0.6, 3]} />
        <meshStandardMaterial color="#c9c2b4" roughness={0.9} />
      </mesh>
      <OperaHouse position={[-34, 0, farSign * 125]} facing={farSign > 0 ? Math.PI * 0.85 : -Math.PI * 0.15} />
      <HarbourBridge position={[70, 0, farSign * 175]} />
      {towers.map((t, i) => (
        <mesh key={i} position={[t.x, t.h / 2, farSign * (215 + (i % 2) * 12)]}>
          <boxGeometry args={[t.w, t.h, t.w]} />
          <meshStandardMaterial color={t.color} roughness={0.5} metalness={0.3} />
        </mesh>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function VenueScenery({ venue, farSign }: { venue: Venue; farSign: number }): React.ReactElement {
  switch (venue) {
    case 'beach':
      return <Beach farSign={farSign} />;
    case 'paris':
      return <Paris farSign={farSign} />;
    case 'sydney':
      return <Sydney farSign={farSign} />;
  }
}
