// app.js — UI + lazy decoding on the main thread; colour conversion in the
// worker. Large jobs never accumulate: only a small preview set is held; the
// PDF and zip downloads stream page-by-page to disk (File System Access API),
// so memory stays flat across thousands of pages.
import * as pdfjs from "../vendor/pdfjs/pdf.mjs";
import { createSink, fsAccessAvailable } from "./sink.js";
import { PdfStreamWriter } from "./pdf_stream.js";
import { ZipStreamWriter } from "./zip_stream.js";
pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;

const $ = (s) => document.querySelector(s);
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const setState = (s) => { document.body.dataset.state = s; };
const PREVIEW_CAP = 12;

let ready = false;
let selectedFiles = [];   // the File objects (decoded lazily, never all at once)
let totalPages = 0;
// (preview proofs are held per-card via closures; nothing global to accumulate)
let streaming = false, cancelStream = false;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject }

class CancelError extends Error {}

// ---- worker plumbing ----
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "ready") { ready = true; setState("empty"); }
  else if (m.type === "converted" || m.type === "page-done") { pending.get(m.id)?.resolve(m); pending.delete(m.id); }
  else if (m.type === "error") {
    if (m.id != null && pending.has(m.id)) { pending.get(m.id).reject(new Error(m.message)); pending.delete(m.id); }
    else { setStatus("Something went wrong: " + m.message, { bad: true }); setState("error"); }
    console.error(m.message);
  }
  else if (m.type === "tiff-done") { saveBytes(m.tiff, "image/tiff", m.name); }
  else if (m.type === "jpeg-done") { saveBytes(m.jpeg, "image/jpeg", m.name); }
};
const call = (msg, transfer) => new Promise((resolve, reject) => { pending.set(msg.id, { resolve, reject }); worker.postMessage(msg, transfer || []); });

(async function init() {
  const icc = await (await fetch("./assets/fogra52.icc")).arrayBuffer();
  worker.postMessage({ type: "init", icc }, [icc]);
})();

const settings = () => ({ dpi: parseInt($("#dpi").value, 10) || 300, sat: parseFloat($("#sat").value), con: parseFloat($("#con").value) });
const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isSupported = (f) => /image\/|pdf/.test(f.type) || /\.(png|jpe?g|tiff?|webp|pdf)$/i.test(f.name);

// ---- decoding (one page at a time) ----
async function openPdf(file) { return pdfjs.getDocument({ data: await file.arrayBuffer() }).promise; }

function frameFromCanvas(c, name, wantThumb) {
  const rgba = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const frame = { name, width: c.width, height: c.height, rgba };
  if (wantThumb) frame.thumbURL = makeThumb(c);
  return frame;
}
function makeThumb(c) {
  const W = 264, scale = Math.min(1, W / c.width);
  const t = document.createElement("canvas");
  t.width = Math.max(1, Math.round(c.width * scale)); t.height = Math.max(1, Math.round(c.height * scale));
  t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
  return t.toDataURL("image/png");
}
async function renderPdfPage(doc, i, name, wantThumb) {
  const page = await doc.getPage(i);
  const vp = page.getViewport({ scale: settings().dpi / 72 });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return frameFromCanvas(c, name, wantThumb);
}
async function decodeImage(file, wantThumb) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d", { willReadFrequently: true }).drawImage(bmp, 0, 0);
  bmp.close?.();
  return frameFromCanvas(c, file.name, wantThumb);
}

// Walk every page of every file lazily, calling cb(frame, index). Decodes one
// page at a time and frees it; never materialises the whole job.
async function eachPage(cb, wantThumb) {
  let idx = 0;
  for (const f of selectedFiles) {
    if (isPdf(f)) {
      const doc = await openPdf(f);
      const base = f.name.replace(/\.[^.]+$/, ""), pad = String(doc.numPages).length;
      for (let i = 1; i <= doc.numPages; i++) {
        await cb(await renderPdfPage(doc, i, `${base} · p${String(i).padStart(pad, "0")}`, wantThumb), ++idx);
      }
      await doc.destroy();
    } else {
      await cb(await decodeImage(f, wantThumb), ++idx);
    }
  }
}

