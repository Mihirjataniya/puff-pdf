import { shapeVertices, curvedPts, NOTE, NOTE_COLORS, wrapNoteLines } from "./annots.js";

// Burn annotations into a real PDF using pdf-lib (loaded as global PDFLib).
// Unit space (our annotations) = PDF points, origin top-left, y-down.
// PDF user space = points, origin bottom-left, y-up  →  y_pdf = pageHeight - y_unit.

function hexToRgb(hex) {
  let h = String(hex || "#000").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return { r: 0, g: 0, b: 0 };
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function normRect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function dataUrlToBytes(dataUrl) {
  const bin = atob(String(dataUrl).split(",")[1] || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// `outPages` is one entry per FINAL page in display order:
//   { blank: boolean, w, h, annots: [...] }
// Original PDF pages stay in their order; blank pages are inserted at their index.
export async function exportAnnotatedPdf(pdfBytes, outPages) {
  const { PDFDocument, rgb, StandardFonts, LineCapStyle, degrees } = globalThis.PDFLib;
  const pdf = await PDFDocument.load(pdfBytes);
  const fonts = {
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    serif: await pdf.embedFont(StandardFonts.TimesRoman),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };

  // insert blanks at their final indices (non-blank originals are already in order)
  outPages.forEach((op, i) => { if (op.blank) pdf.insertPage(i, [op.w, op.h]); });

  const pages = pdf.getPages();
  const ctx = { rgb, degrees, font: fonts.sans, fonts, cap: LineCapStyle.Round };

  // embed each unique image once (pdf-lib supports PNG + JPEG)
  const images = new Map();
  for (const { annots } of outPages) {
    for (const a of annots || []) {
      if (a.type !== "image" || !a.src || images.has(a.src)) continue;
      try {
        const bytes = dataUrlToBytes(a.src);
        const emb = /^data:image\/jpe?g/i.test(a.src) ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
        images.set(a.src, emb);
      } catch { /* skip an image that won't embed */ }
    }
  }
  ctx.images = images;

  let rotatedWarn = false;
  outPages.forEach((op, i) => {
    const page = pages[i];
    if (!page) return;
    if ((page.getRotation().angle % 360) !== 0) rotatedWarn = true;
    if (op.blank) page.drawRectangle({ x: 0, y: 0, width: op.w, height: op.h, color: rgb(1, 1, 1) }); // ensure white
    const ph = page.getSize().height;
    for (const a of op.annots || []) drawOne(page, a, ph, ctx);
  });
  return { bytes: await pdf.save(), rotatedWarn };
}

function drawOne(page, a, ph, ctx) {
  const { r, g, b } = hexToRgb(a.color);
  const color = ctx.rgb(r, g, b);
  const op = a.opacity ?? 1;
  const Y = (y) => ph - y;

  switch (a.type) {
    case "path":
    case "brush":
    case "hlfree": {
      const P = a.points || [];
      const baseW = a.width || (a.type === "hlfree" ? 12 : 2);
      if (P.length === 1) {
        page.drawCircle({ x: P[0].x, y: Y(P[0].y), size: baseW / 2, color, opacity: op });
        break;
      }
      for (let i = 1; i < P.length; i++) {
        const th = a.type === "brush" ? baseW * (P[i].w || 1) : baseW;
        page.drawLine({
          start: { x: P[i - 1].x, y: Y(P[i - 1].y) },
          end: { x: P[i].x, y: Y(P[i].y) },
          thickness: th, color, opacity: op, lineCap: ctx.cap,
        });
      }
      break;
    }
    case "line":
      page.drawLine({
        start: { x: a.points[0].x, y: Y(a.points[0].y) },
        end: { x: a.points[1].x, y: Y(a.points[1].y) },
        thickness: a.width || 2, color, opacity: op, lineCap: ctx.cap,
      });
      break;
    case "arrow": {
      const A = a.points[0], B = a.points[1];
      const w = a.width || 2;
      const seg = (p, q) => page.drawLine({ start: { x: p.x, y: Y(p.y) }, end: { x: q.x, y: Y(q.y) }, thickness: w, color, opacity: op, lineCap: ctx.cap });
      seg(A, B);
      const ang = Math.atan2(B.y - A.y, B.x - A.x);
      const head = Math.max(8, w * 3);
      seg(B, { x: B.x - head * Math.cos(ang - Math.PI / 6), y: B.y - head * Math.sin(ang - Math.PI / 6) });
      seg(B, { x: B.x - head * Math.cos(ang + Math.PI / 6), y: B.y - head * Math.sin(ang + Math.PI / 6) });
      break;
    }
    case "rect":
    case "rrect": {
      const q = normRect(a.points[0], a.points[1]);
      page.drawRectangle({ x: q.x, y: Y(q.y + q.h), width: q.w, height: q.h, borderColor: color, borderWidth: a.width || 2, borderOpacity: op });
      break;
    }
    case "poly": {
      const v = shapeVertices(a.shape, normRect(a.points[0], a.points[1]));
      const w = a.width || 2;
      for (let i = 0; i < v.length; i++) {
        const p = v[i], q = v[(i + 1) % v.length];
        page.drawLine({ start: { x: p.x, y: Y(p.y) }, end: { x: q.x, y: Y(q.y) }, thickness: w, color, opacity: op, lineCap: ctx.cap });
      }
      break;
    }
    case "dblarrow": {
      const A = a.points[0], B = a.points[1], w = a.width || 2;
      const seg = (p, q) => page.drawLine({ start: { x: p.x, y: Y(p.y) }, end: { x: q.x, y: Y(q.y) }, thickness: w, color, opacity: op, lineCap: ctx.cap });
      seg(A, B);
      for (const [tip, from] of [[B, A], [A, B]]) {
        const ang = Math.atan2(tip.y - from.y, tip.x - from.x), head = Math.max(8, w * 3);
        seg(tip, { x: tip.x - head * Math.cos(ang - Math.PI / 6), y: tip.y - head * Math.sin(ang - Math.PI / 6) });
        seg(tip, { x: tip.x - head * Math.cos(ang + Math.PI / 6), y: tip.y - head * Math.sin(ang + Math.PI / 6) });
      }
      break;
    }
    case "elbowarrow":
    case "curvedarrow": {
      const w = a.width || 2;
      const seg = (p, q) => page.drawLine({ start: { x: p.x, y: Y(p.y) }, end: { x: q.x, y: Y(q.y) }, thickness: w, color, opacity: op, lineCap: ctx.cap });
      const pts = a.type === "curvedarrow"
        ? curvedPts(a.points[0], a.points[1], a.points[2])
        : [a.points[0], { x: a.points[1].x, y: a.points[0].y }, a.points[1]];
      for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
      const B = pts[pts.length - 1], prev = pts[pts.length - 2];
      const ang = Math.atan2(B.y - prev.y, B.x - prev.x), head = Math.max(8, w * 3);
      seg(B, { x: B.x - head * Math.cos(ang - Math.PI / 6), y: B.y - head * Math.sin(ang - Math.PI / 6) });
      seg(B, { x: B.x - head * Math.cos(ang + Math.PI / 6), y: B.y - head * Math.sin(ang + Math.PI / 6) });
      break;
    }
    case "ellipse": {
      const q = normRect(a.points[0], a.points[1]);
      page.drawEllipse({ x: q.x + q.w / 2, y: Y(q.y + q.h / 2), xScale: q.w / 2, yScale: q.h / 2, borderColor: color, borderWidth: a.width || 2, borderOpacity: op });
      break;
    }
    case "image": {
      const emb = ctx.images && ctx.images.get(a.src);
      if (emb && a.w > 0 && a.h > 0) {
        const phi = a.rot || 0;
        if (!phi) {
          page.drawImage(emb, { x: a.x, y: Y(a.y + a.h), width: a.w, height: a.h, opacity: op });
        } else {
          // pdf-lib rotates about the (x,y) anchor; solve the anchor so the image
          // spins about its center. Screen rot is y-down, PDF is y-up → angle negates.
          const cos = Math.cos(phi), sin = Math.sin(phi);
          const cxu = a.x + a.w / 2, cyp = Y(a.y + a.h / 2);
          const x = cxu - (a.w / 2) * cos - (a.h / 2) * sin;
          const y = cyp + (a.w / 2) * sin - (a.h / 2) * cos;
          page.drawImage(emb, { x, y, width: a.w, height: a.h, opacity: op, rotate: ctx.degrees(-phi * 180 / Math.PI) });
        }
      }
      break;
    }
    case "note": {
      const bg = hexToRgb(a.color || NOTE_COLORS[0]);
      const fold = Math.min(18, a.w * 0.3, a.h * 0.3);
      // body: polygon with the bottom-right corner clipped (y-up PDF space)
      const top = Y(a.y), bot = Y(a.y + a.h), L = a.x, R = a.x + a.w;
      page.drawRectangle({ x: L, y: bot, width: a.w, height: a.h, color: ctx.rgb(bg.r, bg.g, bg.b), opacity: op });
      // darker folded corner (a small square at bottom-right, good-enough flat look)
      const fg = hexToRgb(a.color || NOTE_COLORS[0]);
      const d = 0.82; // darken
      page.drawRectangle({ x: R - fold, y: bot, width: fold, height: fold, color: ctx.rgb(fg.r * d, fg.g * d, fg.b * d), opacity: op });
      // wrapped text
      const tf = ctx.fonts.sans, fs = NOTE.FONT, pad = NOTE.PAD, lh = fs * NOTE.LH;
      const measure = (t) => tf.widthOfTextAtSize(t, fs);
      const lines = wrapNoteLines(measure, a.text, a.w - pad * 2);
      const tc = ctx.rgb(0.17, 0.17, 0.17);
      let ty = a.y + pad;
      for (const ln of lines) {
        if (ty + lh > a.y + a.h - pad * 0.4) break;
        page.drawText(ln, { x: a.x + pad, y: Y(ty) - fs, size: fs, font: tf, color: tc, opacity: op });
        ty += lh;
      }
      break;
    }
    case "hltext": {
      for (const q of a.rects || []) {
        page.drawRectangle({ x: q.x, y: Y(q.y + q.h), width: q.w, height: q.h, color, opacity: op });
      }
      break;
    }
    case "text": {
      const fs = a.fontSize || 16;
      const lines = String(a.text || "").split("\n");
      const tf = ctx.fonts[a.fontFamily] || ctx.font;
      lines.forEach((ln, i) => {
        page.drawText(ln, { x: a.x, y: Y(a.y) - fs - i * fs * 1.25, size: fs, font: tf, color, opacity: op });
      });
      break;
    }
  }
}
