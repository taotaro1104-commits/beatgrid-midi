import type { TickNote } from "./quantize.js";
import type { TempoMap } from "./tempoMap.js";

export interface MidiTrack {
  name?: string;
  /** MIDI channel 0–15. Use 9 for General MIDI drums. Default 0. */
  channel?: number;
  /** General MIDI program 0–127. Omit to send no Program Change. */
  program?: number;
  notes: readonly TickNote[];
}

export interface WriteMidiOptions {
  /** Name written to the conductor track. */
  title?: string;
}

/**
 * Write a Standard MIDI File (Type 1).
 * Track 0 is the conductor track (tempo map + time signature); each entry of
 * `tracks` becomes one further track.
 */
export function writeMidi(map: TempoMap, tracks: readonly MidiTrack[], options: WriteMidiOptions = {}): Uint8Array {
  const chunks: Uint8Array[] = [header(1, tracks.length + 1, map.ppq), conductorTrack(map, options.title)];
  for (const t of tracks) chunks.push(noteTrack(t));
  return concat(chunks);
}

interface Ev {
  tick: number;
  /** Lower sorts first at equal tick. */
  order: number;
  bytes: number[];
}

function conductorTrack(map: TempoMap, title?: string): Uint8Array {
  const evs: Ev[] = [];
  if (title) evs.push({ tick: 0, order: 0, bytes: meta(0x03, utf8(title)) });
  for (const ts of map.timeSignatures) {
    evs.push({ tick: ts.tick, order: 1, bytes: meta(0x58, [ts.numerator, Math.log2(ts.denominator), 24, 8]) });
  }
  for (const t of map.events) {
    const us = t.usPerQuarter;
    evs.push({ tick: t.tick, order: 2, bytes: meta(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]) });
  }
  return trackChunk(evs);
}

function noteTrack(track: MidiTrack): Uint8Array {
  const ch = track.channel ?? 0;
  if (!Number.isInteger(ch) || ch < 0 || ch > 15) throw new RangeError("channel must be 0..15");

  const evs: Ev[] = [];
  if (track.name) evs.push({ tick: 0, order: 0, bytes: meta(0x03, utf8(track.name)) });
  if (track.program !== undefined) evs.push({ tick: 0, order: 1, bytes: [0xc0 | ch, dataByte(track.program, 0, "program")] });

  // On one channel, a repeated pitch must be released before it sounds again,
  // otherwise the earlier Note Off would cut the later note short. A note that
  // starts at the same tick as the next one of its pitch is replaced by it.
  const notes = [...track.notes].sort((a, b) => a.startTick - b.startTick);
  const lastByPitch = new Map<number, { endTick: number; startTick: number; dropped: boolean }>();
  const trimmed: Array<{ pitch: number; startTick: number; endTick: number; velocity: number; dropped: boolean }> = [];
  for (const n of notes) {
    const prev = lastByPitch.get(n.pitch);
    if (prev && prev.endTick > n.startTick) {
      if (n.startTick > prev.startTick) prev.endTick = n.startTick;
      else prev.dropped = true;
    }
    const copy = { ...n, dropped: false };
    trimmed.push(copy);
    lastByPitch.set(n.pitch, copy);
  }
  for (const n of trimmed) {
    if (n.dropped || n.endTick <= n.startTick) continue;
    const pitch = dataByte(n.pitch, 0, "pitch");
    const velocity = dataByte(n.velocity, 1, "velocity");
    // Note Off (order 2) sorts before Note On (order 3) at the same tick.
    evs.push({ tick: n.startTick, order: 3, bytes: [0x90 | ch, pitch, velocity] });
    evs.push({ tick: n.endTick, order: 2, bytes: [0x80 | ch, pitch, 0] });
  }
  return trackChunk(evs);
}

/** A MIDI data byte: out-of-range values are clamped to `min`..127 (velocity 0 would mean Note Off). */
function dataByte(value: number, min: number, what: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be a finite number`);
  return Math.min(127, Math.max(min, Math.trunc(value)));
}

function trackChunk(evs: Ev[]): Uint8Array {
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data: number[] = [];
  let last = 0;
  for (const e of evs) {
    data.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  data.push(0x00, 0xff, 0x2f, 0x00); // End of Track
  return concat([ascii("MTrk"), u32(data.length), Uint8Array.from(data)]);
}

function header(format: number, ntrks: number, division: number): Uint8Array {
  return concat([ascii("MThd"), u32(6), u16(format), u16(ntrks), u16(division)]);
}

function meta(type: number, payload: number[]): number[] {
  return [0xff, type, ...vlq(payload.length), ...payload];
}

/** MIDI variable-length quantity. */
export function vlq(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) throw new RangeError(`bad delta time ${value}`);
  const out = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    out.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return out;
}

function u32(v: number): Uint8Array {
  return Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}
function u16(v: number): Uint8Array {
  return Uint8Array.of((v >>> 8) & 0xff, v & 0xff);
}
function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
function utf8(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
