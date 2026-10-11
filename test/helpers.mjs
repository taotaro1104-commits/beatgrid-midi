// Minimal Standard MIDI File reader used only to verify writer output.
export function parseMidi(bytes) {
  let p = 0;
  const str = (n) => String.fromCharCode(...bytes.slice(p, (p += n)));
  const u32 = () => ((bytes[p++] << 24) | (bytes[p++] << 16) | (bytes[p++] << 8) | bytes[p++]) >>> 0;
  const u16 = () => (bytes[p++] << 8) | bytes[p++];
  const vlq = () => {
    let v = 0;
    let b;
    do {
      b = bytes[p++];
      v = (v << 7) | (b & 0x7f);
    } while (b & 0x80);
    return v;
  };

  if (str(4) !== "MThd") throw new Error("missing MThd");
  if (u32() !== 6) throw new Error("bad header length");
  const format = u16();
  const ntrks = u16();
  const division = u16();
  const tracks = [];
  for (let t = 0; t < ntrks; t++) {
    if (str(4) !== "MTrk") throw new Error("missing MTrk");
    const end = u32() + p;
    const events = [];
    let tick = 0;
    let ended = false;
    while (p < end) {
      tick += vlq();
      const status = bytes[p++];
      if (status === 0xff) {
        const type = bytes[p++];
        const len = vlq();
        const data = Array.from(bytes.slice(p, (p += len)));
        events.push({ tick, kind: "meta", type, data });
        if (type === 0x2f) ended = true;
      } else {
        const hi = status & 0xf0;
        const len = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
        const data = Array.from(bytes.slice(p, (p += len)));
        events.push({ tick, kind: "channel", status: hi, channel: status & 0x0f, data });
      }
    }
    if (!ended) throw new Error(`track ${t} has no End of Track`);
    if (p !== end) throw new Error(`track ${t} length mismatch`);
    tracks.push(events);
  }
  if (p !== bytes.length) throw new Error("trailing bytes");
  return { format, ntrks, division, tracks };
}

export const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
