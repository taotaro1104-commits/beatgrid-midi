import { secondsToTicks, type TempoMap } from "./tempoMap.js";

/** A note with times in seconds, as produced by a transcription model. */
export interface TimedNote {
  /** MIDI note number (0–127). */
  pitch: number;
  /** Onset in seconds. */
  start: number;
  /** Offset in seconds. */
  end: number;
  /** MIDI velocity 1–127. If omitted, derived from `amplitude`, else 100. */
  velocity?: number;
  /** Model amplitude/confidence 0–1, mapped to velocity when `velocity` is absent. */
  amplitude?: number;
}

/** A note placed on the tick grid, ready to be written to a MIDI file. */
export interface TickNote {
  pitch: number;
  startTick: number;
  endTick: number;
  velocity: number;
}

export interface QuantizeOptions {
  /**
   * Grid as a note value: 4 = quarter, 8 = eighth, 16 = sixteenth, 12 = eighth-note triplet.
   * Default 16.
   */
  grid?: number;
  /**
   * 0 = keep the performed timing, 1 = snap fully to the grid. Values in between
   * move each note that fraction of the way toward the nearest grid line. Default 0.5.
   */
  strength?: number;
  /** Notes shorter than this (in milliseconds, before quantizing) are dropped. Default 0. */
  minDurationMs?: number;
  /** Also quantize note ends. Default true. */
  quantizeEnds?: boolean;
}

/**
 * Place notes on the tick grid defined by a tempo map.
 *
 * Because the grid comes from the tempo map, "the nearest 16th" means the
 * nearest 16th *of the beat the player was actually on*, even when the tempo drifts.
 */
export function quantizeNotes(notes: readonly TimedNote[], map: TempoMap, options: QuantizeOptions = {}): TickNote[] {
  const grid = options.grid ?? 16;
  const strength = options.strength ?? 0.5;
  const minDuration = (options.minDurationMs ?? 0) / 1000;
  const quantizeEnds = options.quantizeEnds ?? true;

  if (!(grid > 0)) throw new RangeError("grid must be positive");
  if (!(strength >= 0 && strength <= 1)) throw new RangeError("strength must be between 0 and 1");

  const step = (map.ppq * 4) / grid;
  const snap = (tick: number): number => {
    const target = Math.round(tick / step) * step;
    return Math.round(tick + (target - tick) * strength);
  };

  const out: TickNote[] = [];
  for (const n of notes) {
    if (!(n.end > n.start) || n.end - n.start < minDuration) continue;
    if (!Number.isInteger(n.pitch) || n.pitch < 0 || n.pitch > 127) continue;

    const startTick = Math.max(0, snap(secondsToTicks(map, n.start)));
    const rawEnd = secondsToTicks(map, n.end);
    let endTick = quantizeEnds ? snap(rawEnd) : Math.round(rawEnd);
    // A note snapped to zero length keeps at least one grid step (or one tick when unquantized).
    if (endTick <= startTick) endTick = startTick + Math.max(1, Math.round(step * strength));

    out.push({ pitch: n.pitch, startTick, endTick, velocity: velocityOf(n) });
  }
  out.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  return out;
}

function velocityOf(n: TimedNote): number {
  if (n.velocity !== undefined) return clampVelocity(n.velocity);
  if (n.amplitude !== undefined) return clampVelocity(Math.round(n.amplitude * 127));
  return 100;
}

function clampVelocity(v: number): number {
  return Math.min(127, Math.max(1, Math.round(v)));
}

/**
 * Shape of the note events returned by Spotify's Basic Pitch
 * (`noteFramesToTime(...)` in @spotify/basic-pitch).
 */
export interface BasicPitchNoteEvent {
  startTimeSeconds: number;
  durationSeconds: number;
  pitchMidi: number;
  amplitude: number;
}

/** Convert Basic Pitch note events into `TimedNote`s. No dependency on Basic Pitch itself. */
export function fromBasicPitch(events: readonly BasicPitchNoteEvent[]): TimedNote[] {
  return events.map((e) => ({
    pitch: e.pitchMidi,
    start: e.startTimeSeconds,
    end: e.startTimeSeconds + e.durationSeconds,
    amplitude: e.amplitude,
  }));
}
