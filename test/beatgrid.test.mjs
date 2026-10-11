import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beatsToTempoMap,
  constantTempoMap,
  secondsToTicks,
  ticksToSeconds,
  quantizeNotes,
  fromBasicPitch,
  writeMidi,
} from "../dist/index.js";
import { parseMidi, approx } from "./helpers.mjs";

const steadyBeats = (bpm, n, offset = 0) => Array.from({ length: n }, (_, i) => offset + (i * 60) / bpm);

test("steady beats collapse to a single tempo event", () => {
  const map = beatsToTempoMap(steadyBeats(120, 16));
  assert.equal(map.events.length, 1);
  assert.equal(map.events[0].usPerQuarter, 500000);
  assert.equal(map.events[0].bpm, 120);
  assert.equal(map.firstBeatTick, 0);
});

test("every detected beat lands exactly on a quarter note", () => {
  // Performance that speeds up from ~96 to ~132 BPM with some jitter.
  const beats = [0.73];
  for (let i = 1; i < 40; i++) {
    const bpm = 96 + (36 * i) / 40 + Math.sin(i * 1.7) * 2;
    beats.push(beats[i - 1] + 60 / bpm);
  }
  const map = beatsToTempoMap(beats, { ppq: 960 });
  beats.forEach((t, i) => {
    const tick = secondsToTicks(map, t);
    const expected = map.firstBeatTick + i * 960;
    // Tempo is stored in whole microseconds, so allow a tiny rounding error.
    assert.ok(Math.abs(tick - expected) < 0.05, `beat ${i}: ${tick} vs ${expected}`);
  });
});

/** True if `tick` falls on a bar line under the map's time signatures. */
function onBarLine(map, tick) {
  const ts = map.timeSignatures.filter((t) => t.tick <= tick).at(-1);
  return (tick - ts.tick) % ((ts.numerator * 4 * map.ppq) / ts.denominator) === 0;
}

test("lead-in before the first beat keeps the tempo and opens with a pickup bar", () => {
  const map = beatsToTempoMap(steadyBeats(120, 8, 1.0)); // first beat at 1.0 s, 0.5 s per beat
  assert.equal(map.firstBeatTick, 2 * 480); // two quarters of lead-in
  assert.equal(map.events.length, 1); // lead-in is also 120 BPM, so no extra tempo event
  assert.deepEqual(map.timeSignatures, [
    { tick: 0, numerator: 2, denominator: 4 },
    { tick: 960, numerator: 4, denominator: 4 },
  ]);
  assert.ok(onBarLine(map, map.firstBeatTick));
  assert.ok(approx(ticksToSeconds(map, map.firstBeatTick), 1.0, 1e-6));
});

test("downbeatIndex puts the chosen beat on a bar line", () => {
  const beats = steadyBeats(100, 12, 0.6); // 0.6 s per beat; one quarter of lead-in
  for (const downbeatIndex of [0, 1, 2, 3, 5]) {
    const map = beatsToTempoMap(beats, { downbeatIndex, beatsPerBar: 4 });
    const tick = map.firstBeatTick + downbeatIndex * map.ppq;
    assert.ok(onBarLine(map, tick), `downbeatIndex ${downbeatIndex}`);
    // Every 4th beat after it is a bar line too.
    assert.ok(onBarLine(map, tick + 4 * map.ppq));
    assert.ok(approx(ticksToSeconds(map, tick), beats[downbeatIndex], 1e-5));
  }
});

test("3/4 with the first beat at time zero", () => {
  const map = beatsToTempoMap(steadyBeats(90, 9), { beatsPerBar: 3, downbeatIndex: 1 });
  assert.equal(map.firstBeatTick, 0);
  assert.deepEqual(map.timeSignatures.map((t) => [t.tick, t.numerator]), [[0, 1], [480, 3]]);
  assert.ok(onBarLine(map, 480));
});

test("seconds <-> ticks round-trips", () => {
  const map = beatsToTempoMap([0.2, 0.7, 1.15, 1.7, 2.2, 2.65]);
  for (const s of [0, 0.1, 0.5, 1.0, 2.0, 3.5]) {
    assert.ok(approx(ticksToSeconds(map, secondsToTicks(map, s)), s, 1e-9));
  }
});

test("rejects bad input", () => {
  assert.throws(() => beatsToTempoMap([1]), RangeError);
  assert.throws(() => beatsToTempoMap([1, 1]), RangeError);
  assert.throws(() => beatsToTempoMap([2, 1]), RangeError);
  assert.throws(() => beatsToTempoMap([0, 0.5], { downbeatIndex: 5 }), RangeError);
});

