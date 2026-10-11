<div align="center">

# beatgrid-midi

**Make transcribed MIDI line up with the bars in your DAW.**

Turn detected beat times into a MIDI tempo map, quantize notes against *that* grid,
and write a Standard MIDI File — in the browser or Node, with zero dependencies.

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)
![types: included](https://img.shields.io/badge/types-TypeScript-3178c6.svg)

[日本語](README.ja.md) · [**▶ See it in action: Audio to MIDI**](https://midi.newlife-startup.com/en/)

</div>

---

## The problem

Most audio-to-MIDI converters write every file at a fixed 120 BPM.
Real performances speed up and slow down, so the notes slide off the grid:
bar lines in your DAW stop meaning anything, quantizing makes things *worse*,
and you end up dragging notes around by hand.

```
Detected beats (speeding up)   ▼     ▼     ▼    ▼    ▼   ▼   ▼  ▼  ▼
Fixed 120 BPM grid             |    |    |    |    |    |    |    |     ✗ beats drift away from the grid
beatgrid-midi tempo map        |     |     |    |    |   |   |  |  |     ✓ the grid follows the beats
```

**beatgrid-midi** takes the beat times your beat tracker found and writes them into the file
as tempo changes, so **each detected beat lands exactly on a quarter note**.
The DAW's bar lines now follow the player, and quantizing to 16ths means
"the nearest 16th of the beat they were actually on".

From the included example (a performance accelerating from 92 to 124 BPM):

| File | Tempo events | Worst beat offset from the grid |
|---|---:|---:|
| Fixed 120 BPM | 1 | 49.2 % of a beat |
| beatgrid-midi | 64 | **0.0 %** |

This is the technique behind the tempo map in
[**Audio to MIDI**](https://midi.newlife-startup.com/en/), a free converter that runs
entirely in the browser (your audio is never uploaded).

---

## Install

```sh
npm install beatgrid-midi
```

ES module, works in modern browsers, bundlers, Deno and Node ≥ 18. TypeScript types included.

## Quick start

```js
import { beatsToTempoMap, quantizeNotes, writeMidi } from "beatgrid-midi";

// 1. Beat times in seconds, from any beat tracker
const beats = [0.42, 1.05, 1.66, 2.25, 2.83 /* … */];

// 2. Notes in seconds, from any transcription model
const notes = [
  { pitch: 60, start: 0.43, end: 0.98, amplitude: 0.8 },
  { pitch: 64, start: 1.07, end: 1.60, amplitude: 0.7 },
];

const map = beatsToTempoMap(beats, { ppq: 480, beatsPerBar: 4 });
const tickNotes = quantizeNotes(notes, map, { grid: 16, strength: 0.5, minDurationMs: 50 });
const bytes = writeMidi(map, [{ name: "Piano", program: 0, notes: tickNotes }]);

// Browser: download it
const url = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
// Node: fs.writeFileSync("out.mid", bytes)
```

### With Spotify's Basic Pitch

`fromBasicPitch()` converts [Basic Pitch](https://github.com/spotify/basic-pitch-ts) note events
directly (beatgrid-midi does not depend on Basic Pitch):

```js
import { BasicPitch, noteFramesToTime, addPitchBendsToNoteEvents, outputToNotesPoly } from "@spotify/basic-pitch";
import { beatsToTempoMap, quantizeNotes, writeMidi, fromBasicPitch } from "beatgrid-midi";

const frames = [], onsets = [], contours = [];
await new BasicPitch(modelUrl).evaluateModel(audio22k, (f, o, c) => {
  frames.push(...f); onsets.push(...o); contours.push(...c);
}, () => {});
const events = noteFramesToTime(addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.25, 0.25, 5)));

const map = beatsToTempoMap(beats); // beats from your beat tracker
const midi = writeMidi(map, [{ name: "Transcription", notes: quantizeNotes(fromBasicPitch(events), map) }]);
```

> **Beat detection is not included.** beatgrid-midi starts from beat times.
> Use the beat tracker of your choice (a DSP onset/tempo tracker, an ML model, or taps from the user).

## Run the example

```sh
npm install
npm run example   # writes examples/out/fixed-120.mid and examples/out/beatgrid.mid
```

Drop both files into your DAW and look at the bar lines.

---

## API

### `beatsToTempoMap(beats, options?) → TempoMap`

| Option | Default | |
|---|---|---|
| `ppq` | `480` | Ticks per quarter note |
| `beatsPerBar` | `4` | Time signature numerator (denominator is 4) |
| `downbeatIndex` | `0` | Index of a beat that should start a bar. If needed, a short **pickup bar** (e.g. 2/4 before 4/4) is inserted at the start so this beat — and every `beatsPerBar`-th beat after it — falls on a bar line |

`beats` must be strictly increasing, in seconds, with at least two entries.
Silence before the first beat becomes a lead-in at roughly the opening tempo.
Consecutive identical tempos are merged.

Returns `{ ppq, events, timeSignatures, firstBeatTick }`; each event has `tick`, `usPerQuarter`, `bpm` and `seconds`.

### `constantTempoMap(bpm, ppq?, beatsPerBar?) → TempoMap`

A single fixed tempo — for comparison, or when you have no beats.

### `secondsToTicks(map, seconds)` / `ticksToSeconds(map, tick)`

Convert positions using the map (fractional ticks; exact inverses of each other).

### `quantizeNotes(notes, map, options?) → TickNote[]`

| Option | Default | |
|---|---|---|
| `grid` | `16` | Note value: `4` quarter, `8` eighth, `16` sixteenth, `12` eighth-note triplet… |
| `strength` | `0.5` | `0` keeps the performed timing, `1` snaps fully; values between move notes part of the way |
| `minDurationMs` | `0` | Drop notes shorter than this (before quantizing) — good for removing transcription noise |
| `quantizeEnds` | `true` | Quantize note ends as well as starts |

Input notes: `{ pitch, start, end, velocity? | amplitude? }` (seconds; `amplitude` 0–1 maps to velocity).

### `fromBasicPitch(events) → TimedNote[]`

Adapter for Basic Pitch's `{ startTimeSeconds, durationSeconds, pitchMidi, amplitude }`.

### `writeMidi(map, tracks, options?) → Uint8Array`

Writes **SMF Type 1**: track 0 holds the tempo map and time signatures, then one track per entry of
`tracks` (`{ name?, channel?, program?, notes }`; use `channel: 9` for GM drums).
Note Offs are written before Note Ons at the same tick, and overlapping repeats of the same pitch are
trimmed so a later note is never cut short by an earlier Note Off.

---

## How it works

1. **One beat = one quarter note.** For each interval between detected beats *i* and *i+1*, a Set Tempo
   event is written at tick `i × ppq` with `usPerQuarter = (beat[i+1] − beat[i]) × 10⁶`.
2. **Lead-in.** Time before the first beat is filled with `round(firstBeat / firstInterval)` quarters at
   a matching tempo, so the file doesn't open with an absurd tempo.
3. **Bar alignment.** If the chosen downbeat wouldn't land on a bar line, the first bar is shortened
   into a pickup — the same way a score notates an anacrusis.
4. **Quantize in ticks, not seconds.** Notes are converted to ticks through the map and snapped there,
   so the grid stretches with the performance.

Tempo is stored in whole microseconds (as the MIDI format requires), so rounding adds at most 0.5 µs
per beat — under one tick (at 480 ppq) even across a 10-minute song.

---

## Part of a set of browser-native music tools

Built by [newlife-startup](https://newlife-startup.com/) while making free tools that process audio
entirely on your device:

- 🎹 [**Audio to MIDI**](https://midi.newlife-startup.com/en/) — AI transcription with a beat-synced tempo map
- 🛠 [**MIDI Forge**](https://midi.newlife-startup.com/en/forge/) — humanize MIDI, generate chords, bass and drums
- 🎚 [**AI Mastering**](https://midi.newlife-startup.com/en/master/) — reference matching, streaming loudness targets
- 📼 [**Restore Old Recordings**](https://midi.newlife-startup.com/en/restore/) — remove hiss, hum, clicks and clipping

## Contributing

Issues and pull requests are welcome. `npm test` builds and runs the test suite (Node's built-in test runner).

## License

[MIT](LICENSE)
