/**
 * Synthesized sound effects.
 *
 * Every sound here is generated from oscillators and noise buffers; there are
 * no asset files to load, so nothing can be missing at runtime and the deploy
 * stays a single JS bundle. That constraint also shapes the palette: short
 * percussive blips built from a pitch envelope plus filtered noise, which is
 * what an arcade tennis game wants anyway.
 *
 * Three rules hold this module together:
 *
 * 1. **Nothing is created at import time.** Constructing an AudioContext in
 *    module scope runs on import, which breaks SSR and leaves a live context
 *    behind in every test file that happens to pull this in. The context is
 *    built on the first `initAudio()` call instead, which the UI makes from a
 *    real click.
 * 2. **Nothing throws.** These fire from the game loop and from render-time
 *    callbacks. A sound failing must never take a rally with it, so every entry
 *    point is wrapped and failures are swallowed.
 * 3. **Nothing leaks.** During a fast rally these run many times per second.
 *    Each voice stops at a known time and disconnects itself when the hardware
 *    reports it finished, so the graph never grows.
 */

/** Master output. Everything routes through this, so muting is one gain write. */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

/** Headroom under 1.0, so overlapping voices in a rally do not clip. */
const MASTER_GAIN = 0.35;

/**
 * Shared noise, built once.
 *
 * Every impact sound needs a burst of noise, and filling a buffer is the most
 * expensive thing in this module. Generating one second of noise once and
 * playing short randomly offset slices of it is indistinguishable from fresh
 * noise per hit, and costs nothing per shot.
 */
let noiseBuffer: AudioBuffer | null = null;

/**
 * Create or resume the audio context. Safe to call repeatedly.
 *
 * Browsers refuse to start audio until the user has interacted with the page,
 * and a context created beforehand is born `suspended`. Rather than guess when
 * that gesture happened, this is called from the first real click and on every
 * subsequent one: the resume is a no-op once running, and a context that was
 * suspended again (tab backgrounded, OS audio focus lost) gets picked back up.
 */
export function initAudio(): void {
  try {
    if (!ctx) {
      // Safari still only exposes the prefixed constructor.
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;

      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_GAIN;
      master.connect(ctx.destination);
      noiseBuffer = createNoiseBuffer(ctx);
    }

    // `resume` rejects if the gesture did not actually count; that is a normal
    // outcome, not an error worth surfacing, so the rejection is absorbed.
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
  } catch {
    // No WebAudio, or the context could not be created. The game plays silent.
    ctx = null;
    master = null;
  }
}

export function setMuted(next: boolean): void {
  muted = next;
  try {
    if (master && ctx) {
      // Ramp rather than jump: an instant gain change on a sounding voice is an
      // audible click. 20ms is below perception as a fade but kills the click.
      master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, ctx.currentTime, 0.02);
    }
  } catch {
    // Muting is a preference, not a correctness concern; the flag still holds.
  }
}

export function isMuted(): boolean {
  return muted;
}

/**
 * Racket strike. `power` is 0..1; harder shots are brighter, louder and snappier.
 *
 * The character comes from the noise burst, not the tone: a racket is mostly a
 * transient. The oscillator only adds enough body to keep it from sounding like
 * a hiss.
 */
export function playHit(power: number): void {
  play((c, out, t) => {
    // Callers compute power from charge time and could hand over anything.
    const p = clamp01(power);
    const dur = 0.08;

    // A hard shot cracks; a soft one thuds. Pitch and cutoff both track power.
    const startHz = 380 + p * 520;
    const cutoffHz = 1400 + p * 4600;
    const level = 0.35 + p * 0.45;

    const body = c.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(startHz, t);
    // Fast downward sweep: this is what reads as an impact rather than a beep.
    body.frequency.exponentialRampToValueAtTime(startHz * 0.45, t + dur);

    const bodyGain = c.createGain();
    envelope(bodyGain.gain, t, level * 0.6, dur);
    body.connect(bodyGain).connect(out);

    const noise = c.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.playbackRate.value = 1 + p * 0.5;
    noise.loop = true;
    noise.loopEnd = noiseBuffer ? noiseBuffer.duration : 1;

    const band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(cutoffHz, t);
    band.Q.value = 0.9;

    const noiseGain = c.createGain();
    envelope(noiseGain.gain, t, level, dur * 0.7);
    noise.connect(band).connect(noiseGain).connect(out);

    return { sources: [body, noise], stopAt: t + dur };
  });
}

/**
 * Ball bouncing on the court. Shorter and duller than a racket hit, so the two
 * stay distinct when a bounce and a strike land close together.
 */
export function playBounce(): void {
  play((c, out, t) => {
    const dur = 0.06;

    const body = c.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(220, t);
    body.frequency.exponentialRampToValueAtTime(90, t + dur);

    const bodyGain = c.createGain();
    envelope(bodyGain.gain, t, 0.5, dur);
    body.connect(bodyGain).connect(out);

    const noise = c.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    noise.loopEnd = noiseBuffer ? noiseBuffer.duration : 1;

    // Low-passed so the surface reads as court, not strings.
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;

    const noiseGain = c.createGain();
    envelope(noiseGain.gain, t, 0.28, dur * 0.6);
    noise.connect(lp).connect(noiseGain).connect(out);

    return { sources: [body, noise], stopAt: t + dur };
  });
}

