// A simulated live performance that speeds up from 92 to 124 BPM.
// Writes two files so you can open both in a DAW and compare:
//   fixed-120.mid  – what most converters produce (notes drift off the grid)
//   beatgrid.mid   – tempo map from the beats (bar lines follow the playing)
//
// Run: npm run example
import { writeFileSync, mkdirSync } from "node:fs";
import { beatsToTempoMap, constantTempoMap, quantizeNotes, writeMidi } from "../dist/index.js";

// Seeded random numbers so every run produces the same files.
let seed = 42;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

// 1. Beat times, as a beat tracker would report them (seconds).
const beats = [0.35];
for (let i = 1; i < 64; i++) {
  const bpm = 92 + (32 * i) / 64;
  beats.push(beats[i - 1] + 60 / bpm + (random() - 0.5) * 0.012);
}

// 2. Notes, as a transcription model would report them: an eighth-note
//    arpeggio played against those beats, with human timing noise.
const arp = [60, 64, 67, 72, 67, 64, 62, 65];
const notes = [];
for (let b = 0; b < beats.length - 1; b++) {
  const len = beats[b + 1] - beats[b];
  for (let k = 0; k < 2; k++) {
    const start = beats[b] + (k * len) / 2 + (random() - 0.5) * 0.02;
    notes.push({ pitch: arp[(b * 2 + k) % arp.length], start, end: start + len * 0.45, amplitude: 0.6 + 0.3 * (k === 0) });
  }
}

const options = { grid: 16, strength: 0.6, minDurationMs: 40 };
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });

for (const [name, map] of [
  ["fixed-120", constantTempoMap(120)],
  ["beatgrid", beatsToTempoMap(beats)],
]) {
  const midi = writeMidi(map, [{ name: "Arp", program: 0, notes: quantizeNotes(notes, map, options) }], { title: name });
  writeFileSync(new URL(`./out/${name}.mid`, import.meta.url), midi);

  // How far is each beat from the nearest quarter-note line in this file?
  const offGrid = beats.map((t) => {
    const tick = quantizeNotes([{ pitch: 60, start: t, end: t + 0.1 }], map, { strength: 0 })[0].startTick;
    const d = tick % map.ppq;
    return Math.min(d, map.ppq - d) / map.ppq;
  });
  const worst = Math.max(...offGrid);
  console.log(`${name.padEnd(10)} ${map.events.length.toString().padStart(3)} tempo events, worst beat offset ${(worst * 100).toFixed(1)}% of a beat`);
}
console.log("Wrote examples/out/fixed-120.mid and examples/out/beatgrid.mid");
