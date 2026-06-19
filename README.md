# Studio Whence — CMYK for print

Convert RGB artwork and PDFs to **print-ready CMYK**, entirely in your browser. Nothing is uploaded — every file you open is read, converted, and handed back on your own device.

**Live:** https://adoistic.github.io/studio-whence-press/

## What it does

Drop a PDF or images (PNG, JPG, TIFF, WebP). The app produces:

- **A combined DeviceCMYK PDF** — lossless (FlateDecode), one page per input page, in order.
- **A CMYK TIFF per image** — lossless, with the ICC profile embedded.
- **A soft-proof PNG** — an on-screen simulation of how the ink will look.

The conversion is **colour-managed**, not a naive channel swap:

1. **Pre-compensation** — a measured saturation and contrast lift before conversion, to claw back vibrancy that uncoated ink flattens.
2. **ICC transform** — sRGB → **PSO Uncoated v3 (FOGRA52)**, perceptual intent with black-point compensation, via LittleCMS compiled to WebAssembly.
3. **K-only black** — every near-neutral pixel is forced onto the black plate alone (C=M=Y=0); dark neutrals print as solid 100% K, so text and linework stay crisp with no four-colour misregistration.

The colour engine is bit-for-bit identical to the reference Python implementation it was ported from (validated against LittleCMS through Pillow).

## Privacy

There is no server and no backend. After the page loads, the app makes **no network requests**. You can confirm this in your browser's Network tab. The WebAssembly colour engine, the PDF rasteriser, and the ICC profile are all served as static files and run locally.

## Telling your printer

State the destination condition: **PSO Uncoated v3 (FOGRA52), DeviceCMYK, lossless.**

CMYK cannot equal a glowing RGB screen for the most saturated blues and greens — that is ink and paper, not the workflow. This gets as close as the paper physically allows, and far closer than a one-click convert.

## Notes

- **PDFs are rasterised** at a chosen DPI (300 default, 600 for fine linework) before conversion. Recolouring live vector text through an ICC profile is not feasible in the browser, so pages are rendered to high-resolution pixels and reassembled.
- For **coated** stock or a printer's own profile, swap `assets/fogra52.icc` and re-run.
- The bundled **PSO Uncoated v3 (FOGRA52)** ICC profile is freely redistributable (© ECI / Heidelberg).

## Development

Static site, no build step.

```bash
python3 -m http.server 8099      # serve
node _e2e.mjs                    # Playwright end-to-end (needs a local server running)
```

Vendored runtime (in `vendor/`): [lcms-wasm](https://www.npmjs.com/package/lcms-wasm) (LittleCMS) and [pdf.js](https://mozilla.github.io/pdf.js/).

---

Made by Adnan · Studio Whence.
