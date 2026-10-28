/**
 * The venues a match can be played at, voted on before every game.
 *
 * Plain data, shared by the vote screen (names and blurbs) and the scene
 * (colours and light). Purely visual: every venue plays by the same rules and
 * physics, so a venue can never change who wins a point.
 */

export const VENUES = ['beach', 'paris', 'sydney'] as const;
export type Venue = (typeof VENUES)[number];

export function isVenue(value: unknown): value is Venue {
  return typeof value === 'string' && (VENUES as readonly string[]).includes(value);
}

export type VenueInfo = {
  name: string;
  surface: string;
  blurb: string;
};

export const VENUE_INFO: Record<Venue, VenueInfo> = {
  beach: {
    name: 'Sunset Beach',
    surface: 'Clay court',
    blurb: 'Sand, sea and palm trees, on red clay.',
  },
  paris: {
    name: 'Paris',
    surface: 'Grass court',
    blurb: 'Fresh-cut grass in the shadow of the Eiffel Tower.',
  },
  sydney: {
    name: 'Sydney Harbour',
    surface: 'Hard court',
    blurb: 'The Opera House and the Harbour Bridge across the water.',
  },
};

/** Everything the scene needs to dress a venue. */
export type VenuePalette = {
  court: string;
  runoff: string;
  line: string;
  /** Grass courts get mowing stripes in this second green; others none. */
  stripes: string | null;
  /** The ground beyond the court and stands. */
  ground: string;
  skyTop: string;
  /** Sky at the horizon; also the fog colour, so distant ground melts into it. */
  horizon: string;
  sun: string;
  sunIntensity: number;
  ambient: string;
  ambientIntensity: number;
  /** Alternating colours for the rows of the stands. */
  stands: [string, string];
  boardStripe: string;
};

export const VENUE_PALETTE: Record<Venue, VenuePalette> = {
  beach: {
    court: '#c8643b',
    runoff: '#b3532f',
    line: '#f7efe3',
    stripes: null,
    ground: '#e6cf98',
    skyTop: '#3b8fe0',
    horizon: '#cde8f6',
    sun: '#fff0d4',
    sunIntensity: 2.4,
    ambient: '#fff4e2',
    ambientIntensity: 0.7,
    stands: ['#e8e1d2', '#d8cfbc'],
    boardStripe: '#ff8a1f',
  },
  paris: {
    court: '#4f9b45',
    runoff: '#438a3b',
    line: '#ffffff',
    stripes: '#5cab50',
    ground: '#557f3e',
    skyTop: '#6b98d6',
    horizon: '#f2d9b8',
    sun: '#ffd8a6',
    sunIntensity: 2.1,
    ambient: '#f4e6d6',
    ambientIntensity: 0.62,
    stands: ['#2f4a3b', '#273f32'],
    boardStripe: '#7c3aa3',
  },
  sydney: {
    court: '#1f6ec7',
    runoff: '#2f8ade',
    line: '#ffffff',
    stripes: null,
    ground: '#8b949c',
    skyTop: '#2f80d8',
    horizon: '#c4e2f6',
    sun: '#ffffff',
    sunIntensity: 2.2,
    ambient: '#dcebf7',
    ambientIntensity: 0.62,
    stands: ['#26364c', '#1f2d40'],
    boardStripe: '#c8f24a',
  },
};

/**
 * Settle a vote. Agreement wins; otherwise a coin flip between the votes cast;
 * no votes at all means a random venue. `random` is injectable so a check can
 * pin the outcome.
 */
export function settleVote(
  votes: readonly (Venue | null)[],
  random: () => number = Math.random,
): Venue {
  const cast = votes.filter((v): v is Venue => v !== null);
  if (cast.length === 0) return VENUES[Math.floor(random() * VENUES.length)];
  return cast[Math.floor(random() * cast.length)];
}
