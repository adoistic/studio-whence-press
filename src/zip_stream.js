// zip_stream.js — write a ZIP (STORE method) incrementally to a sink. Each
// entry's full bytes are produced by the worker, so size + CRC are known before
// the local header; only small central-directory records accumulate in memory.

const enc = new TextEncoder();
const DOS_TIME = 0, DOS_DATE = 0x2821; // fixed 2000-01-01, deterministic

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipStreamWriter {
  constructor(sink) { this.sink = sink; this.pos = 0; this.central = []; }
  async _w(bytes) { await this.sink.write(bytes); this.pos += bytes.length; }

  // name: string, bytes: Uint8Array (already-compressed payload, stored verbatim)
  async add(name, bytes) {
    const nameBytes = enc.encode(name);
    const crc = crc32(bytes);
    const offset = this.pos;

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, DOS_TIME, true); lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, bytes.length, true); lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    await this._w(lh);
    await this._w(bytes);

    this.central.push({ nameBytes, crc, size: bytes.length, offset });
  }

  async finish() {
    const cdStart = this.pos;
    for (const e of this.central) {
      const ch = new Uint8Array(46 + e.nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, DOS_TIME, true); cv.setUint16(14, DOS_DATE, true);
      cv.setUint32(16, e.crc, true); cv.setUint32(20, e.size, true); cv.setUint32(24, e.size, true);
      cv.setUint16(28, e.nameBytes.length, true);
      cv.setUint32(42, e.offset, true);
      ch.set(e.nameBytes, 46);
      await this._w(ch);
    }
    const cdSize = this.pos - cdStart;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.central.length, true); ev.setUint16(10, this.central.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, cdStart, true);
    await this._w(eocd);
    await this.sink.close();
  }
}