/** Ball into the net: a dull, damped thud with no bright content at all. */
export function playNet(): void {
  play((c, out, t) => {
    const dur = 0.1;

    const body = c.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(140, t);
    body.frequency.exponentialRampToValueAtTime(70, t + dur);

    const bodyGain = c.createGain();
    envelope(bodyGain.gain, t, 0.45, dur);
    body.connect(bodyGain).connect(out);

    const noise = c.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    noise.loopEnd = noiseBuffer ? noiseBuffer.duration : 1;

    // Heavily low-passed: the net absorbs the ball rather than reflecting it.
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;

    const noiseGain = c.createGain();
    envelope(noiseGain.gain, t, 0.3, dur);
    noise.connect(lp).connect(noiseGain).connect(out);

    return { sources: [body, noise], stopAt: t + dur };
  });
}

/** Point won: two quick rising blips, short enough not to cover the next serve. */
export function playScore(): void {
  tones([
    { hz: 660, at: 0, dur: 0.09 },
    { hz: 880, at: 0.08, dur: 0.12 },
  ]);
}

/** Match won: a major arpeggio (root, third, fifth, octave). */
export function playWin(): void {
  tones([
    { hz: 523.25, at: 0, dur: 0.12 },
    { hz: 659.25, at: 0.1, dur: 0.12 },
    { hz: 783.99, at: 0.2, dur: 0.12 },
    { hz: 1046.5, at: 0.3, dur: 0.26 },
  ]);
}

/** Match lost: the same shape descending, and minor, which reads as a loss. */
export function playLose(): void {
  tones([
    { hz: 523.25, at: 0, dur: 0.13 },
    { hz: 440, at: 0.12, dur: 0.13 },
    { hz: 349.23, at: 0.24, dur: 0.3 },
  ]);
}

/** UI button press: a single clean tick, quiet enough to click through menus. */
export function playUiClick(): void {
  play((c, out, t) => {
    const dur = 0.04;

    const osc = c.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t);

    const gain = c.createGain();
    envelope(gain.gain, t, 0.18, dur);

    // A bare square wave is harsh; rolling off the top leaves a soft tick.
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;

    osc.connect(lp).connect(gain).connect(out);

    return { sources: [osc], stopAt: t + dur };
  });
}

// --- Internals -------------------------------------------------------------

/** What a voice builder hands back so the scheduler can stop and clean it up. */
type Voice = {
  sources: AudioScheduledSourceNode[];
  /** Absolute context time at which every source should stop. */
  stopAt: number;
};

/**
 * Run a voice builder against the live context.
 *
 * This is the single guarded path every sound goes through, so the checks that
 * matter (context exists, not muted, actually running) live in one place rather
 * than being repeated, and imperfectly, in nine play functions.
 */
function play(build: (c: AudioContext, out: GainNode, t: number) => Voice): void {
  try {
    // Muted is checked before building rather than relying on the master gain:
    // a silent voice still costs nodes, and during a rally that is real work.
    if (muted || !ctx || !master) return;

    // Before the user's first gesture the context is suspended. Scheduling into
    // it is not an error, but nothing is audible and `currentTime` does not
    // advance, so the voices would all pile onto the same instant and then fire
    // at once the moment it resumes. Dropping them is the correct behaviour.
    if (ctx.state !== 'running') return;

    const c = ctx;
    const voice = build(c, master, c.currentTime);

    for (const source of voice.sources) {
      source.start(c.currentTime);
      // Every source is given an explicit stop time. Without this a looping
      // noise source runs forever and the graph grows with every shot.
      source.stop(voice.stopAt);
      // Disconnect once the hardware confirms the source finished. Stopping a
      // node does not detach it, and a detached-but-connected node keeps its
      // whole subgraph alive. `onended` is the only point at which it is
      // certainly safe to tear down.
      source.onended = () => {
        try {
          source.disconnect();
        } catch {
          // Already torn down, e.g. the context closed underneath us.
        }
      };
    }
  } catch {
    // A sound is never worth interrupting the game for.
  }
}

/** A short melodic figure. Used by the score, win and lose cues. */
function tones(notes: readonly { hz: number; at: number; dur: number }[]): void {
  play((c, out, t) => {
    const sources: AudioScheduledSourceNode[] = [];
    let end = t;

    for (const note of notes) {
      const start = t + note.at;
      const osc = c.createOscillator();
      // Triangle is soft enough to stack without the stridency of a square.
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(note.hz, start);

      const gain = c.createGain();
      envelope(gain.gain, start, 0.3, note.dur);
      osc.connect(gain).connect(out);

      sources.push(osc);
      end = Math.max(end, start + note.dur);
    }

    // One stop time for the whole figure. Individual notes are silenced by
    // their own envelopes, so stopping them together is inaudible and means a
    // single deadline to reason about.
    return { sources, stopAt: end + 0.02 };
  });
}

/**
 * A percussive attack/decay curve on a gain parameter.
 *
 * The ramp down is exponential because loudness is perceived logarithmically; a
 * linear fade sounds like it stops abruptly at the end. Exponential ramps
 * cannot reach zero, so it targets a tiny value and is cut to zero afterwards,
 * which is what keeps the tail from clicking.
 */
function envelope(
  param: AudioParam,
  start: number,
  peak: number,
  duration: number,
): void {
  const attack = Math.min(0.005, duration * 0.2);
  param.setValueAtTime(0.0001, start);
  param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + attack);
  param.exponentialRampToValueAtTime(0.0001, start + duration);
  param.setValueAtTime(0, start + duration);
}

/** One second of white noise, reused by every impact sound. */
function createNoiseBuffer(c: AudioContext): AudioBuffer {
  const length = Math.floor(c.sampleRate);
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

function clamp01(value: number): number {
  // Also catches NaN, which would otherwise poison every frequency downstream
  // and throw when handed to an AudioParam.
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
