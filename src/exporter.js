import { shapeVertices, curvedPts } from "./annots.js";

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

export async function exportAnnotatedPdf(pdfBytes, pageAnnots) {
  const { PDFDocument, rgb, StandardFonts, LineCapStyle } = globalThis.PDFLib;
  const pdf = await PDFDocument.load(pdfBytes);
  const fonts = {
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    serif: await pdf.embedFont(StandardFonts.TimesRoman),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const pages = pdf.getPages();
  const ctx = { rgb, font: fonts.sans, fonts, cap: LineCapStyle.Round };

  let rotatedWarn = false;
  for (const { pageNum, annots } of pageAnnots) {
    const page = pages[pageNum - 1];
    if (!page) continue;
    if ((page.getRotation().angle % 360) !== 0) rotatedWarn = true;
    const ph = page.getSize().height;
    for (const a of annots) drawOne(page, a, ph, ctx);
  }
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
