// pdf_stream.js — write a multi-page DeviceCMYK PDF incrementally to a sink.
// Only small per-object metadata (byte offsets + page refs) is held in memory,
// so page count is bounded by disk, not RAM. Each page's deflated CMYK image is
// produced by the worker, written, and freed before the next page is requested.

const enc = new TextEncoder();

export class PdfStreamWriter {
  constructor(sink) {
    this.sink = sink;
    this.pos = 0;
    this.offsets = [];   // offsets[objNum-1] = byte offset
    this.kids = [];      // "N 0 R" per page
    this.objNum = 2;     // 1 = Catalog, 2 = Pages (written at finish)
    this.started = false;
  }

  async _w(bytes) { await this.sink.write(bytes); this.pos += bytes.length; }

  async _writeObj(num, parts) {
    this.offsets[num - 1] = this.pos;
    await this._w(enc.encode(`${num} 0 obj\n`));
    for (const p of parts) await this._w(p);
    await this._w(enc.encode("\nendobj\n"));
  }

  async _start() {
    await this._w(enc.encode("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n"));
    this.started = true;
  }

  // page: { imgDeflated: Uint8Array, width, height, dpi }
  async addPage(page) {
    if (!this.started) await this._start();
    const wpt = ((page.width / page.dpi) * 72).toFixed(3);
    const hpt = ((page.height / page.dpi) * 72).toFixed(3);

    const imgNum = ++this.objNum;
    await this._writeObj(imgNum, [
      enc.encode(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
        `/ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode /Length ${page.imgDeflated.length} >>\nstream\n`),
      page.imgDeflated,
      enc.encode("\nendstream"),
    ]);

    const content = enc.encode(`q\n${wpt} 0 0 ${hpt} 0 0 cm\n/Im0 Do\nQ\n`);
    const contentNum = ++this.objNum;
    await this._writeObj(contentNum, [enc.encode(`<< /Length ${content.length} >>\nstream\n`), content, enc.encode("\nendstream")]);

    const pageNum = ++this.objNum;
    await this._writeObj(pageNum, [enc.encode(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wpt} ${hpt}] ` +
      `/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>`)]);
    this.kids.push(`${pageNum} 0 R`);
  }

  async finish() {
    if (!this.started) await this._start();
    await this._writeObj(1, [enc.encode("<< /Type /Catalog /Pages 2 0 R >>")]);
    await this._writeObj(2, [enc.encode(`<< /Type /Pages /Kids [${this.kids.join(" ")}] /Count ${this.kids.length} >>`)]);

    const xrefStart = this.pos;
    const count = this.objNum + 1;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let i = 1; i < count; i++) xref += String(this.offsets[i - 1]).padStart(10, "0") + " 00000 n \n";
    xref += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    await this._w(enc.encode(xref));
    await this.sink.close();
  }
}
