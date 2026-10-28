/**
 * Crowd sound synthesis: a cheer after a point, and a quiet murmur under play.
 *
 * Pure functions over a `BaseAudioContext`, so the same code runs live and in
 * an OfflineAudioContext, where a check can render a cheer and measure it.
 * `sfx.ts` owns the live context and calls in here.
 *
 * A real crowd is not one sound but several at once, and plain filtered noise
 * (what this used to be) reads as static. So a cheer is layered:
 *
 *  - Roar: noise through three vowel formants (an "ahh" from many throats),
 *    with two slow, unrelated wobbles in level, because thousands of voices
 *    never swell together.
 *  - Applause: dozens of separate claps, each a few milliseconds of noise at
 *    its own pitch, time and stereo position, thickest at the start.
 *  - Voices: a handful of individual "woo!"s, buzzy tones through vowel
 *    filters that glide up in pitch.
 *  - Whistles: one or two for big moments.
 *
 * Every source gets a start and stop time and disconnects when it ends, so a
 * cheer leaves nothing behind in the graph.
 */

/** A source to start and stop at given times; `offset` is into a buffer. */
export type ScheduledSource = {
  source: AudioScheduledSourceNode;
  start: number;
  stop: number;
  offset?: number;
};

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Pan a node, where the browser supports it (old Safari does not). */
function panned(c: BaseAudioContext, out: AudioNode, pan: number): AudioNode {
  if (typeof c.createStereoPanner !== 'function') return out;
  const panner = c.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(out);
  return panner;
}

function noiseSource(c: BaseAudioContext, noise: AudioBuffer, rate = 1): AudioBufferSourceNode {
  const source = c.createBufferSource();
  source.buffer = noise;
  source.loop = true;
  source.loopEnd = noise.duration;
  source.playbackRate.value = rate;
  return source;
}

function bandpass(c: BaseAudioContext, hz: number, q: number): BiquadFilterNode {
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = hz;
  f.Q.value = q;
  return f;
}

/** The roar: formant-filtered noise with an uneven swell. */
function roar(
  c: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  t: number,
  duration: number,
  level: number,
): ScheduledSource[] {
  const sources: ScheduledSource[] = [];
  const envelope = c.createGain();
  envelope.gain.setValueAtTime(0.0001, t);
  envelope.gain.exponentialRampToValueAtTime(level, t + 0.35);
  // Hold the peak for about half the cheer before it dies away; a crowd
  // keeps cheering for a moment after the point, it does not drop at once.
  envelope.gain.setValueAtTime(level, t + duration * 0.5);
  envelope.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  envelope.gain.setValueAtTime(0, t + duration);

  // Uneven swell: a gain sitting at 1 with two slow LFOs added on top.
  const wobble = c.createGain();
  wobble.gain.value = 1;
  for (const [hz, depth] of [
    [rand(1.3, 2.1), 0.22],
    [rand(3.0, 4.2), 0.12],
  ]) {
    const lfo = c.createOscillator();
    lfo.frequency.value = hz;
    const amount = c.createGain();
    amount.gain.value = depth;
    lfo.connect(amount).connect(wobble.gain);
    sources.push({ source: lfo, start: t, stop: t + duration });
  }
  envelope.connect(wobble).connect(out);

  // An "ahh" vowel: the first three formants of an open vowel. Two noise
  // layers per side, slightly detuned, give the roar stereo width.
  const formants = [
    { hz: 700, q: 1.4, gain: 1 },
    { hz: 1220, q: 2.2, gain: 0.55 },
    { hz: 2600, q: 3, gain: 0.25 },
  ];
  for (const pan of [-0.6, 0.6]) {
    const src = noiseSource(c, noise, rand(0.92, 1.08));
    const dest = panned(c, envelope, pan);
    // A low rumble underneath the vowel: the body of a big crowd.
    const low = c.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 420;
    const lowGain = c.createGain();
    lowGain.gain.value = 0.9;
    src.connect(low).connect(lowGain).connect(dest);
    for (const formant of formants) {
      const g = c.createGain();
      g.gain.value = formant.gain;
      src.connect(bandpass(c, formant.hz * rand(0.95, 1.05), formant.q)).connect(g).connect(dest);
    }
    sources.push({ source: src, start: t, stop: t + duration, offset: rand(0, noise.duration * 0.8) });
  }
  return sources;
}

/** Applause: many short, individually pitched and placed claps. */
function applause(
  c: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  t: number,
  duration: number,
  level: number,
  density: number,
): ScheduledSource[] {
  const sources: ScheduledSource[] = [];
  const count = Math.round(density * duration);
  for (let i = 0; i < count; i++) {
    // Squaring the random time bunches claps toward the start, where the
    // applause is loudest, and lets it thin out as it dies away.
    const at = t + 0.08 + Math.pow(Math.random(), 1.8) * duration * 0.9;
    const fade = 1 - (at - t) / duration;
    const length = rand(0.006, 0.014);
    const src = noiseSource(c, noise, rand(0.8, 1.3));
    const g = c.createGain();
    const peak = level * rand(0.35, 1) * (0.25 + 0.75 * fade);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, at + length + 0.02);
    src
      .connect(bandpass(c, rand(1100, 2600), rand(1.2, 2.4)))
      .connect(g)
      .connect(panned(c, out, rand(-0.9, 0.9)));
    sources.push({ source: src, start: at, stop: at + length + 0.03, offset: rand(0, noise.duration * 0.9) });
  }
  return sources;
}

