// jpeg_cmyk.js — minimal baseline JPEG encoder for 4-component CMYK output with
// an Adobe APP14 marker (transform=0). Samples are stored inverted (255−x), the
// Photoshop/Adobe convention, so standard readers (Pillow, Acrobat) recover the
// original CMYK. Adapted from the public JPEG encoder lineage (Adobe → jpeg-js),
// trimmed to 4 single-sampled components sharing one luminance quant/Huffman set.

const ZIGZAG = [
  0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,
  35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63,
];
const STD_DC_NRCODES = [0,0,1,5,1,1,1,1,1,1,0,0,0,0,0,0,0];
const STD_DC_VALUES = [0,1,2,3,4,5,6,7,8,9,10,11];
const STD_AC_NRCODES = [0,0,2,1,3,3,2,4,3,5,5,4,4,0,0,1,0x7d];
const STD_AC_VALUES = [
  0x01,0x02,0x03,0x00,0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,0x22,0x71,0x14,0x32,
  0x81,0x91,0xa1,0x08,0x23,0x42,0xb1,0xc1,0x15,0x52,0xd1,0xf0,0x24,0x33,0x62,0x72,0x82,0x09,0x0a,0x16,
  0x17,0x18,0x19,0x1a,0x25,0x26,0x27,0x28,0x29,0x2a,0x34,0x35,0x36,0x37,0x38,0x39,0x3a,0x43,0x44,0x45,
  0x46,0x47,0x48,0x49,0x4a,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,0x69,
  0x6a,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7a,0x83,0x84,0x85,0x86,0x87,0x88,0x89,0x8a,0x92,0x93,0x94,
  0x95,0x96,0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,0xb5,0xb6,
  0xb7,0xb8,0xb9,0xba,0xc2,0xc3,0xc4,0xc5,0xc6,0xc7,0xc8,0xc9,0xca,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,
  0xd9,0xda,0xe1,0xe2,0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,
  0xf9,0xfa,
];
const STD_LUM_QT = [
  16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,
  18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99,
];

function huffTable(nrcodes, values) {
  const t = {}; let code = 0, k = 0;
  for (let i = 1; i <= 16; i++) { for (let j = 1; j <= nrcodes[i]; j++) { t[values[k]] = [code, i]; code++; k++; } code <<= 1; }
  return t;
}
function category() {
  const bits = new Array(65535), cat = new Array(65535);
  let nr = 1, nrlower = 1, nrupper = 2;
  for (let cl = 1; cl <= 15; cl++) {
    for (; nr < nrupper; nr++) { cat[32767 + nr] = cl; bits[32767 + nr] = [nr, cl]; }
    for (let n = -(nrupper - 1); n <= -nrlower; n++) { cat[32767 + n] = cl; bits[32767 + n] = [nrupper - 1 + n, cl]; }
    nrlower <<= 1; nrupper <<= 1;
  }
  return { bits, cat };
}
function quantTable(quality) {
  const sf = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  const fdtbl = new Float64Array(64), qt = new Int32Array(64);
  const aasf = [1.0,1.387039845,1.306562965,1.175875602,1.0,0.785694958,0.541196100,0.275899379];
  for (let i = 0; i < 64; i++) {
    let t = Math.floor((STD_LUM_QT[i] * sf + 50) / 100);
    t = t < 1 ? 1 : t > 255 ? 255 : t;
    qt[ZIGZAG[i]] = t;
  }
  let k = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { fdtbl[k] = 1 / (qt[ZIGZAG[k]] * aasf[r] * aasf[c] * 8); k++; }
  return { fdtbl, qt };
}

