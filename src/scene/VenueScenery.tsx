/**
 * Per-venue scenery: the sky, and the map around the stadium.
 *
 *  - Beach: dunes, palms, umbrellas, a pier, surf, sailing boats, a lighthouse.
 *  - Paris: the Eiffel Tower at the end of the Champ de Mars, avenues of
 *    Haussmann buildings, the gold dome of Les Invalides.
 *  - Sydney: the Opera House and the Harbour Bridge across the harbour,
 *    ferries, the city skyline and the North Shore.
 *
 * The maps are built in Blender from code (art/venues/build_venues.py) and
 * exported to public/models/venue_<venue>.glb. To change one, edit the script
 * and rebuild; see NOTES.md.
 *
 * The contract with that script:
 *
 *  - The map is authored with its landmark beyond +Z. It is turned round for
 *    the player on side 1, so both players see the landmark ahead of them.
 *    Each browser draws its own scenery, and nothing here affects play.
 *  - The map leaves a hole over the stadium (|x| < 22, |z| < 36) that the
 *    court's own ground plane fills; see GROUND_HALF in Court.tsx.
 *  - Material flags arrive as glTF extras: `flat` (faceted shading), `unlit`
 *    (plain colour, no lighting) and `nofog` (not faded by distance).
 *  - Nodes named Bob_* bob on the water; Cloud_* drift across the sky.
 */

/// <reference types="@react-three/fiber" />

import { Component, Suspense, useEffect, useMemo } from 'react';
import type React from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

import { VENUES } from '../game/venues';
import type { Venue, VenuePalette } from '../game/venues';
import { DRACO_PATH } from './draco';

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

  const [fogNear, fogFar] = palette.fog;
  useEffect(() => {
    const previousBackground = scene.background;
    const previousFog = scene.fog;
    scene.background = texture;
    scene.fog = new THREE.Fog(palette.horizon, fogNear, fogFar);
    return () => {
      scene.background = previousBackground;
      scene.fog = previousFog;
      texture.dispose();
    };
  }, [scene, texture, palette.horizon, fogNear, fogFar]);

  return null;
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

function mapUrl(venue: Venue): string {
  return `${import.meta.env.BASE_URL}models/venue_${venue}.glb`;
}

// All three are small (~600KB together), so fetch them up front: whichever
// venue wins the vote is then ready by the time the match starts.
for (const venue of VENUES) useGLTF.preload(mapUrl(venue), DRACO_PATH);

type Flags = { flat?: number; unlit?: number; nofog?: number };

/** Materials are shared by every clone of a map, so adjust each one once. */
const preparedMaterials = new WeakSet<THREE.Material>();
const unlitMaterials = new WeakMap<THREE.Material, THREE.Material>();

function prepareMaterial(material: THREE.Material): THREE.Material {
  const flags = material.userData as Flags;
  if (flags.unlit) {
    let basic = unlitMaterials.get(material);
    if (!basic) {
      const source = material as THREE.MeshStandardMaterial;
      basic = new THREE.MeshBasicMaterial({ color: source.color, side: source.side, fog: !flags.nofog });
      basic.name = source.name;
      unlitMaterials.set(material, basic);
    }
    return basic;
  }
  if (!preparedMaterials.has(material)) {
    preparedMaterials.add(material);
    // The export shares vertices between faces (much smaller files); the
    // facets of the low-poly look are restored here, in the shader.
    if (material instanceof THREE.MeshStandardMaterial) {
      if (flags.flat) material.flatShading = true;
      if (flags.nofog) material.fog = false;
      material.needsUpdate = true;
    }
  }
  return material;
}

type Mover = { node: THREE.Object3D; kind: 'bob' | 'cloud'; base: THREE.Vector3; phase: number };

/** Clouds wrap round past the camera's far plane, so they never pop in view. */
const CLOUD_SPAN = 1400;
const CLOUD_SPEED = 1.6;

function VenueMap({ venue, farSign }: { venue: Venue; farSign: number }): React.ReactElement {
  const gltf = useGLTF(mapUrl(venue), DRACO_PATH);

  const { root, movers } = useMemo(() => {
    const root = gltf.scene.clone(true);
    const movers: Mover[] = [];
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map(prepareMaterial)
          : prepareMaterial(mesh.material);
        // Far outside the shadow camera's bounds; casting would cost for nothing.
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
      const kind = node.name.startsWith('Bob_') ? 'bob' : node.name.startsWith('Cloud_') ? 'cloud' : null;
      if (kind) movers.push({ node, kind, base: node.position.clone(), phase: movers.length * 1.7 });
    });
    // Everything else is static: compute each matrix once and stop updating.
    const moving = new Set(movers.map((m) => m.node));
    root.traverse((node) => {
      if (moving.has(node)) return;
      node.updateMatrix();
      node.matrixAutoUpdate = false;
    });
    return { root, movers };
  }, [gltf]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    for (const m of movers) {
      if (m.kind === 'bob') {
        m.node.position.y = m.base.y + Math.sin(t * 1.1 + m.phase) * 0.18;
        m.node.rotation.z = Math.sin(t * 0.9 + m.phase) * 0.035;
        m.node.rotation.x = Math.sin(t * 0.7 + m.phase * 1.3) * 0.025;
      } else {
        const x = m.base.x + t * CLOUD_SPEED + CLOUD_SPAN / 2;
        m.node.position.x = (((x % CLOUD_SPAN) + CLOUD_SPAN) % CLOUD_SPAN) - CLOUD_SPAN / 2;
      }
    }
  });

  return (
    <group rotation={[0, farSign > 0 ? 0 : Math.PI, 0]}>
      <primitive object={root} dispose={null} />
    </group>
  );
}

/**
 * If a map fails to load, play on without it rather than taking the whole
 * scene down: the court, stands and sky do not depend on it.
 */
class MapErrorBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn('Venue map failed to load; playing without it.', error);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function VenueScenery({ venue, farSign }: { venue: Venue; farSign: number }): React.ReactElement {
  return (
    <MapErrorBoundary key={venue}>
      <Suspense fallback={null}>
        <VenueMap venue={venue} farSign={farSign} />
      </Suspense>
    </MapErrorBoundary>
  );
}
