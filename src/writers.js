// writers.js — assemble lossless CMYK containers from raw DeviceCMYK samples.
// Runs in the worker (uses CompressionStream, no DOM). Soft-proof PNG is made
// on the main thread from the worker's reverse-transformed sRGB buffer.

const enc = new TextEncoder();

// zlib/deflate (RFC 1950) — what both PDF /FlateDecode and TIFF Adobe-Deflate want.
export async function deflate(bytes) {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const ab = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(ab);
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---- DeviceCMYK PDF (the img2pdf equivalent) -----------------------------
// pages: [{ cmyk: Uint8Array(w*h*4), width, height }], dpi for physical size.
export async function buildCmykPDF(pages, dpi = 300) {
  const objects = [];                       // objects[i] = Uint8Array body for object (i+1)
  const push = (body) => { objects.push(typeof body === "string" ? enc.encode(body) : body); return objects.length; };

  const catalog = push("");                 // 1 (filled later)
  const pagesObj = push("");                // 2 (filled later)
  const kids = [];

  for (const p of pages) {
    const data = await deflate(p.cmyk);
    const wpt = ((p.width / dpi) * 72).toFixed(3);
    const hpt = ((p.height / dpi) * 72).toFixed(3);

    const imgDict = enc.encode(
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} ` +
      `/ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`
    );
    const imgNum = push(concat([imgDict, data, enc.encode("\nendstream")]));

    const content = enc.encode(`q\n${wpt} 0 0 ${hpt} 0 0 cm\n/Im0 Do\nQ\n`);
    const contentNum = push(concat([
      enc.encode(`<< /Length ${content.length} >>\nstream\n`), content, enc.encode("\nendstream"),
    ]));

    const pageNum = push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wpt} ${hpt}] ` +
      `/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>`
    );
    kids.push(`${pageNum} 0 R`);
  }

  objects[catalog - 1] = enc.encode("<< /Type /Catalog /Pages 2 0 R >>");
  objects[pagesObj - 1] = enc.encode(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`);

  // Serialise with an xref table.
  const head = enc.encode("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");
  const parts = [head];
  const offsets = [];
  let pos = head.length;
  objects.forEach((body, i) => {
    const obj = concat([enc.encode(`${i + 1} 0 obj\n`), body, enc.encode("\nendobj\n")]);
    offsets.push(pos);
    parts.push(obj);
    pos += obj.length;
  });
  const xrefStart = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, "0") + " 00000 n \n";
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  return concat(parts);
}

// ---- CMYK TIFF (photometric=5 Separated, Adobe-Deflate, ICC embedded) ----
export async function buildCmykTIFF(cmyk, width, height, dpi = 300, iccProfile = null) {
  const strip = await deflate(cmyk);

  const entries = [];                        // {tag, type, count, value|offsetData}
  // types: 1=BYTE 3=SHORT 4=LONG 5=RATIONAL
  const add = (tag, type, count, value) => entries.push({ tag, type, count, value });

  // Values needing out-of-line storage get appended after the IFD.
  const extras = [];
  const bitsPerSample = new Uint8Array(8); // 4x SHORT = 8 bytes [8,8,8,8]
  new DataView(bitsPerSample.buffer).setUint16(0, 8, true);
  new DataView(bitsPerSample.buffer).setUint16(2, 8, true);
  new DataView(bitsPerSample.buffer).setUint16(4, 8, true);
  new DataView(bitsPerSample.buffer).setUint16(6, 8, true);

  const ratio = (n) => { const b = new Uint8Array(8); const dv = new DataView(b.buffer); dv.setUint32(0, n, true); dv.setUint32(4, 1, true); return b; };

  // Layout: header(8) + IFD, then extras, then strip. Compute offsets after we know IFD size.
  add(256, 3, 1, width);          // ImageWidth
  add(257, 3, 1, height);         // ImageLength
  add(258, 3, 4, "BPS");          // BitsPerSample -> extras
  add(259, 3, 1, 8);              // Compression = Adobe Deflate (zlib)
  add(262, 3, 1, 5);              // PhotometricInterpretation = Separated (CMYK)
  add(273, 4, 1, "STRIP");        // StripOffsets -> filled with strip offset
  add(277, 3, 1, 4);              // SamplesPerPixel
  add(278, 3, 1, height);         // RowsPerStrip (single strip)
  add(279, 4, 1, strip.length);   // StripByteCounts
  add(282, 5, 1, "XRES");         // XResolution
  add(283, 5, 1, "YRES");         // YResolution
  add(284, 3, 1, 1);              // PlanarConfiguration = chunky
  add(296, 3, 1, 2);              // ResolutionUnit = inch
  add(332, 3, 1, 1);              // InkSet = CMYK
  if (iccProfile) add(34675, 7, iccProfile.length, "ICC"); // ICCProfile

  entries.sort((a, b) => a.tag - b.tag);

  const ifdCount = entries.length;
  const ifdSize = 2 + ifdCount * 12 + 4;
  let extraOff = 8 + ifdSize;     // where out-of-line data begins
  const place = (bytes) => { const at = extraOff; extras.push({ at, bytes }); extraOff += bytes.length; return at; };

  const bpsOff = place(bitsPerSample);
  const xresOff = place(ratio(dpi));
  const yresOff = place(ratio(dpi));
  const iccOff = iccProfile ? place(iccProfile) : 0;
  const stripOff = extraOff;     // strip goes last

  // Build IFD.
  const ifd = new Uint8Array(ifdSize);
  const dv = new DataView(ifd.buffer);
  dv.setUint16(0, ifdCount, true);
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    dv.setUint16(o, e.tag, true);
    dv.setUint16(o + 2, e.type, true);
    dv.setUint32(o + 4, e.count, true);
    let v = e.value;
    if (v === "BPS") v = bpsOff;
    else if (v === "STRIP") v = stripOff;
    else if (v === "XRES") v = xresOff;
    else if (v === "YRES") v = yresOff;
    else if (v === "ICC") v = iccOff;
    dv.setUint32(o + 8, v, true); // SHORT/LONG/offset all fit in the 4-byte value field here
  });
  dv.setUint32(2 + ifdCount * 12, 0, true); // next IFD = 0

  const header = new Uint8Array(8);
  const hv = new DataView(header.buffer);
  hv.setUint16(0, 0x4949, true); // "II" little-endian
  hv.setUint16(2, 42, true);
  hv.setUint32(4, 8, true);      // first IFD at offset 8

  // Assemble in offset order.
  const total = stripOff + strip.length;
  const out = new Uint8Array(total);
  out.set(header, 0);
  out.set(ifd, 8);
  for (const ex of extras) out.set(ex.bytes, ex.at);
  out.set(strip, stripOff);
  return out;
}
