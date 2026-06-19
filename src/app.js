// app.js — UI + decoding on the main thread; colour conversion in the worker.
import * as pdfjs from "../vendor/pdfjs/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;

const $ = (s) => document.querySelector(s);
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

let ready = false;
let pages = [];          // decoded frames awaiting/after conversion
const pending = new Map(); // id -> resolver

// ---- worker plumbing ----
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "ready") { ready = true; setStatus("Ready. Drop a file to begin."); }
  else if (m.type === "error") { setStatus("Error: " + m.message, true); console.error(m.message); }
  else if (m.type === "converted") { pending.get(m.id)?.(m); pending.delete(m.id); }
  else if (m.type === "pdf-done") { saveBlob(new Blob([m.pdf], { type: "application/pdf" }), outName("pdf")); }
  else if (m.type === "tiff-done") { saveBlob(new Blob([m.tiff], { type: "image/tiff" }), outName("tiff", m.index)); }
};
const call = (msg, transfer) => new Promise((res) => { pending.set(msg.id, res); worker.postMessage(msg, transfer || []); });

(async function init() {
  setStatus("Loading colour engine…");
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
  if (!ready) { setStatus("Engine still loading — one moment…"); return; }
  const files = [...fileList].filter((f) => /image\/|pdf/.test(f.type) || /\.(png|jpe?g|tiff?|webp|pdf)$/i.test(f.name));
  if (!files.length) { setStatus("Drop PNG, JPG, TIFF, WebP or PDF files.", true); return; }
  setBusy(true);
  setStatus("Reading files…");
  pages = [];
  worker.postMessage({ type: "reset" });
  for (const f of files) {
    try { pages.push(...await decodeFile(f)); }
    catch (err) { setStatus(`Could not read ${f.name}: ${err.message}`, true); }
  }
  $("#results").innerHTML = "";
  const opt = settings();
  for (let i = 0; i < pages.length; i++) {
    setStatus(`Converting ${i + 1} / ${pages.length}…`);
    const p = pages[i];
    const id = ++convertSeq;
    const res = await call(
      { type: "convert", id, rgba: p.rgba.buffer, width: p.width, height: p.height, settings: { sat: opt.sat, con: opt.con } },
      [p.rgba.buffer]
    );
    renderResult(p, res);
  }
  $("#download-bar").hidden = pages.length === 0;
  setBusy(false);
  setStatus(`Done — ${pages.length} page${pages.length === 1 ? "" : "s"} converted. Everything stayed on your device.`);
}

// ---- rendering results ----
function renderResult(page, res) {
  const proof = document.createElement("canvas");
  proof.width = res.width; proof.height = res.height;
  proof.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(res.proof), res.width, res.height), 0, 0);
  const proofURL = proof.toDataURL("image/png");

  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `
    <div class="ba">
      <figure><img src="${page.originalURL}" alt="original"><figcaption>RGB</figcaption></figure>
      <figure><img src="${proofURL}" alt="cmyk proof"><figcaption>CMYK proof</figcaption></figure>
    </div>
    <div class="meta">
      <div class="name">${escapeHtml(page.name)} <span class="tac">TAC ≤ ${res.tac}%</span></div>
      <div class="sub">DeviceCMYK · lossless · K-only black</div>
      <div class="dl">
        <button data-tiff="${res.index}">↓ CMYK TIFF</button>
        <a data-png>↓ Soft-proof PNG</a>
      </div>
    </div>`;
  row.querySelector("[data-tiff]").onclick = () => worker.postMessage({ type: "tiff", index: res.index, dpi: settings().dpi });
  const png = row.querySelector("[data-png]");
  png.onclick = () => proof.toBlob((b) => saveBlob(b, `${stem(page.name)}-CMYK-proof.png`));
  $("#results").appendChild(row);
}

// ---- downloads ----
$("#dl-pdf").onclick = () => { if (pages.length) worker.postMessage({ type: "pdf", dpi: settings().dpi }); };

function outName(kind, index) {
  const base = pages[0] ? stem(pages[0].name) : "studio-whence";
  if (kind === "pdf") return `${base}-CMYK-FOGRA52.pdf`;
  if (kind === "tiff") return `${stem(pages[index]?.name || base)}-CMYK-FOGRA52.tiff`;
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
function setStatus(t, bad) { const el = $("#status"); el.textContent = t; el.classList.toggle("bad", !!bad); }
function setBusy(b) { $("#drop").classList.toggle("busy", b); }

// ---- drop + input wiring ----
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hover"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hover"); }));
drop.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
$("#file").addEventListener("change", (e) => handleFiles(e.target.files));
$("#adv-toggle").addEventListener("click", () => $("#adv").classList.toggle("open"));
// live labels
for (const id of ["sat", "con"]) $("#" + id).addEventListener("input", (e) => $("#" + id + "-val").textContent = e.target.value);
