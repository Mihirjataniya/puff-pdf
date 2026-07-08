// Annotation model helpers — pure rendering + geometry.
//
// Coordinate convention: every annotation stores geometry in "unit space" =
// the page at pdf.js scale 1 (CSS px, origin top-left, y-down). This equals PDF
// points (1 unit = 1pt) which makes Stage-4 export a simple y-flip.
//
// drawAnnotation() receives a 2D context already transformed by DPR, so we
// multiply unit coords by `s` (effective on-screen scale) to get CSS px.

// Shapes defined as vertices in the unit square [0..1]; scaled to the drag bbox.
function regularPoly(n, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * 2 * Math.PI) / n;
    pts.push([0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]);
  }
  return pts;
}
function starPoly(points = 5, inner = 0.5) {
  const pts = [], rot = -Math.PI / 2;
  for (let i = 0; i < points * 2; i++) {
    const r = (i % 2 ? inner : 1) * 0.5;
    const a = rot + (i * Math.PI) / points;
    pts.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]);
  }
  return pts;
}

function sampleHeart(n = 64) {
  const raw = [];
  for (let i = 0; i <= n; i++) {
    const t = Math.PI - (i / n) * 2 * Math.PI;
    raw.push([16 * Math.sin(t) ** 3, 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)]);
  }
  const xs = raw.map((p) => p[0]), ys = raw.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return raw.map(([x, y]) => [(x - minX) / (maxX - minX), 1 - (y - minY) / (maxY - minY)]);
}

function sampleCloud(n = 90, bumps = 9, depth = 0.14) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const r = 0.5 * (1 - depth * (0.5 + 0.5 * Math.cos(bumps * a)));
    pts.push([0.5 + r * Math.cos(a), 0.5 + r * 0.74 * Math.sin(a)]);
  }
  return pts;
}

export const SHAPE_DEFS = {
  triangle: [[0.5, 0], [1, 1], [0, 1]],
  righttri: [[0, 0], [0, 1], [1, 1]],
  diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
  pentagon: regularPoly(5),
  hexagon: regularPoly(6),
  star: starPoly(5),
  plus: [[0.35, 0], [0.65, 0], [0.65, 0.35], [1, 0.35], [1, 0.65], [0.65, 0.65], [0.65, 1], [0.35, 1], [0.35, 0.65], [0, 0.65], [0, 0.35], [0.35, 0.35]],
  parallelogram: [[0.25, 0], [1, 0], [0.75, 1], [0, 1]],
  trapezoid: [[0.25, 0], [0.75, 0], [1, 1], [0, 1]],
  heart: sampleHeart(),
  cloud: sampleCloud(),
  // chamfered rectangle + tail (reads as rounded speech/tooltip without arc math)
  speech: [[0.08, 0], [0.92, 0], [1, 0.08], [1, 0.6], [0.92, 0.68], [0.4, 0.68], [0.2, 1], [0.28, 0.68], [0.08, 0.68], [0, 0.6], [0, 0.08]],
  callout: [[0, 0], [1, 0], [1, 0.68], [0.36, 0.68], [0.16, 1], [0.28, 0.68], [0, 0.68]],
  tooltip: [[0.08, 0], [0.92, 0], [1, 0.08], [1, 0.6], [0.92, 0.68], [0.58, 0.68], [0.5, 1], [0.42, 0.68], [0.08, 0.68], [0, 0.6], [0, 0.08]],
};

// default bézier control point (bowed perpendicular to the chord)
export function defaultControl(A, B) {
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
  return { x: mx + (-dy / len) * len * 0.22, y: my + (dx / len) * len * 0.22 };
}

// quadratic-bezier polyline A→B through control C (defaults to a bowed curve)
export function curvedPts(A, B, C, steps = 26) {
  const ctrl = C || defaultControl(A, B);
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push({ x: u * u * A.x + 2 * u * t * ctrl.x + t * t * B.x, y: u * u * A.y + 2 * u * t * ctrl.y + t * t * B.y });
  }
  return out;
}