/** One "woo!": a buzzy tone through vowel filters, gliding up then falling. */
function voice(c: BaseAudioContext, out: AudioNode, at: number, level: number): ScheduledSource[] {
  const length = rand(0.55, 1.0);
  const base = rand(170, 420);
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(base, at);
  osc.frequency.exponentialRampToValueAtTime(base * rand(1.25, 1.5), at + length * 0.4);
  osc.frequency.exponentialRampToValueAtTime(base * rand(0.85, 1), at + length);

  // A little vibrato so it sounds sung, not synthesized.
  const vibrato = c.createOscillator();
  vibrato.frequency.value = rand(5, 7);
  const vibratoDepth = c.createGain();
  vibratoDepth.gain.value = base * 0.02;
  vibrato.connect(vibratoDepth).connect(osc.frequency);

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(level, at + 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, at + length);
  g.gain.setValueAtTime(0, at + length);

  // "oo" opening toward "ah": two formants, then a lowpass to tame the buzz.
  const dest = panned(c, out, rand(-0.8, 0.8));
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2400;
  lp.connect(g).connect(dest);
  osc.connect(bandpass(c, rand(380, 520), 4)).connect(lp);
  osc.connect(bandpass(c, rand(900, 1150), 5)).connect(lp);

  return [
    { source: osc, start: at, stop: at + length + 0.02 },
    { source: vibrato, start: at, stop: at + length + 0.02 },
  ];
}

/** A two-finger whistle: a high sine with a fast trill and a pitch flick. */
function whistle(c: BaseAudioContext, out: AudioNode, at: number, level: number): ScheduledSource[] {
  const length = rand(0.35, 0.6);
  const hz = rand(2100, 2900);
  const osc = c.createOscillator();
  osc.frequency.setValueAtTime(hz * 0.9, at);
  osc.frequency.exponentialRampToValueAtTime(hz, at + 0.06);
  osc.frequency.exponentialRampToValueAtTime(hz * 0.93, at + length);
  const trill = c.createOscillator();
  trill.frequency.value = rand(14, 22);
  const trillDepth = c.createGain();
  trillDepth.gain.value = hz * 0.015;
  trill.connect(trillDepth).connect(osc.frequency);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(level, at + 0.03);
  g.gain.setValueAtTime(level, at + length * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, at + length);
  g.gain.setValueAtTime(0, at + length);
  osc.connect(g).connect(panned(c, out, rand(-0.7, 0.7)));
  return [
    { source: osc, start: at, stop: at + length + 0.02 },
    { source: trill, start: at, stop: at + length + 0.02 },
  ];
}

/**
 * Build a whole cheer starting at time `t`. `intensity` runs 0..1.5: a point
 * is 1, the end of the match 1.5 (louder, longer, more voices and whistles).
 * Returns the sources; the caller starts and stops them.
 */
export function synthCheer(
  c: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  t: number,
  intensity: number,
): ScheduledSource[] {
  const k = Math.min(1.5, Math.max(0.2, intensity));
  const duration = 2.0 + k * 1.4;

  // One bus for the whole cheer, so its parts are balanced against each other
  // here and the result sits at a predictable level against the game sounds.
  const bus = c.createGain();
  bus.gain.value = 1.0 + 0.3 * k;
  bus.connect(out);

  const sources = [
    // Applause a little forward of the roar, so the claps read as clapping.
    ...roar(c, bus, noise, t, duration, 0.42),
    ...applause(c, bus, noise, t, duration, 0.75, 55 + 45 * k),
  ];
  const voices = Math.round(3 + 4 * k);
  for (let i = 0; i < voices; i++) {
    sources.push(...voice(c, bus, t + rand(0.05, 1.1), rand(0.035, 0.07)));
  }
  const whistles = k >= 1 ? Math.round(rand(1, 1 + k)) : 0;
  for (let i = 0; i < whistles; i++) {
    sources.push(...whistle(c, bus, t + rand(0.2, 1.4), rand(0.05, 0.08)));
  }
  return sources;
}

/**
 * The murmur under a match: the same "ahh" roar, very quiet and looping, with
 * a slow drift. It is what a cheer grows out of; without it each cheer starts
 * from dead silence and sounds pasted on.
 *
 * Returns the sources to start now, plus a stop function that fades it out.
 */
export function synthMurmur(
  c: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  level = 0.1,
): { sources: ScheduledSource[]; fadeOut: (at: number) => void } {
  const t = c.currentTime;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(level, t + 1.5);
  gain.connect(out);

  // Effectively endless; fadeOut ends it.
  const forever = t + 60 * 60 * 6;
  const sources: ScheduledSource[] = [];
  const drift = c.createOscillator();
  drift.frequency.value = 0.13;
  const driftDepth = c.createGain();
  driftDepth.gain.value = level * 0.35;
  drift.connect(driftDepth).connect(gain.gain);
  sources.push({ source: drift, start: t, stop: forever });

  for (const pan of [-0.7, 0.7]) {
    const src = noiseSource(c, noise, rand(0.9, 1.1));
    const dest = panned(c, gain, pan);
    src.connect(bandpass(c, 520, 0.9)).connect(dest);
    src.connect(bandpass(c, 1100, 2)).connect(dest);
    sources.push({ source: src, start: t, stop: forever, offset: rand(0, noise.duration * 0.8) });
  }

  return {
    sources,
    fadeOut(at: number) {
      gain.gain.cancelScheduledValues(at);
      gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.8);
      for (const s of sources) {
        try {
          s.source.stop(at + 0.85);
        } catch {
          /* already stopped */
        }
      }
    },
  };
}
