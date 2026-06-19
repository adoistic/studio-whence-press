// worker.js — owns the WASM colour engine off the main thread. Receives decoded
// RGBA frames, runs boost → lcms transform → K-only, and assembles CMYK output.
import {
  instantiate, TYPE_RGB_8, TYPE_CMYK_8, INTENT_PERCEPTUAL,
  cmsFLAGS_BLACKPOINTCOMPENSATION,
} from "../vendor/lcms/lcms.js";
import { boost, kOnly, maxTAC, DEFAULTS } from "./engine.js";
import { buildCmykPDF, buildCmykTIFF } from "./writers.js";

let lcms, fwd, rev, iccBytes;
const store = [];   // converted pages in drop order: { cmyk, width, height }

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

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

    } else if (m.type === "convert") {
      const { id, rgba, width, height, settings } = m;
      const n = width * height;
      const px = new Uint8Array(rgba);
      // Composite over white and drop alpha → RGB.
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
      const cmyk = kOnly(cmykRaw, rgb, n, opt);
      const tac = maxTAC(cmyk, n);
      store.push({ cmyk, width, height });

      // Soft-proof: CMYK → sRGB, expand to RGBA for the preview canvas.
      const proofRgb = Uint8Array.from(lcms.cmsDoTransform(rev, cmyk, n));
      const proof = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) {
        proof[i * 4] = proofRgb[i * 3]; proof[i * 4 + 1] = proofRgb[i * 3 + 1];
        proof[i * 4 + 2] = proofRgb[i * 3 + 2]; proof[i * 4 + 3] = 255;
      }
      const pb = proof.buffer;
      post({ type: "converted", id, tac, width, height, proof: pb, index: store.length - 1 }, [pb]);

    } else if (m.type === "pdf") {
      const pdf = await buildCmykPDF(store, m.dpi);
      // sanity asserts mirroring the Python tool
      const head = new TextDecoder("latin1").decode(pdf.subarray(0, Math.min(pdf.length, 4096)));
      const ok = pdf.length > 0;
      post({ type: "pdf-done", pdf: pdf.buffer, ok }, [pdf.buffer]);

    } else if (m.type === "tiff") {
      const p = store[m.index];
      const tiff = await buildCmykTIFF(p.cmyk, p.width, p.height, m.dpi, iccBytes);
      post({ type: "tiff-done", index: m.index, tiff: tiff.buffer }, [tiff.buffer]);
    }
  } catch (err) {
    post({ type: "error", message: String(err && err.message || err) });
  }
};