// text font families → CSS stacks (mirrored to PDF StandardFonts on export)
export function cssFontFamily(family) {
  switch (family) {
    case "serif": return "Georgia, 'Times New Roman', serif";
    case "mono": return "ui-monospace, 'Courier New', monospace";
    default: return "system-ui, Arial, sans-serif";
  }
}

export function shapeVertices(shape, b) {
  const d = SHAPE_DEFS[shape] || SHAPE_DEFS.triangle;
  return d.map(([nx, ny]) => ({ x: b.x + nx * b.w, y: b.y + ny * b.h }));
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.min(Math.abs(w), Math.abs(h)) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function arrowHead(ctx, tip, from, s, width) {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  const head = Math.max(8, width * 3) * s;
  const x = tip.x * s, y = tip.y * s;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - head * Math.cos(ang - Math.PI / 6), y - head * Math.sin(ang - Math.PI / 6));
  ctx.moveTo(x, y);
  ctx.lineTo(x - head * Math.cos(ang + Math.PI / 6), y - head * Math.sin(ang + Math.PI / 6));
  ctx.stroke();
}

export function drawAnnotation(ctx, a, s) {
  ctx.save();
  ctx.globalAlpha = a.opacity ?? 1;
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = Math.max(0.5, (a.width || 2) * s);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const P = a.points || [];

  switch (a.type) {
    case "path":
    case "brush":
    case "hlfree":
      strokePolyline(ctx, P, s, a);
      break;
    case "line":
      if (P.length >= 2) segment(ctx, P[0], P[1], s);
      break;
    case "arrow":
      if (P.length >= 2) drawArrow(ctx, P[0], P[1], s, a.width || 2);
      break;
    case "rect": {
      if (P.length >= 2) {
        const r = normRect(P[0], P[1]);
        ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);
      }
      break;
    }
    case "ellipse": {
      if (P.length >= 2) {
        const r = normRect(P[0], P[1]);
        ctx.beginPath();
        ctx.ellipse((r.x + r.w / 2) * s, (r.y + r.h / 2) * s, (r.w / 2) * s, (r.h / 2) * s, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case "rrect": {
      if (P.length >= 2) {
        const r = normRect(P[0], P[1]);
        roundRectPath(ctx, r.x * s, r.y * s, r.w * s, r.h * s, Math.min(r.w, r.h) * 0.18 * s);
        ctx.stroke();
      }
      break;
    }
    case "poly": {
      if (P.length >= 2) {
        const v = shapeVertices(a.shape, normRect(P[0], P[1]));
        ctx.beginPath();
        v.forEach((pt, i) => (i ? ctx.lineTo(pt.x * s, pt.y * s) : ctx.moveTo(pt.x * s, pt.y * s)));
        ctx.closePath();
        ctx.stroke();
      }
      break;
    }
    case "dblarrow": {
      if (P.length >= 2) {
        segment(ctx, P[0], P[1], s);
        arrowHead(ctx, P[1], P[0], s, a.width || 2);
        arrowHead(ctx, P[0], P[1], s, a.width || 2);
      }
      break;
    }
    case "elbowarrow": {
      if (P.length >= 2) {
        const A = P[0], B = P[1], C = { x: B.x, y: A.y };
        ctx.beginPath();
        ctx.moveTo(A.x * s, A.y * s);
        ctx.lineTo(C.x * s, C.y * s);
        ctx.lineTo(B.x * s, B.y * s);
        ctx.stroke();
        arrowHead(ctx, B, C, s, a.width || 2);
      }
      break;
    }
    case "curvedarrow": {
      if (P.length >= 2) {
        const pts = curvedPts(P[0], P[1], P[2]);
        ctx.beginPath();
        pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x * s, pt.y * s) : ctx.moveTo(pt.x * s, pt.y * s)));
        ctx.stroke();
        arrowHead(ctx, P[1], pts[pts.length - 2], s, a.width || 2);
      }
      break;
    }
    case "hltext": {
      for (const q of a.rects || []) {
        ctx.fillRect(q.x * s, q.y * s, q.w * s, q.h * s);
      }
      break;
    }
    case "text": {
      const fs = (a.fontSize || 16) * s;
      ctx.globalAlpha = a.opacity ?? 1;
      ctx.font = `${fs}px ${cssFontFamily(a.fontFamily)}`;
      ctx.textBaseline = "top";
      const lines = String(a.text || "").split("\n");
      lines.forEach((ln, i) => ctx.fillText(ln, a.x * s, a.y * s + i * fs * 1.25));
      break;
    }
  }
  ctx.restore();
}

