/**
 * Build a MIDI tempo map from detected beat times, and convert between
 * seconds and ticks using that map.
 *
 * Idea: every detected beat becomes exactly one quarter note. The tempo of
 * each beat interval is set so that the next beat lands on the next quarter.
 * A DAW reading the file then shows bar lines that follow the performance,
 * instead of a fixed 120 BPM grid that drifts away from the music.
 */

/** One tempo change in the map. */
export interface TempoEvent {
  /** Position in ticks where this tempo starts. */
  tick: number;
  /** Microseconds per quarter note, as stored in the MIDI Set Tempo meta event. */
  usPerQuarter: number;
  /** Same tempo in beats per minute (derived, for display). */
  bpm: number;
  /** Time in seconds at which this tempo starts (derived from the map itself). */
  seconds: number;
}

export interface TimeSignature {
  /** Position in ticks where this time signature starts. */
  tick: number;
  numerator: number;
  /** Denominator as a note value (4 = quarter, 8 = eighth). */
  denominator: number;
}

export interface TempoMap {
  /** Ticks per quarter note (MIDI header division). */
  ppq: number;
  /** Tempo events, sorted by tick. The first event is always at tick 0. */
  events: TempoEvent[];
  /** Time signatures, sorted by tick. A short first bar is a pickup (anacrusis). */
  timeSignatures: TimeSignature[];
  /** Tick at which the first detected beat was placed. */
  firstBeatTick: number;
  /** Representative tempo of the performance: the median beat interval, in BPM. */
  medianBpm: number;
}

export interface BeatsToTempoMapOptions {
  /** Ticks per quarter note. Default 480. */
  ppq?: number;
  /** Beats per bar, used for the time signature and downbeat alignment. Default 4. */
  beatsPerBar?: number;
  /**
   * Index (into `beats`) of a beat that should fall on a bar line.
   * Use the output of a downbeat detector here so that bar 1 / bar N line up.
   * When needed, a short pickup bar is inserted at the start to make this work.
   * Default 0 (the first detected beat starts a bar).
   */
  downbeatIndex?: number;
  /**
   * Run `cleanBeats()` on the input first, so raw beat-tracker output (unsorted,
   * duplicated or spurious beats) is accepted instead of throwing. Default false.
   */
  clean?: boolean;
}

const US_PER_MINUTE = 60_000_000;
/** Beats closer together than this (seconds) are treated as duplicates. */
const MIN_BEAT_GAP_S = 1e-3;
/** Beats closer than this fraction of the typical beat interval are treated as false detections. */
const SPURIOUS_GAP_RATIO = 0.5;
/** Largest value that fits in the 24-bit Set Tempo field (~3.58 BPM). */
const MAX_US_PER_QUARTER = 0xffffff;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function intervals(beats: readonly number[]): number[] {
  return beats.slice(1).map((b, i) => b - beats[i]!);
}

/**
 * Tidy raw beat-tracker output: drop non-finite and negative values, sort,
 * remove duplicates closer than 1 ms, then remove beats that are closer than
 * half the median beat interval (false detections between real beats).
 * Returns a new array; the input is not modified.
 */
export function cleanBeats(beats: readonly number[]): number[] {
  const sorted = beats.filter((b) => Number.isFinite(b) && b >= 0).sort((a, b) => a - b);
  const deduped = sorted.filter((t, i) => i === 0 || t - sorted[i - 1]! >= MIN_BEAT_GAP_S);
  if (deduped.length < 3) return deduped;
  const minGap = median(intervals(deduped)) * SPURIOUS_GAP_RATIO;
  const out: number[] = [];
  for (const t of deduped) {
    if (out.length === 0 || t - out[out.length - 1]! >= minGap) out.push(t);
  }
  return out;
}

/**
 * Create a tempo map in which each detected beat lands exactly on a quarter note.
 *
 * @param beats Beat times in seconds, strictly increasing (at least 2).
 */
