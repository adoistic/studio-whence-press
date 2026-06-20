// sink.js — a write target for streamed output. On Chromium it streams straight
// to a file the user picks (File System Access API) so memory stays flat no
// matter how many pages. Elsewhere it buffers and downloads at the end (works
// for small/medium jobs; very large jobs need a Chromium browser).

const MIME = { pdf: "application/pdf", zip: "application/zip" };

export function fsAccessAvailable() {
  return typeof self !== "undefined" && typeof self.showSaveFilePicker === "function";
}

// suggestedName like "book-CMYK-FOGRA52.pdf". Returns { mode, write(u8), close(), abort() }.
// Throws on user cancel (AbortError) so callers can bail quietly.
export async function createSink(suggestedName) {
  const ext = suggestedName.split(".").pop().toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";

  if (fsAccessAvailable()) {
    const handle = await self.showSaveFilePicker({
      suggestedName,
      types: [{ description: ext.toUpperCase(), accept: { [mime]: ["." + ext] } }],
    });
    const ws = await handle.createWritable();
    return {
      mode: "fs",
      write: (u8) => ws.write(u8),
      close: () => ws.close(),
      abort: () => ws.abort?.().catch(() => {}),
    };
  }

  // Fallback: buffer chunks, assemble a Blob, trigger a normal download.
  const parts = [];
  return {
    mode: "buffer",
    async write(u8) { parts.push(u8.slice ? u8.slice() : new Uint8Array(u8)); },
    async close() {
      const url = URL.createObjectURL(new Blob(parts, { type: mime }));
      const a = document.createElement("a");
      a.href = url; a.download = suggestedName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      parts.length = 0;
    },
    async abort() { parts.length = 0; },
  };
}
