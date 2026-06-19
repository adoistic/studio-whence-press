// zip.js — minimal ZIP writer (STORE / no compression). The payloads we bundle
// (PDF, TIFF, JPEG, PNG) are already compressed, so storing avoids pointless
// double-compression and keeps this tiny and deterministic.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name: string, bytes: Uint8Array }] -> Uint8Array (a valid .zip)
export function makeZip(files) {
  const enc = new TextEncoder();
  const DOS_TIME = 0, DOS_DATE = 0x2821;   // fixed timestamp (2000-01-01) — deterministic
  const locals = [], centrals = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.bytes;
    const crc = crc32(data);

    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);             // version needed
    lv.setUint16(6, 0, true);              // flags
    lv.setUint16(8, 0, true);              // method = store
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);   // compressed size
    lv.setUint32(22, data.length, true);   // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);             // extra len
    lh.set(name, 30);
    locals.push(lh, data);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);             // version made by
    cv.setUint16(6, 20, true);             // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);             // method = store
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);        // local header offset
    ch.set(name, 46);
    centrals.push(ch);

    offset += lh.length + data.length;
  }

  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);          // central dir offset

  let total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of [...locals, ...centrals, eocd]) { out.set(part, o); o += part.length; }
  return out;
}
