<div align="center">

# beatgrid-midi

**採譜したMIDIを、DAWの小節線にぴったり合わせる。**

検出したビート位置からMIDIのテンポマップを作り、そのグリッドに対してノートをクオンタイズし、
Standard MIDI File として書き出します。ブラウザでもNodeでも動作し、依存パッケージはゼロです。

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)
![types: included](https://img.shields.io/badge/types-TypeScript-3178c6.svg)

[English](README.md) · [**▶ 実際の動作を見る：Audio to MIDI**](https://midi.newlife-startup.com/)

</div>

---

## 解決したい問題

多くの「音声→MIDI変換」は、すべてのファイルを固定の120 BPMで書き出します。
実際の演奏はテンポが揺れるので、ノートがだんだんグリッドからずれていきます。
DAWの小節線が意味をなさなくなり、クオンタイズするとかえって崩れ、結局手作業で直すことになります。

```
検出したビート（だんだん速くなる）  ▼     ▼     ▼    ▼    ▼   ▼   ▼  ▼  ▼
固定 120 BPM のグリッド            |    |    |    |    |    |    |    |     ✗ ビートがグリッドから離れていく
beatgrid-midi のテンポマップ        |     |     |    |    |   |   |  |  |     ✓ グリッドがビートについていく
```

**beatgrid-midi** は、ビートトラッカーが見つけたビート位置をテンポチェンジとしてファイルに書き込みます。
これで **検出したビートがすべてちょうど4分音符の位置に来る** ようになり、DAWの小節線が演奏に追従します。
16分音符へのクオンタイズも「実際に弾いていた拍の16分」に対して行われます。

付属のサンプル（92→124 BPMへ加速する演奏）での比較：

| ファイル | テンポイベント数 | グリッドからの最大ズレ |
|---|---:|---:|
| 固定 120 BPM | 1 | 1拍の 49.2 % |
| beatgrid-midi | 64 | **0.0 %** |

これは、ブラウザだけで動く無料の変換ツール
[**Audio to MIDI**](https://midi.newlife-startup.com/)（音声はアップロードされません）の
テンポマップで使っている手法です。

---

## インストール

```sh
npm install beatgrid-midi
```

ESモジュールです。モダンブラウザ、各種バンドラー、Deno、Node 18以上で動作し、TypeScriptの型定義を同梱しています。

## 使い方

```js
import { beatsToTempoMap, quantizeNotes, writeMidi } from "beatgrid-midi";

// 1. ビート位置（秒）— 任意のビートトラッカーの出力
const beats = [0.42, 1.05, 1.66, 2.25, 2.83 /* … */];

// 2. ノート（秒）— 任意の採譜モデルの出力
const notes = [
  { pitch: 60, start: 0.43, end: 0.98, amplitude: 0.8 },
  { pitch: 64, start: 1.07, end: 1.60, amplitude: 0.7 },
];

const map = beatsToTempoMap(beats, { ppq: 480, beatsPerBar: 4 });
const tickNotes = quantizeNotes(notes, map, { grid: 16, strength: 0.5, minDurationMs: 50 });
const bytes = writeMidi(map, [{ name: "Piano", program: 0, notes: tickNotes }]);

// ブラウザ：ダウンロード
const url = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
// Node：fs.writeFileSync("out.mid", bytes)
```

### Spotify の Basic Pitch と組み合わせる

`fromBasicPitch()` で [Basic Pitch](https://github.com/spotify/basic-pitch-ts) のノートイベントをそのまま変換できます
（beatgrid-midi 自体は Basic Pitch に依存していません）。

```js
import { BasicPitch, noteFramesToTime, addPitchBendsToNoteEvents, outputToNotesPoly } from "@spotify/basic-pitch";
import { beatsToTempoMap, quantizeNotes, writeMidi, fromBasicPitch } from "beatgrid-midi";

const frames = [], onsets = [], contours = [];
await new BasicPitch(modelUrl).evaluateModel(audio22k, (f, o, c) => {
  frames.push(...f); onsets.push(...o); contours.push(...c);
}, () => {});
const events = noteFramesToTime(addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.25, 0.25, 5)));

const map = beatsToTempoMap(beats); // ビートトラッカーの出力
const midi = writeMidi(map, [{ name: "Transcription", notes: quantizeNotes(fromBasicPitch(events), map) }]);
```

> **ビート検出は含まれていません。** beatgrid-midi はビート位置を入力として受け取ります。
> ビート検出には、DSPのオンセット／テンポ検出、機械学習モデル、ユーザーのタップ入力など、好きな方法を使ってください。

## サンプルを動かす

```sh
npm install
npm run example   # examples/out/fixed-120.mid と examples/out/beatgrid.mid を出力
```

2つのファイルをDAWに読み込んで、小節線を見比べてみてください。

---

## API

### `beatsToTempoMap(beats, options?) → TempoMap`

| オプション | 既定値 | 説明 |
|---|---|---|
| `ppq` | `480` | 4分音符あたりのティック数 |
| `beatsPerBar` | `4` | 拍子の分子（分母は4） |
| `downbeatIndex` | `0` | 小節の頭にしたいビートの番号。必要に応じて冒頭に短い **弱起の小節**（4/4の前の2/4など）を入れ、このビートと、そこから `beatsPerBar` 拍ごとのビートが小節線上に来るようにします |

`beats` は秒単位で狭義単調増加、2個以上が必要です。
最初のビートより前の無音は、冒頭のテンポに近いテンポのリードインになります。同じテンポが続く場合はまとめられます。

戻り値は `{ ppq, events, timeSignatures, firstBeatTick }` で、各イベントは `tick`・`usPerQuarter`・`bpm`・`seconds` を持ちます。

### `constantTempoMap(bpm, ppq?, beatsPerBar?) → TempoMap`

固定テンポのマップです。比較用や、ビート情報がないときに使います。

### `secondsToTicks(map, seconds)` / `ticksToSeconds(map, tick)`

マップを使って秒とティックを相互変換します（ティックは小数、互いに厳密な逆変換）。

### `quantizeNotes(notes, map, options?) → TickNote[]`

| オプション | 既定値 | 説明 |
|---|---|---|
| `grid` | `16` | 音価：`4` 4分、`8` 8分、`16` 16分、`12` 8分3連… |
| `strength` | `0.5` | `0` は演奏のタイミングのまま、`1` は完全にスナップ。中間値は途中まで寄せます |
| `minDurationMs` | `0` | これより短いノートを（クオンタイズ前に）除去。採譜ノイズの除去に有効です |
| `quantizeEnds` | `true` | ノートの終わりもクオンタイズする |

入力ノート：`{ pitch, start, end, velocity? | amplitude? }`（秒。`amplitude` 0〜1 はベロシティに変換されます）

### `fromBasicPitch(events) → TimedNote[]`

Basic Pitch の `{ startTimeSeconds, durationSeconds, pitchMidi, amplitude }` を変換するアダプタです。

### `writeMidi(map, tracks, options?) → Uint8Array`

**SMF Type 1** を書き出します。トラック0にテンポマップと拍子、続いて `tracks` の各要素が1トラックずつ入ります
（`{ name?, channel?, program?, notes }`。GMドラムは `channel: 9`）。
同じティックではノートオフをノートオンより先に書き、同じ音程が重なった場合は前のノートを短くして、
後のノートが前のノートオフで切れないようにしています。

---

## 仕組み

1. **1ビート＝4分音符1つ。** 検出したビート *i* と *i+1* の間ごとに、ティック `i × ppq` の位置へ
   `usPerQuarter = (beat[i+1] − beat[i]) × 10⁶` のテンポイベントを書きます。
2. **リードイン。** 最初のビートまでの時間は、`round(最初のビート時刻 / 最初の間隔)` 個の4分音符で埋め、
   冒頭が極端なテンポにならないようにします。
3. **小節合わせ。** 指定したダウンビートが小節線に来ない場合は、楽譜の弱起（アウフタクト）と同じように最初の小節を短くします。
4. **秒ではなくティックでクオンタイズ。** ノートをマップでティックに変換してからスナップするので、グリッドが演奏に合わせて伸び縮みします。

テンポはMIDIの仕様どおり整数マイクロ秒で保存するため、丸め誤差は1ビートあたり最大0.5µsです。
10分の曲でも合計1ティック（480 ppq時）未満に収まります。

---

## ブラウザで動く音楽ツール群の一部です

[newlife-startup](https://newlife-startup.com/) が、音声をすべて端末内で処理する無料ツールを作る中で生まれたライブラリです。

- 🎹 [**Audio to MIDI**](https://midi.newlife-startup.com/) — テンポマップ付きのAI採譜
- 🛠 [**MIDI Forge**](https://midi.newlife-startup.com/forge/) — MIDIのヒューマナイズ、コード・ベース・ドラムの自動生成
- 🎚 [**AIマスタリング**](https://midi.newlife-startup.com/master/) — リファレンス曲に合わせた音作り、配信向けラウドネス
- 📼 [**古い録音の修復**](https://midi.newlife-startup.com/restore/) — ヒスノイズ、ハム、クリック、音割れの除去

## コントリビュート

Issue・プルリクエスト歓迎です。`npm test` でビルドとテスト（Node標準のテストランナー）が走ります。

## ライセンス

[MIT](LICENSE)
