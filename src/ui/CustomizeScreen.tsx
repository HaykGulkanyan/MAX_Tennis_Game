/**
 * Customize: change how your player looks, with a live 3D preview.
 *
 * Six tabs (Hair, Skin, Shirt, Shoes, Face, Extras), a Randomize button, and a
 * preview you can drag to turn. Every change is saved straight away (the store
 * writes the profile to localStorage), so there is nothing to confirm; Done
 * just goes back to wherever the player came from.
 */

import { useRef, useState } from 'react';
import type React from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import {
  ACCENT_COLORS,
  ACCESSORIES,
  ACCESSORY_LABELS,
  FACES,
  FACE_LABELS,
  HAIR_COLORS,
  HAIR_STYLES,
  HAIR_STYLE_LABELS,
  RACKET_COLORS,
  SHIRT_DESIGNS,
  SHIRT_DESIGN_LABELS,
  SHOE_COLORS,
  SHORTS_COLORS,
  SKIN_TONES,
  randomLook,
} from '../game/avatar';
import type { Avatar } from '../game/avatar';
import { SHIRT_COLORS } from '../game/constants';
import { Player } from '../scene/Actors';
import { useStore } from '../state/store';
import { ScreenShell } from './Screens';

const TABS = ['hair', 'skin', 'shirt', 'shoes', 'face', 'extras'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  hair: 'Hair',
  skin: 'Skin',
  shirt: 'Shirt',
  shoes: 'Shoes',
  face: 'Face',
  extras: 'Extras',
};

/* ------------------------------------------------------------------ *
 * Preview
 * ------------------------------------------------------------------ */

/** Starting angle: a three-quarter view, which shows the face and one side. */
const START_YAW = -0.45;