export function beatsToTempoMap(beatTimes: readonly number[], options: BeatsToTempoMapOptions = {}): TempoMap {
  const beats = options.clean ? cleanBeats(beatTimes) : beatTimes;
  const ppq = options.ppq ?? 480;
  const beatsPerBar = options.beatsPerBar ?? 4;
  const downbeatIndex = options.downbeatIndex ?? 0;

  if (!Number.isInteger(ppq) || ppq < 1 || ppq > 0x7fff) throw new RangeError("ppq must be an integer in 1..32767");
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) throw new RangeError("beatsPerBar must be a positive integer");
  if (beats.length < 2) throw new RangeError("at least two beats are required");
  if (!Number.isInteger(downbeatIndex) || downbeatIndex < 0 || downbeatIndex >= beats.length) {
    throw new RangeError("downbeatIndex must index into beats");
  }
  for (let i = 0; i < beats.length; i++) {
    if (!Number.isFinite(beats[i]) || beats[i]! < 0) throw new RangeError(`beat ${i} is not a non-negative number`);
    if (i > 0 && beats[i]! <= beats[i - 1]!) throw new RangeError(`beats must be strictly increasing (index ${i})`);
  }

  const first = beats[0]!;
  const typicalInterval = median(intervals(beats));

  // Quarter notes of lead-in before the first beat. The count comes from the
  // median interval (robust to a single odd first interval); a first beat
  // within half a beat of the start gets no lead-in and sits on tick 0.
  const leadIn = first > 1e-6 ? Math.round(first / typicalInterval) : 0;

  // If the chosen downbeat would not land on a bar line, open with a short
  // pickup bar (e.g. 2/4 before 4/4), the way a score notates an anacrusis.
  const pickup = (leadIn + downbeatIndex) % beatsPerBar;
  const timeSignatures: TimeSignature[] =
    pickup === 0
      ? [{ tick: 0, numerator: beatsPerBar, denominator: 4 }]
      : [
          { tick: 0, numerator: pickup, denominator: 4 },
          { tick: pickup * ppq, numerator: beatsPerBar, denominator: 4 },
        ];

  const rawEvents: Array<{ tick: number; usPerQuarter: number }> = [];
  if (leadIn > 0) rawEvents.push({ tick: 0, usPerQuarter: toUs(first / leadIn) });
  for (let i = 0; i < beats.length - 1; i++) {
    rawEvents.push({ tick: (leadIn + i) * ppq, usPerQuarter: toUs(beats[i + 1]! - beats[i]!) });
  }

  // Drop redundant events (same tempo as the previous one). Tick 0 is time 0
  // when there is a lead-in, otherwise the time of the first beat.
  const events: TempoEvent[] = [];
  let seconds = leadIn > 0 ? 0 : first;
  for (const ev of rawEvents) {
    const prev = events[events.length - 1];
    if (prev) {
      if (prev.usPerQuarter === ev.usPerQuarter) continue;
      seconds = prev.seconds + ((ev.tick - prev.tick) / ppq) * (prev.usPerQuarter / 1e6);
    }
    events.push({ tick: ev.tick, usPerQuarter: ev.usPerQuarter, bpm: US_PER_MINUTE / ev.usPerQuarter, seconds });
  }

  return { ppq, events, timeSignatures, firstBeatTick: leadIn * ppq, medianBpm: 60 / typicalInterval };
}

/**
 * A tempo map with a single fixed tempo. Useful as a baseline or when no beat
 * information is available.
 */
export function constantTempoMap(bpm: number, ppq = 480, beatsPerBar = 4): TempoMap {
  if (!(bpm > 0)) throw new RangeError("bpm must be positive");
  const usPerQuarter = toUs(60 / bpm);
  return {
    ppq,
    events: [{ tick: 0, usPerQuarter, bpm: US_PER_MINUTE / usPerQuarter, seconds: 0 }],
    timeSignatures: [{ tick: 0, numerator: beatsPerBar, denominator: 4 }],
    firstBeatTick: 0,
    medianBpm: bpm,
  };
}

/** Convert a time in seconds to a (fractional) tick position. Times before tick 0 map to 0. */
export function secondsToTicks(map: TempoMap, seconds: number): number {
  const ev = map.events[findIndex(map.events, (e) => e.seconds <= seconds)]!;
  return Math.max(0, ev.tick + ((seconds - ev.seconds) * 1e6 * map.ppq) / ev.usPerQuarter);
}

/** Convert a tick position to a time in seconds. */
export function ticksToSeconds(map: TempoMap, tick: number): number {
  const ev = map.events[findIndex(map.events, (e) => e.tick <= tick)]!;
  return ev.seconds + ((tick - ev.tick) / map.ppq) * (ev.usPerQuarter / 1e6);
}

function toUs(secondsPerQuarter: number): number {
  const us = Math.round(secondsPerQuarter * 1e6);
  if (us < 1 || us > MAX_US_PER_QUARTER) {
    throw new RangeError(`beat interval of ${secondsPerQuarter}s is outside the MIDI tempo range`);
  }
  return us;
}

/** Last index whose event satisfies `pred` (events are sorted); 0 if none do. */
function findIndex(events: readonly TempoEvent[], pred: (e: TempoEvent) => boolean): number {
  let lo = 0;
  let hi = events.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pred(events[mid]!)) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