export function encodeCmykJpeg(cmyk, width, height, quality = 90) {
  const HDC = huffTable(STD_DC_NRCODES, STD_DC_VALUES);
  const HAC = huffTable(STD_AC_NRCODES, STD_AC_VALUES);
  const { bits, cat } = category();
  const { fdtbl, qt } = quantTable(quality);

  const out = []; let byte = 0, bitn = 7;
  const writeByte = (v) => out.push(v & 0xff);
  const writeWord = (v) => { writeByte(v >> 8); writeByte(v); };
  function writeBits(arr) {
    const val = arr[0]; let pos = arr[1] - 1;
    while (pos >= 0) {
      if (val & (1 << pos)) byte |= (1 << bitn);
      pos--; bitn--;
      if (bitn < 0) { if (byte === 0xff) { writeByte(0xff); writeByte(0); } else writeByte(byte); byte = 0; bitn = 7; }
    }
  }

  // FDCT (AAN) + quantise, returns zigzag-ordered quantised coeffs.
  function fdctQuant(data) {
    let d0,d1,d2,d3,d4,d5,d6,d7, off = 0;
    for (let i = 0; i < 8; i++) {
      d0=data[off];d1=data[off+1];d2=data[off+2];d3=data[off+3];d4=data[off+4];d5=data[off+5];d6=data[off+6];d7=data[off+7];
      const t0=d0+d7,t7=d0-d7,t1=d1+d6,t6=d1-d6,t2=d2+d5,t5=d2-d5,t3=d3+d4,t4=d3-d4;
      let t10=t0+t3,t13=t0-t3,t11=t1+t2,t12=t1-t2;
      data[off]=t10+t11;data[off+4]=t10-t11;
      let z1=(t12+t13)*0.707106781;data[off+2]=t13+z1;data[off+6]=t13-z1;
      t10=t4+t5;t11=t5+t6;t12=t6+t7;
      const z5=(t10-t12)*0.382683433,z2=0.541196100*t10+z5,z4=1.306562965*t12+z5,z3=t11*0.707106781;
      const z11=t7+z3,z13=t7-z3;
      data[off+5]=z13+z2;data[off+3]=z13-z2;data[off+1]=z11+z4;data[off+7]=z11-z4;
      off += 8;
    }
    off = 0;
    for (let i = 0; i < 8; i++) {
      d0=data[off];d1=data[off+8];d2=data[off+16];d3=data[off+24];d4=data[off+32];d5=data[off+40];d6=data[off+48];d7=data[off+56];
      const t0=d0+d7,t7=d0-d7,t1=d1+d6,t6=d1-d6,t2=d2+d5,t5=d2-d5,t3=d3+d4,t4=d3-d4;
      let t10=t0+t3,t13=t0-t3,t11=t1+t2,t12=t1-t2;
      data[off]=t10+t11;data[off+32]=t10-t11;
      let z1=(t12+t13)*0.707106781;data[off+16]=t13+z1;data[off+48]=t13-z1;
      t10=t4+t5;t11=t5+t6;t12=t6+t7;
      const z5=(t10-t12)*0.382683433,z2=0.541196100*t10+z5,z4=1.306562965*t12+z5,z3=t11*0.707106781;
      const z11=t7+z3,z13=t7-z3;
      data[off+40]=z13+z2;data[off+24]=z13-z2;data[off+8]=z11+z4;data[off+56]=z11-z4;
      off++;
    }
    const q = new Int32Array(64);
    for (let i = 0; i < 64; i++) q[i] = Math.round(data[i] * fdtbl[i]);
    return q;
  }

  const DU = new Float64Array(64);
  function processDU(comp, x0, y0, prevDC) {
    // gather 8x8 block of one channel (comp index 0..3), inverted (Adobe), edge-extended.
    for (let r = 0; r < 8; r++) {
      const yy = Math.min(y0 + r, height - 1);
      for (let c = 0; c < 8; c++) {
        const xx = Math.min(x0 + c, width - 1);
        const v = cmyk[(yy * width + xx) * 4 + comp];
        DU[r * 8 + c] = (255 - v) - 128;     // invert + level shift
      }
    }
    const q = fdctQuant(DU);
    // DC
    const diff = q[0] - prevDC;
    if (diff === 0) writeBits(HDC[0]); else { const t = bits[32767 + diff]; writeBits(HDC[cat[32767 + diff]]); writeBits(t); }
    // AC
    let end = 63; while (end > 0 && q[ZIGZAG[end]] === 0) end--;
    if (end === 0) { writeBits(HAC[0x00]); return q[0]; }
    let k = 1;
    while (k <= end) {
      const start = k;
      while (k <= end && q[ZIGZAG[k]] === 0) k++;
      let run = k - start;
      while (run > 15) { writeBits(HAC[0xf0]); run -= 16; }
      const val = q[ZIGZAG[k]]; const ct = cat[32767 + val];
      writeBits(HAC[(run << 4) + ct]); writeBits(bits[32767 + val]);
      k++;
    }
    if (end !== 63) writeBits(HAC[0x00]);
    return q[0];
  }

  // ---- markers ----
  writeWord(0xffd8);                                   // SOI
  // APP14 Adobe
  writeWord(0xffee); writeWord(14); "Adobe".split("").forEach((ch) => writeByte(ch.charCodeAt(0)));
  writeWord(100); writeWord(0); writeWord(0); writeByte(0); // version, flags0, flags1, transform=0
  // DQT
  writeWord(0xffdb); writeWord(67); writeByte(0); for (let i = 0; i < 64; i++) writeByte(qt[ZIGZAG[i]]);
  // SOF0 — 4 components, 1x1 each, quant table 0
  writeWord(0xffc0); writeWord(8 + 3 * 4); writeByte(8); writeWord(height); writeWord(width); writeByte(4);
  for (let id = 1; id <= 4; id++) { writeByte(id); writeByte(0x11); writeByte(0); }
  // DHT (luminance DC + AC) — segment length = 2 + (1+16+12) + (1+16+162) = 210
  writeWord(0xffc4); writeWord(210);
  writeByte(0); for (let i = 0; i < 16; i++) writeByte(STD_DC_NRCODES[i + 1]); for (const v of STD_DC_VALUES) writeByte(v);
  writeByte(0x10); for (let i = 0; i < 16; i++) writeByte(STD_AC_NRCODES[i + 1]); for (const v of STD_AC_VALUES) writeByte(v);
  // SOS
  writeWord(0xffda); writeWord(6 + 2 * 4); writeByte(4);
  for (let id = 1; id <= 4; id++) { writeByte(id); writeByte(0x00); }   // DC table 0, AC table 0
  writeByte(0); writeByte(63); writeByte(0);

  // ---- entropy ----
  const DC = [0, 0, 0, 0];
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      for (let comp = 0; comp < 4; comp++) DC[comp] = processDU(comp, x, y, DC[comp]);
    }
  }
  // flush
  if (bitn !== 7) writeBits([0x7f, bitn + 1]);
  writeWord(0xffd9);                                   // EOI
  return new Uint8Array(out);
}