function PreviewRig({ yaw }: { yaw: React.MutableRefObject<number> }): React.ReactElement {
  const profile = useStore((s) => s.profile);
  const group = useRef<THREE.Group>(null);
  const { camera } = useThree();

  useFrame((state) => {
    camera.lookAt(0, 0.98, 0);
    if (!group.current) return;
    group.current.rotation.y = yaw.current;
    // A small idle bounce on the toes, so the preview feels alive.
    group.current.position.y = Math.abs(Math.sin(state.clock.elapsedTime * 2.2)) * 0.03;
  });

  return (
    <>
      <ambientLight intensity={0.75} color="#dbe8f5" />
      <directionalLight position={[-3, 5, -4]} intensity={2.2} />
      <directionalLight position={[3, 2, 3]} intensity={0.6} color="#9ec5ff" />
      <group ref={group}>
        {/* Side 1 faces -Z, which is toward this camera. */}
        <Player color={profile.color} avatar={profile.avatar} side={1} />
      </group>
      {/* A small floor disc so the player is not floating in space. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]}>
        <circleGeometry args={[0.9, 40]} />
        <meshStandardMaterial color="#2d7dd2" roughness={0.95} />
      </mesh>
    </>
  );
}

function Preview(): React.ReactElement {
  const yaw = useRef(START_YAW);
  const drag = useRef<{ x: number; yaw: number } | null>(null);

  // Drag anywhere on the preview to turn the player around.
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { x: event.clientX, yaw: yaw.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    yaw.current = drag.current.yaw + (event.clientX - drag.current.x) * 0.012;
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div
      className="customize-preview"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <Canvas
        camera={{ fov: 32, position: [0, 1.25, -4.2], near: 0.1, far: 30 }}
        gl={{ toneMapping: THREE.NoToneMapping, antialias: true }}
        dpr={[1, 2]}
      >
        <PreviewRig yaw={yaw} />
      </Canvas>
      <span className="customize-hint">Drag to turn</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function Swatches(props: {
  label: string;
  colors: readonly string[];
  value: string;
  onPick: (color: string) => void;
}): React.ReactElement {
  return (
    <fieldset className="field">
      <legend className="field-label">{props.label}</legend>
      <div className="swatches swatches-small">
        {props.colors.map((color) => {
          const selected = props.value.toLowerCase() === color.toLowerCase();
          return (
            <button
              key={color}
              type="button"
              className={selected ? 'swatch swatch-on' : 'swatch'}
              style={{ backgroundColor: color }}
              aria-label={`${props.label} ${color}`}
              aria-pressed={selected}
              onClick={() => props.onPick(color)}
            />
          );
        })}
      </div>
    </fieldset>
  );
}

function Choices<T extends string>(props: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onPick: (value: T) => void;
}): React.ReactElement {
  return (
    <fieldset className="field">
      <legend className="field-label">{props.label}</legend>
      <div className="choice-grid">
        {props.options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={props.value === option}
            className={props.value === option ? 'btn btn-chip btn-chip-on' : 'btn btn-chip'}
            onClick={() => props.onPick(option)}
          >
            {props.labels[option]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function TabPanel({ tab }: { tab: Tab }): React.ReactElement {
  const profile = useStore((s) => s.profile);
  const setProfile = useStore((s) => s.setProfile);
  const setAvatar = useStore((s) => s.setAvatar);
  const avatar = profile.avatar;
  const set = (change: Partial<Avatar>) => setAvatar(change);

  switch (tab) {
    case 'hair':
      return (
        <>
          <Choices
            label="Style"
            options={HAIR_STYLES}
            labels={HAIR_STYLE_LABELS}
            value={avatar.hairStyle}
            onPick={(hairStyle) => set({ hairStyle })}
          />
          <Swatches
            label="Hair colour"
            colors={HAIR_COLORS}
            value={avatar.hairColor}
            onPick={(hairColor) => set({ hairColor })}
          />
        </>
      );
    case 'skin':
      return (
        <Swatches
          label="Skin tone"
          colors={SKIN_TONES}
          value={avatar.skin}
          onPick={(skin) => set({ skin })}
        />
      );
    case 'shirt':
      return (
        <>
          <Swatches
            label="Shirt colour"
            colors={SHIRT_COLORS}
            value={profile.color}
            onPick={(color) => setProfile({ color })}
          />
          <Choices
            label="Design"
            options={SHIRT_DESIGNS}
            labels={SHIRT_DESIGN_LABELS}
            value={avatar.shirtDesign}
            onPick={(shirtDesign) => set({ shirtDesign })}
          />
          {avatar.shirtDesign !== 'plain' ? (
            <Swatches
              label="Design colour"
              colors={ACCENT_COLORS}
              value={avatar.shirtAccent}
              onPick={(shirtAccent) => set({ shirtAccent })}
            />
          ) : null}
          {avatar.shirtDesign === 'number' ? (
            <label className="field">
              <span className="field-label">Shirt number</span>
              <input
                className="input input-number"
                type="number"
                min={0}
                max={99}
                value={avatar.shirtNumber}
                onChange={(event) => {
                  const n = Math.round(Number(event.target.value));
                  if (Number.isFinite(n)) set({ shirtNumber: Math.max(0, Math.min(99, n)) });
                }}
              />
            </label>
          ) : null}
          <Swatches
            label="Shorts colour"
            colors={SHORTS_COLORS}
            value={avatar.shorts}
            onPick={(shorts) => set({ shorts })}
          />
        </>
      );
    case 'shoes':
      return (
        <Swatches
          label="Shoe colour"
          colors={SHOE_COLORS}
          value={avatar.shoes}
          onPick={(shoes) => set({ shoes })}
        />
      );
    case 'face':
      return (
        <Choices
          label="Expression"
          options={FACES}
          labels={FACE_LABELS}
          value={avatar.face}
          onPick={(face) => set({ face })}
        />
      );
    case 'extras':
      return (
        <>
          <Choices
            label="Accessory"
            options={ACCESSORIES}
            labels={ACCESSORY_LABELS}
            value={avatar.accessory}
            onPick={(accessory) => set({ accessory })}
          />
          {avatar.accessory !== 'none' ? (
            <Swatches
              label="Accessory colour"
              colors={ACCENT_COLORS}
              value={avatar.shirtAccent}
              onPick={(shirtAccent) => set({ shirtAccent })}
            />
          ) : null}
          <Swatches
            label="Racket colour"
            colors={RACKET_COLORS}
            value={avatar.racket}
            onPick={(racket) => set({ racket })}
          />
        </>
      );
  }
}

export function CustomizeScreen(props: { onDone: () => void }): React.ReactElement {
  const [tab, setTab] = useState<Tab>('hair');
  const setProfile = useStore((s) => s.setProfile);

  return (
    <ScreenShell wide>
      <header className="brand brand-compact">
        <h1 className="brand-title">Customize</h1>
        <p className="brand-sub">Make your player your own. Saved automatically.</p>
      </header>

      <div className="customize">
        <Preview />

        <div className="customize-controls">
          <div className="customize-tabs" role="tablist" aria-label="What to change">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? 'tab is-active' : 'tab'}
                onClick={() => setTab(t)}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
          <div className="customize-panel" role="tabpanel">
            <TabPanel tab={tab} />
          </div>
        </div>
      </div>

      <div className="row">
        <button type="button" className="btn btn-secondary" onClick={() => setProfile(randomLook())}>
          Randomize
        </button>
        <button type="button" className="btn btn-primary" onClick={props.onDone}>
          Done
        </button>
      </div>
    </ScreenShell>
  );
}