test("quantize strength 0 keeps timing, 1 snaps to the grid", () => {
  const map = constantTempoMap(120); // 480 ppq, 16th = 120 ticks = 0.125 s
  const note = { pitch: 60, start: 0.27, end: 0.52, velocity: 90 }; // 259.2 / 499.2 ticks
  const [loose] = quantizeNotes([note], map, { strength: 0 });
  assert.deepEqual(loose, { pitch: 60, startTick: 259, endTick: 499, velocity: 90 });
  const [tight] = quantizeNotes([note], map, { strength: 1 });
  assert.deepEqual(tight, { pitch: 60, startTick: 240, endTick: 480, velocity: 90 });
  const [half] = quantizeNotes([note], map, { strength: 0.5 });
  assert.equal(half.startTick, 250);
});

test("quantize follows a drifting tempo", () => {
  // Second beat interval is much slower; a note on its "and" should still snap to the 8th.
  const beats = [0, 0.5, 1.5, 2.0];
  const map = beatsToTempoMap(beats);
  const [n] = quantizeNotes([{ pitch: 64, start: 1.0 + 0.01, end: 1.4 }], map, { grid: 8, strength: 1 });
  assert.equal(n.startTick, 480 + 240);
});

test("minDurationMs drops short notes and amplitude maps to velocity", () => {
  const map = constantTempoMap(120);
  const out = quantizeNotes(
    [
      { pitch: 60, start: 0, end: 0.03, amplitude: 0.9 },
      { pitch: 62, start: 0, end: 0.5, amplitude: 0.5 },
    ],
    map,
    { minDurationMs: 50 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].pitch, 62);
  assert.equal(out[0].velocity, 64);
});

test("fromBasicPitch converts note events", () => {
  const notes = fromBasicPitch([{ startTimeSeconds: 1, durationSeconds: 0.5, pitchMidi: 67, amplitude: 0.4 }]);
  assert.deepEqual(notes, [{ pitch: 67, start: 1, end: 1.5, amplitude: 0.4 }]);
});

test("writes a valid Type 1 file with tempo map and notes", () => {
  const map = beatsToTempoMap([0, 0.5, 1.1, 1.6], { ppq: 480 });
  const notes = [
    { pitch: 60, startTick: 0, endTick: 480, velocity: 100 },
    { pitch: 64, startTick: 480, endTick: 960, velocity: 80 },
  ];
  const bytes = writeMidi(map, [{ name: "Piano", program: 0, notes }], { title: "Demo" });
  const midi = parseMidi(bytes);

  assert.equal(midi.format, 1);
  assert.equal(midi.ntrks, 2);
  assert.equal(midi.division, 480);

  const tempos = midi.tracks[0].filter((e) => e.kind === "meta" && e.type === 0x51);
  assert.deepEqual(
    tempos.map((e) => [e.tick, (e.data[0] << 16) | (e.data[1] << 8) | e.data[2]]),
    map.events.map((e) => [e.tick, e.usPerQuarter]),
  );
  const ts = midi.tracks[0].find((e) => e.kind === "meta" && e.type === 0x58);
  assert.deepEqual(ts.data, [4, 2, 24, 8]);

  const ons = midi.tracks[1].filter((e) => e.status === 0x90);
  const offs = midi.tracks[1].filter((e) => e.status === 0x80);
  assert.deepEqual(ons.map((e) => [e.tick, ...e.data]), [[0, 60, 100], [480, 64, 80]]);
  assert.deepEqual(offs.map((e) => [e.tick, e.data[0]]), [[480, 60], [960, 64]]);

  // Note Off for 60 must come before Note On for 64 at tick 480.
  const at480 = midi.tracks[1].filter((e) => e.tick === 480 && e.kind === "channel");
  assert.equal(at480[0].status, 0x80);
});

test("overlapping repeats of the same pitch are trimmed, not cut short", () => {
  const map = constantTempoMap(120);
  const bytes = writeMidi(map, [
    {
      notes: [
        { pitch: 60, startTick: 0, endTick: 600, velocity: 100 },
        { pitch: 60, startTick: 480, endTick: 960, velocity: 100 },
      ],
    },
  ]);
  const ev = parseMidi(bytes).tracks[1].filter((e) => e.kind === "channel");
  assert.deepEqual(
    ev.map((e) => [e.tick, e.status]),
    [
      [0, 0x90],
      [480, 0x80],
      [480, 0x90],
      [960, 0x80],
    ],
  );
});

test("drums on channel 10 and long delta times encode correctly", () => {
  const map = constantTempoMap(90);
  const bytes = writeMidi(map, [{ channel: 9, notes: [{ pitch: 36, startTick: 200000, endTick: 200100, velocity: 110 }] }]);
  const on = parseMidi(bytes).tracks[1].find((e) => e.status === 0x90);
  assert.equal(on.channel, 9);
  assert.equal(on.tick, 200000);
});
