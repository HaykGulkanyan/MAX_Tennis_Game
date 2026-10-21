/**
 * Player looks: the options the Customize screen offers, and the rules for
 * accepting a look that arrived from another player.
 *
 * Everything here is plain data. The shirt's main colour stays on
 * `PlayerProfile.color`, as before, because the HUD and lobby already show it;
 * everything else about the look lives in `Avatar`.
 *
 * A look travels to the other player inside their profile, which makes it
 * untrusted input: `sanitizeProfile` maps anything unknown back to a default,
 * so a malformed or hostile profile can never break the scene.
 */

import { SHIRT_COLORS } from './constants';
import type { PlayerProfile } from './types';

export const HAIR_STYLES = ['none', 'short', 'spiky', 'long', 'ponytail', 'afro', 'mohawk'] as const;
export const SHIRT_DESIGNS = ['plain', 'stripes', 'hoops', 'sash', 'star', 'number'] as const;
export const FACES = ['happy', 'focused', 'angry', 'surprised', 'cool'] as const;
export const ACCESSORIES = ['none', 'cap', 'headband', 'wristbands'] as const;

export type HairStyle = (typeof HAIR_STYLES)[number];
export type ShirtDesign = (typeof SHIRT_DESIGNS)[number];
export type Face = (typeof FACES)[number];
export type Accessory = (typeof ACCESSORIES)[number];

export const HAIR_STYLE_LABELS: Record<HairStyle, string> = {
  none: 'Bald',
  short: 'Short',
  spiky: 'Spiky',
  long: 'Long',
  ponytail: 'Ponytail',
  afro: 'Afro',
  mohawk: 'Mohawk',
};
export const SHIRT_DESIGN_LABELS: Record<ShirtDesign, string> = {
  plain: 'Plain',
  stripes: 'Stripes',
  hoops: 'Hoops',
  sash: 'Sash',
  star: 'Star',
  number: 'Number',
};
export const FACE_LABELS: Record<Face, string> = {
  happy: 'Happy',
  focused: 'Focused',
  angry: 'Angry',
  surprised: 'Surprised',
  cool: 'Cool',
};
export const ACCESSORY_LABELS: Record<Accessory, string> = {
  none: 'None',
  cap: 'Cap',
  headband: 'Headband',
  wristbands: 'Wristbands',
};

export const SKIN_TONES = ['#f6d3b3', '#e8b48f', '#d9a377', '#b97f55', '#8d5a3b', '#5e3b26'] as const;
export const HAIR_COLORS = [
  '#1c1814', '#4a2f1d', '#7a4b2a', '#d8b46a', '#b5502b', '#d9d9d9', '#2f6fe8', '#e05aa8',
] as const;
/** Second colour for shirt designs, caps and headbands. */
export const ACCENT_COLORS = ['#f4f7fa', '#1c2230', ...SHIRT_COLORS] as const;
export const SHORTS_COLORS = ['#f4f7fa', '#1c2230', '#24365c', '#e8503a', '#8a94a6', '#37b46b'] as const;
export const SHOE_COLORS = ['#f4f7fa', '#1c2230', '#e8503a', '#2f7fe8', '#c8f24a', '#e05aa8', '#ff8a1f'] as const;
export const RACKET_COLORS = ['#22262e', '#e8503a', '#2f7fe8', '#f0b429', '#e05aa8', '#f4f7fa'] as const;

export type Avatar = {
  hairStyle: HairStyle;
  hairColor: string;
  skin: string;
  shirtDesign: ShirtDesign;
  /** Colour of the shirt design (stripes, star, number). */
  shirtAccent: string;
  /** Printed on the shirt when the design is 'number'. */
  shirtNumber: number;
  shorts: string;
  shoes: string;
  face: Face;
  accessory: Accessory;
  racket: string;
};

export const DEFAULT_AVATAR: Avatar = {
  hairStyle: 'short',
  hairColor: HAIR_COLORS[1],
  skin: SKIN_TONES[2],
  shirtDesign: 'plain',
  shirtAccent: ACCENT_COLORS[0],
  shirtNumber: 7,
  shorts: SHORTS_COLORS[0],
  shoes: SHOE_COLORS[0],
  face: 'happy',
  accessory: 'none',
  racket: RACKET_COLORS[0],
};

/** The computer opponent's look: sunglasses and a cap, all business. */
export const COMPUTER_AVATAR: Avatar = {
  hairStyle: 'none',
  hairColor: HAIR_COLORS[0],
  skin: SKIN_TONES[3],
  shirtDesign: 'sash',
  shirtAccent: '#1c2230',
  shirtNumber: 1,
  shorts: '#1c2230',
  shoes: '#1c2230',
  face: 'cool',
  accessory: 'cap',
  racket: '#f0b429',
};

/** The practice wall's stand-in: deliberately plain grey. */
export const WALL_AVATAR: Avatar = {
  ...DEFAULT_AVATAR,
  hairStyle: 'none',
  skin: '#8a94a6',
  shorts: '#6b7280',
  shoes: '#6b7280',
  face: 'focused',
};

const MAX_NAME_LENGTH = 16;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
}

/** Accept a look from anywhere (storage, the network), filling gaps with defaults. */
export function sanitizeAvatar(raw: unknown): Avatar {
  const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const number = Number(a.shirtNumber);
  return {
    hairStyle: pick(a.hairStyle, HAIR_STYLES, DEFAULT_AVATAR.hairStyle),
    hairColor: color(a.hairColor, DEFAULT_AVATAR.hairColor),
    skin: color(a.skin, DEFAULT_AVATAR.skin),
    shirtDesign: pick(a.shirtDesign, SHIRT_DESIGNS, DEFAULT_AVATAR.shirtDesign),
    shirtAccent: color(a.shirtAccent, DEFAULT_AVATAR.shirtAccent),
    shirtNumber: Number.isInteger(number) && number >= 0 && number <= 99 ? number : DEFAULT_AVATAR.shirtNumber,
    shorts: color(a.shorts, DEFAULT_AVATAR.shorts),
    shoes: color(a.shoes, DEFAULT_AVATAR.shoes),
    face: pick(a.face, FACES, DEFAULT_AVATAR.face),
    accessory: pick(a.accessory, ACCESSORIES, DEFAULT_AVATAR.accessory),
    racket: color(a.racket, DEFAULT_AVATAR.racket),
  };
}

/** Accept a whole profile from anywhere: a name, a shirt colour and a look. */
export function sanitizeProfile(raw: unknown, fallbackName = ''): PlayerProfile {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const name = typeof p.name === 'string' ? p.name.slice(0, MAX_NAME_LENGTH) : fallbackName;
  return {
    name,
    color: color(p.color, SHIRT_COLORS[0]),
    avatar: sanitizeAvatar(p.avatar),
  };
}

function any<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

/** A random look and shirt colour, for the Randomize button. */
export function randomLook(random: () => number = Math.random): { color: string; avatar: Avatar } {
  return {
    color: any(SHIRT_COLORS, random),
    avatar: {
      hairStyle: any(HAIR_STYLES, random),
      hairColor: any(HAIR_COLORS, random),
      skin: any(SKIN_TONES, random),
      shirtDesign: any(SHIRT_DESIGNS, random),
      shirtAccent: any(ACCENT_COLORS, random),
      shirtNumber: 1 + Math.floor(random() * 99),
      shorts: any(SHORTS_COLORS, random),
      shoes: any(SHOE_COLORS, random),
      face: any(FACES, random),
      accessory: any(ACCESSORIES, random),
      racket: any(RACKET_COLORS, random),
    },
  };
}
