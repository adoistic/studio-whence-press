// app.js — UI + decoding on the main thread; colour conversion in the worker.
import * as pdfjs from "../vendor/pdfjs/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;

const $ = (s) => document.querySelector(s);
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const setState = (s) => { document.body.dataset.state = s; };

let ready = false;
let pages = [];           // decoded frames awaiting/after conversion
const pending = new Map(); // id -> resolver

// ---- worker plumbing ----
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "ready") { ready = true; setState("empty"); }
  else if (m.type === "error") { setStatus("Something went wrong: " + m.message, { bad: true }); setState("error"); console.error(m.message); }
  else if (m.type === "converted") { pending.get(m.id)?.(m); pending.delete(m.id); }
  else if (m.type === "pdf-done") { saveBlob(new Blob([m.pdf], { type: "application/pdf" }), outName("pdf")); }
  else if (m.type === "tiff-done") { saveBlob(new Blob([m.tiff], { type: "image/tiff" }), outName("tiff", m.index)); }
  else if (m.type === "jpeg-done") { saveBlob(new Blob([m.jpeg], { type: "image/jpeg" }), outName("jpeg", m.index)); }
};
const call = (msg, transfer) => new Promise((res) => { pending.set(msg.id, res); worker.postMessage(msg, transfer || []); });

(async function init() {
  const icc = await (await fetch("./assets/fogra52.icc")).arrayBuffer();
  worker.postMessage({ type: "init", icc }, [icc]);
})();

// ---- settings ----
const settings = () => ({
  dpi: parseInt($("#dpi").value, 10) || 300,
  sat: parseFloat($("#sat").value),
  con: parseFloat($("#con").value),
});

// ---- decoding ----
async function decodeFile(file) {
  const out = [];
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const dpi = settings().dpi;
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: dpi / 72 });
      const c = document.createElement("canvas");
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push(frameFromCanvas(c, `${file.name} · p${i}`));
    }
  } else {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    out.push(frameFromCanvas(c, file.name));
  }
  return out;
}
function frameFromCanvas(c, name) {
  const img = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  return { name, width: c.width, height: c.height, rgba: img.data, originalURL: c.toDataURL("image/png") };
}

// ---- pipeline ----
let convertSeq = 0;
async function handleFiles(fileList) {
  if (!ready) { setStatus("The colour engine is still loading — one moment…", { spin: true }); return; }
  const files = [...fileList].filter((f) => /image\/|pdf/.test(f.type) || /\.(png|jpe?g|tiff?|webp|pdf)$/i.test(f.name));
  if (!files.length) { setStatus("Please drop PDF, PNG, JPG, TIFF or WebP files.", { bad: true }); setState("error"); return; }

  setState("working");
  setStatus("Reading files…", { spin: true });
  pages = [];
  worker.postMessage({ type: "reset" });
  for (const f of files) {
    try { pages.push(...await decodeFile(f)); }
    catch (err) { setStatus(`Could not read ${f.name}: ${err.message}`, { bad: true }); }
  }
  $("#results").innerHTML = "";
  const opt = settings();
  for (let i = 0; i < pages.length; i++) {
    setStatus(`Converting page ${i + 1} of ${pages.length}…`, { spin: true });
    const p = pages[i];
    const id = ++convertSeq;
    const res = await call(
      { type: "convert", id, rgba: p.rgba.buffer, width: p.width, height: p.height, settings: { sat: opt.sat, con: opt.con } },
      [p.rgba.buffer]
    );
    renderResult(p, res);
  }
  const n = pages.length;
  $("#done-count").textContent = `${n} page${n === 1 ? "" : "s"} converted`;
  setState("done");
}

// ---- rendering results ----
function renderResult(page, res) {
  const proof = document.createElement("canvas");
  proof.width = res.width; proof.height = res.height;
  proof.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(res.proof), res.width, res.height), 0, 0);
  const proofURL = proof.toDataURL("image/png");

  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    <div class="thumbs">
      <figure><img class="thumb" src="${page.originalURL}" alt="original"><figcaption>RGB</figcaption></figure>
      <span class="to" aria-hidden="true">→</span>
      <figure><img class="thumb" src="${proofURL}" alt="CMYK proof"><figcaption>CMYK</figcaption></figure>
    </div>
    <div class="card-body">
      <div class="card-name">${escapeHtml(page.name)} <span class="tac">TAC ≤ ${res.tac}%</span></div>
      <div class="card-fmts">
        <button data-tiff>CMYK TIFF</button>
        <button data-jpeg>CMYK JPEG</button>
        <button data-png>Soft-proof PNG</button>
      </div>
    </div>`;
  card.querySelector("[data-tiff]").onclick = () => worker.postMessage({ type: "tiff", index: res.index, dpi: settings().dpi });
  card.querySelector("[data-jpeg]").onclick = () => worker.postMessage({ type: "jpeg", index: res.index, quality: 90 });
  card.querySelector("[data-png]").onclick = () => proof.toBlob((b) => saveBlob(b, `${stem(page.name)}-CMYK-proof.png`));
  $("#results").appendChild(card);
}

// ---- downloads ----
$("#dl-pdf").onclick = () => { if (pages.length) worker.postMessage({ type: "pdf", dpi: settings().dpi }); };
$("#clear").onclick = () => { pages = []; $("#results").innerHTML = ""; worker.postMessage({ type: "reset" }); setState("empty"); };

function outName(kind, index) {
  const base = pages[0] ? stem(pages[0].name) : "studio-whence";
  if (kind === "pdf") return `${base}-CMYK-FOGRA52.pdf`;
  if (kind === "tiff") return `${stem(pages[index]?.name || base)}-CMYK-FOGRA52.tiff`;
  if (kind === "jpeg") return `${stem(pages[index]?.name || base)}-CMYK-FOGRA52.jpg`;
  return `${base}.bin`;
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---- helpers ----
const stem = (n) => n.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_");
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function setStatus(t, { bad = false, spin = false } = {}) {
  const el = $("#status");
  el.innerHTML = (spin ? '<span class="spin"></span>' : "") + escapeHtml(t);
  el.classList.toggle("bad", bad);
}

// ---- drop + input wiring ----
const drop = $("#drop");
const fileInput = $("#file");
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hover"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hover"); }));
drop.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
fileInput.addEventListener("change", (e) => { handleFiles(e.target.files); e.target.value = ""; });
// live labels for the advanced sliders
for (const id of ["sat", "con"]) $("#" + id).addEventListener("input", (e) => ($("#" + id + "-val").textContent = e.target.value));