function strokePolyline(ctx, P, s, a) {
  if (!P.length) return;
  // brush: variable width per point (stored p = pressure/speed factor)
  if (a.type === "brush" && P.length >= 2) {
    for (let i = 1; i < P.length; i++) {
      ctx.beginPath();
      const w = (a.width || 3) * (P[i].w || 1);
      ctx.lineWidth = Math.max(0.5, w * s);
      ctx.moveTo(P[i - 1].x * s, P[i - 1].y * s);
      ctx.lineTo(P[i].x * s, P[i].y * s);
      ctx.stroke();
    }
    return;
  }
  ctx.beginPath();
  ctx.moveTo(P[0].x * s, P[0].y * s);
  if (P.length === 1) {
    // a dot
    ctx.lineTo(P[0].x * s + 0.01, P[0].y * s + 0.01);
  } else {
    for (let i = 1; i < P.length; i++) ctx.lineTo(P[i].x * s, P[i].y * s);
  }
  ctx.stroke();
}

function segment(ctx, a, b, s) {
  ctx.beginPath();
  ctx.moveTo(a.x * s, a.y * s);
  ctx.lineTo(b.x * s, b.y * s);
  ctx.stroke();
}

function drawArrow(ctx, a, b, s, width) {
  segment(ctx, a, b, s);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const head = Math.max(8, width * 3) * s;
  const x = b.x * s, y = b.y * s;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - head * Math.cos(ang - Math.PI / 6), y - head * Math.sin(ang - Math.PI / 6));
  ctx.moveTo(x, y);
  ctx.lineTo(x - head * Math.cos(ang + Math.PI / 6), y - head * Math.sin(ang + Math.PI / 6));
  ctx.stroke();
}

export function normRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

// ---------- geometry for eraser hit-testing (unit space) ----------
function distToSeg(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Is point (x,y) within `tol` unit px of annotation `a`?
export function hitTestAnnot(a, x, y, tol) {
  const t = tol + (a.width || 2) / 2;
  switch (a.type) {
    case "path":
    case "brush":
    case "hlfree":
    case "line":
    case "arrow":
    case "dblarrow":
    case "elbowarrow": {
      const P = a.points || [];
      if (P.length === 1) return Math.hypot(P[0].x - x, P[0].y - y) <= t;
      for (let i = 1; i < P.length; i++) if (distToSeg(x, y, P[i - 1], P[i]) <= t) return true;
      return false;
    }
    case "curvedarrow": {
      const pts = curvedPts(a.points[0], a.points[1], a.points[2]);
      for (let i = 1; i < pts.length; i++) if (distToSeg(x, y, pts[i - 1], pts[i]) <= t) return true;
      return false;
    }
    case "rect":
    case "ellipse":
    case "rrect":
    case "poly": {
      const r = normRect(a.points[0], a.points[1]);
      // near border OR inside (generous for easy erasing / selecting)
      return x >= r.x - t && x <= r.x + r.w + t && y >= r.y - t && y <= r.y + r.h + t;
    }
    case "hltext": {
      for (const q of a.rects || []) {
        if (x >= q.x - tol && x <= q.x + q.w + tol && y >= q.y - tol && y <= q.y + q.h + tol) return true;
      }
      return false;
    }
    case "text": {
      const fs = a.fontSize || 16;
      const lines = String(a.text || "").split("\n");
      const w = Math.max(...lines.map((l) => l.length)) * fs * 0.6;
      const h = lines.length * fs * 1.25;
      return x >= a.x - tol && x <= a.x + w + tol && y >= a.y - tol && y <= a.y + h + tol;
    }
  }
  return false;
}