// ---- file selection → preview the first PREVIEW_CAP pages ----
async function onFiles(fileList) {
  if (!ready) { setStatus("The colour engine is still loading — one moment…", { spin: true }); return; }
  const files = [...fileList].filter(isSupported);
  if (!files.length) { setStatus("Please drop PDF, PNG, JPG, TIFF or WebP files.", { bad: true }); setState("error"); return; }

  selectedFiles = files;
  setState("working"); setStatus("Reading files…", { spin: true });
  $("#results").innerHTML = ""; $("#dl-status").textContent = "";
  worker.postMessage({ type: "reset" });
  totalPages = 0;
  let previewed = 0;
  try {
    for (const f of files) {
      const pdf = isPdf(f) ? await openPdf(f) : null;
      const count = pdf ? pdf.numPages : 1;
      totalPages += count;
      for (let i = 1; i <= count && previewed < PREVIEW_CAP; i++) {
        setStatus(`Preparing preview ${previewed + 1}…`, { spin: true });
        const base = pdf ? f.name.replace(/\.[^.]+$/, "") : f.name;
        const name = pdf ? `${base} · p${String(i).padStart(String(count).length, "0")}` : base;
        const frame = pdf ? await renderPdfPage(pdf, i, name, true) : await decodeImage(f, true);
        await previewConvert(frame);
        previewed++;
      }
      await pdf?.destroy();
    }
  } catch (err) { setStatus("Could not read files: " + err.message, { bad: true }); setState("error"); return; }

  $("#done-count").textContent = `${totalPages} page${totalPages === 1 ? "" : "s"} ready`;
  $("#preview-note").textContent = totalPages > previewed
    ? `Previewing the first ${previewed}. All ${totalPages} pages are included when you download.` : "";
  setState("done");
}

async function previewConvert(frame) {
  const opt = settings();
  const res = await call({ type: "convert", id: ++seq, rgba: frame.rgba.buffer, width: frame.width, height: frame.height, settings: { sat: opt.sat, con: opt.con } }, [frame.rgba.buffer]);
  renderResult(frame, res);
}

