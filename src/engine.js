// engine.js — RGB → print-ready CMYK, a faithful port of the Studio Whence
// Python engine (boost → ICC transform → K-only black). Pure functions over
// pixel buffers; no DOM. The ICC transform itself is done by lcms-wasm in the
// worker — this file owns the two surrounding stages and the constants.
//
// Parity: validated byte-for-byte against the reference Python `to_cmyk`
// (boost matches Pillow ImageEnhance within ±1, which quantises away after the
// transform; the full pipeline output is identical).

// Tuned defaults for the flat-2D-cartoon palette; overridable per call.
export const DEFAULTS = Object.freeze({
  sat: 1.22,          // saturation pre-compensation
  con: 1.06,          // contrast pre-compensation
  neutralSpread: 26,  // max(R,G,B) - min(R,G,B) below this = neutral (text/black)
  darkGray: 128,      // neutral pixels darker than this are pushed toward solid K
  inkGray: 43,        // #2B2B2B body-text grey → the K value it must hit (100%)
});

// Pillow's RGB→L, ITU-R 601-2 in fixed point (matches PIL exactly).
const luma = (r, g, b) => (r * 19595 + g * 38470 + b * 7471 + 32768) >> 16;
// Pillow's Image.blend writes through a C (UINT8) cast: truncate toward zero, clip 0..255.
const clip8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : (v | 0));

// Pre-compensation: ImageEnhance.Color(sat) then ImageEnhance.Contrast(con).
// Input/onput: Uint8 RGB, length n*3. Returns a new Uint8Array.
export function boost(rgb, n, sat = DEFAULTS.sat, con = DEFAULTS.con) {
  // Color: blend(grayscale, image, sat) per channel.
  const c1 = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const d = luma(r, g, b);
    c1[i * 3]     = clip8(d + sat * (r - d));
    c1[i * 3 + 1] = clip8(d + sat * (g - d));
    c1[i * 3 + 2] = clip8(d + sat * (b - d));
  }
  // Contrast: blend(solid(mean), c1, con); mean = round(mean of L(c1)).
  let s = 0;
  for (let i = 0; i < n; i++) s += luma(c1[i * 3], c1[i * 3 + 1], c1[i * 3 + 2]);
  const m = Math.floor(s / n + 0.5);
  const c2 = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    c2[i * 3]     = clip8(m + con * (c1[i * 3] - m));
    c2[i * 3 + 1] = clip8(m + con * (c1[i * 3 + 1] - m));
    c2[i * 3 + 2] = clip8(m + con * (c1[i * 3 + 2] - m));
  }
  return c2;
}

// K-only black: force near-neutral pixels onto the K plate alone (C=M=Y=0),
// push dark neutrals (text + black linework) toward solid 100% K. Mutates a
// copy of the CMYK buffer in place. cmyk: Uint8 length n*4; rgb: original RGB n*3.
export function kOnly(cmyk, rgb, n, opt = DEFAULTS) {
  const { neutralSpread, darkGray, inkGray } = opt;
  const out = Uint8Array.from(cmyk);
  const scale = 255 / (255 - inkGray);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread < neutralSpread) {
      const gray = (r + g + b) / 3;
      let k = 255 - gray;
      if (gray < darkGray) k = Math.min(255, k * scale); // #2B2B2B → 100% K
      out[i * 4] = 0; out[i * 4 + 1] = 0; out[i * 4 + 2] = 0;
      out[i * 4 + 3] = Math.min(255, Math.max(0, k | 0));
    }
  }
  return out;
}

// Total Area Coverage (max total ink %) — the readout the printer cares about.
export function maxTAC(cmyk, n) {
  let mx = 0;
  for (let i = 0; i < n; i++) {
    const t = cmyk[i * 4] + cmyk[i * 4 + 1] + cmyk[i * 4 + 2] + cmyk[i * 4 + 3];
    if (t > mx) mx = t;
  }
  return Math.round((mx / 255) * 100);
}
