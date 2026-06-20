// worker.js — owns the WASM colour engine off the main thread.
// Two paths:
//  • convert  — preview: converts a page, keeps its CMYK (capped set) so the
//               per-card TIFF/JPEG buttons work, and returns a soft-proof.
//  • streampage — stateless: converts one page and returns only the requested
//               artifacts (deflated PDF image / TIFF / JPEG / proof PNG), then
//               frees everything. This is the path the large-job streamers use,
//               so nothing accumulates regardless of page count.
import {
  instantiate, TYPE_RGB_8, TYPE_CMYK_8, INTENT_PERCEPTUAL,
  cmsFLAGS_BLACKPOINTCOMPENSATION,
} from "../vendor/lcms/lcms.js";
import { boost, kOnly, maxTAC, DEFAULTS } from "./engine.js";
import { buildCmykTIFF, deflate } from "./writers.js";
import { encodeCmykJpeg } from "./jpeg_cmyk.js";

let lcms, fwd, rev, iccBytes;
const store = []; // previewed pages only: { cmyk, width, height }

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

// RGBA (composited over white) → print-ready DeviceCMYK.
function toCmyk(rgba, width, height, settings) {
  const n = width * height;
  const px = rgba;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3] / 255;
    rgb[i * 3]     = Math.round(px[i * 4] * a + 255 * (1 - a));
    rgb[i * 3 + 1] = Math.round(px[i * 4 + 1] * a + 255 * (1 - a));
    rgb[i * 3 + 2] = Math.round(px[i * 4 + 2] * a + 255 * (1 - a));
  }
  const opt = { ...DEFAULTS, ...(settings || {}) };
  const boosted = boost(rgb, n, opt.sat, opt.con);
  const cmykRaw = Uint8Array.from(lcms.cmsDoTransform(fwd, boosted, n));
  return kOnly(cmykRaw, rgb, n, opt);
}

// CMYK → soft-proof PNG bytes (reverse transform + OffscreenCanvas encode).
async function proofPng(cmyk, width, height) {
  const n = width * height;
  const proofRgb = Uint8Array.from(lcms.cmsDoTransform(rev, cmyk, n));
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = proofRgb[i * 3]; rgba[i * 4 + 1] = proofRgb[i * 3 + 1];
    rgba[i * 4 + 2] = proofRgb[i * 3 + 2]; rgba[i * 4 + 3] = 255;
  }
  const oc = new OffscreenCanvas(width, height);
  oc.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await oc.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      iccBytes = new Uint8Array(m.icc);
      lcms = await instantiate();
      const srgb = lcms.cmsCreate_sRGBProfile();
      const dst = lcms.cmsOpenProfileFromMem(iccBytes, iccBytes.length);
      if (!dst) throw new Error("could not open ICC profile");
      fwd = lcms.cmsCreateTransform(srgb, TYPE_RGB_8, dst, TYPE_CMYK_8, INTENT_PERCEPTUAL, cmsFLAGS_BLACKPOINTCOMPENSATION);
      rev = lcms.cmsCreateTransform(dst, TYPE_CMYK_8, srgb, TYPE_RGB_8, INTENT_PERCEPTUAL, cmsFLAGS_BLACKPOINTCOMPENSATION);
      post({ type: "ready" });

    } else if (m.type === "reset") {
      store.length = 0;
      post({ type: "reset-done" });

    } else if (m.type === "convert") {              // preview path (keeps CMYK)
      const { id, rgba, width, height, settings } = m;
      const cmyk = toCmyk(new Uint8Array(rgba), width, height, settings);
      const index = store.push({ cmyk, width, height }) - 1;
      const proof = await proofPng(cmyk, width, height);
      post({ type: "converted", id, index, width, height, tac: maxTAC(cmyk, width * height), proof: proof.buffer }, [proof.buffer]);

    } else if (m.type === "streampage") {           // large-job path (stateless)
      const { id, rgba, width, height, settings, want, dpi } = m;
      const cmyk = toCmyk(new Uint8Array(rgba), width, height, settings);
      const out = { type: "page-done", id, width, height, tac: maxTAC(cmyk, width * height) };
      const transfer = [];
      if (want.includes("pdf"))   { const d = await deflate(cmyk);                              out.pdfImg = d.buffer; transfer.push(d.buffer); }
      if (want.includes("tiff"))  { const t = await buildCmykTIFF(cmyk, width, height, dpi, iccBytes); out.tiff = t.buffer; transfer.push(t.buffer); }
      if (want.includes("jpeg"))  { const j = encodeCmykJpeg(cmyk, width, height, 90);          out.jpeg = j.buffer; transfer.push(j.buffer); }
      if (want.includes("proof")) { const p = await proofPng(cmyk, width, height);              out.proof = p.buffer; transfer.push(p.buffer); }
      post(out, transfer);

    } else if (m.type === "tiff") {                 // per-card (previewed page)
      const p = store[m.index];
      const tiff = await buildCmykTIFF(p.cmyk, p.width, p.height, m.dpi, iccBytes);
      post({ type: "tiff-done", index: m.index, tiff: tiff.buffer }, [tiff.buffer]);

    } else if (m.type === "jpeg") {                 // per-card (previewed page)
      const p = store[m.index];
      const jpg = encodeCmykJpeg(p.cmyk, p.width, p.height, m.quality || 90);
      post({ type: "jpeg-done", index: m.index, jpeg: jpg.buffer }, [jpg.buffer]);
    }
  } catch (err) {
    post({ type: "error", id: m.id, message: String((err && err.message) || err) });
  }
};