// ---- preview cards ----
function renderResult(frame, res) {
  const proofBlob = new Blob([res.proof], { type: "image/png" });   // worker returns encoded PNG
  const proofURL = URL.createObjectURL(proofBlob);
  const base = stem(frame.name);

  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    <div class="card-body">
      <div class="card-name">${escapeHtml(frame.name)} <span class="tac">TAC ≤ ${res.tac}%</span></div>
      <div class="card-fmts">
        <button data-tiff>CMYK TIFF</button>
        <button data-jpeg>CMYK JPEG</button>
        <button data-png>Soft-proof PNG</button>
      </div>
    </div>`;
  card.prepend(makeCompare(frame.thumbURL, proofURL, res.width, res.height));
  card.querySelector("[data-tiff]").onclick = () => worker.postMessage({ type: "tiff", index: res.index, dpi: settings().dpi, name: `${base}-CMYK-FOGRA52.tiff` });
  card.querySelector("[data-jpeg]").onclick = () => worker.postMessage({ type: "jpeg", index: res.index, quality: 90, name: `${base}-CMYK-FOGRA52.jpg` });
  card.querySelector("[data-png]").onclick = () => saveBlob(proofBlob, `${base}-CMYK-proof.png`);
  $("#results").appendChild(card);
}

function makeCompare(rgbURL, cmykURL, w, h) {
  const W = 132, H = Math.max(60, Math.round((W * h) / w));
  const box = document.createElement("div");
  box.className = "compare"; box.style.width = W + "px"; box.style.height = H + "px";
  box.innerHTML = `
    <img class="cmp-img" src="${cmykURL}" alt="CMYK proof" draggable="false">
    <div class="cmp-top"><img class="cmp-img" src="${rgbURL}" style="width:${W}px" alt="original" draggable="false"></div>
    <div class="cmp-line"><span class="cmp-grip"></span></div>
    <span class="cmp-tag cmp-l">RGB</span><span class="cmp-tag cmp-r">CMYK</span>`;
  const top = box.querySelector(".cmp-top"), line = box.querySelector(".cmp-line");
  const set = (p) => { p = Math.max(0, Math.min(100, p)); top.style.width = p + "%"; line.style.left = p + "%"; };
  set(50);
  const move = (x) => { const r = box.getBoundingClientRect(); set(((x - r.left) / r.width) * 100); };
  box.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.buttons) move(e.clientX); });
  box.addEventListener("pointerdown", (e) => { box.setPointerCapture(e.pointerId); move(e.clientX); });
  return box;
}

// ---- streaming downloads (the scalable path) ----
async function download(kind) {
  if (streaming || !selectedFiles.length) return;
  let sink;
  try { sink = await createSink(outName(kind)); }
  catch (e) { if (e.name !== "AbortError") setDl("Could not open the save dialog: " + e.message, true); return; }

  streaming = true; cancelStream = false; toggleBusy(true);
  if (!fsAccessAvailable()) setDl("Preparing download… (this browser holds it in memory; for huge jobs use Chrome)");
  const opt = settings();
  const writer = kind === "pdf" ? new PdfStreamWriter(sink) : new ZipStreamWriter(sink);
  const used = new Set();
  try {
    await eachPage(async (frame, idx) => {
      if (cancelStream) throw new CancelError();
      setDl(`Converting page ${idx} of ${totalPages}…`, false, idx / totalPages);
      const want = kind === "pdf" ? ["pdf"] : ["tiff", "jpeg", "proof"];
      const res = await call({ type: "streampage", id: ++seq, rgba: frame.rgba.buffer, width: frame.width, height: frame.height, settings: { sat: opt.sat, con: opt.con }, want, dpi: opt.dpi }, [frame.rgba.buffer]);
      if (kind === "pdf") {
        await writer.addPage({ imgDeflated: new Uint8Array(res.pdfImg), width: res.width, height: res.height, dpi: opt.dpi });
      } else {
        const base = uniq(used, stem(frame.name));
        await writer.add(`${base}-CMYK-FOGRA52.tiff`, new Uint8Array(res.tiff));
        await writer.add(`${base}-CMYK-FOGRA52.jpg`, new Uint8Array(res.jpeg));
        await writer.add(`${base}-CMYK-proof.png`, new Uint8Array(res.proof));
      }
    });
    await writer.finish();
    setDl(`Saved ${totalPages} page${totalPages === 1 ? "" : "s"} ✓`, false, 1);
  } catch (err) {
    await sink.abort?.();
    setDl(err instanceof CancelError ? "Download cancelled." : "Download failed: " + err.message, !(err instanceof CancelError));
  } finally { streaming = false; toggleBusy(false); }
}

// ---- buttons ----
$("#dl-pdf").onclick = () => download("pdf");
$("#dl-zip").onclick = () => download("zip");
$("#dl-cancel").onclick = () => { cancelStream = true; };
$("#clear").onclick = () => { if (streaming) return; selectedFiles = []; totalPages = 0; $("#results").innerHTML = ""; $("#dl-status").textContent = ""; $("#preview-note").textContent = ""; worker.postMessage({ type: "reset" }); setState("empty"); };

// ---- names & saving ----
const jobBase = () => selectedFiles[0]
  ? selectedFiles[0].name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_") : "studio-whence";
function outName(kind) { return kind === "pdf" ? `${jobBase()}-CMYK-FOGRA52.pdf` : `${jobBase()}-CMYK-FOGRA52.zip`; }
function uniq(set, base) { let n = base, i = 1; while (set.has(n)) n = `${base}-${++i}`; set.add(n); return n; }
function saveBytes(buf, mime, name) { saveBlob(new Blob([buf], { type: mime }), name); }
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

// ---- helpers ----
const stem = (n) => n.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_");
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function setStatus(t, { bad = false, spin = false } = {}) {
  const el = $("#status"); el.innerHTML = (spin ? '<span class="spin"></span>' : "") + escapeHtml(t); el.classList.toggle("bad", bad);
}
function setDl(t, bad = false, frac = null) {
  $("#dl-status").textContent = t; $("#dl-status").classList.toggle("bad", bad);
  const bar = $("#dl-bar"); bar.hidden = frac == null; if (frac != null) $("#dl-bar-fill").style.width = Math.round(frac * 100) + "%";
}
function toggleBusy(on) {
  for (const id of ["#dl-pdf", "#dl-zip", "#clear"]) $(id).disabled = on;
  $("#dl-cancel").hidden = !on;
  if (!on) $("#dl-bar").hidden = true;
}

// ---- drop + input wiring ----
const drop = $("#drop"), fileInput = $("#file");
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hover"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hover"); }));
drop.addEventListener("drop", (e) => onFiles(e.dataTransfer.files));
fileInput.addEventListener("change", (e) => { onFiles(e.target.files); e.target.value = ""; });
for (const id of ["sat", "con"]) $("#" + id).addEventListener("input", (e) => ($("#" + id + "-val").textContent = e.target.value));
