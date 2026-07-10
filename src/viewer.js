// Puff PDF — viewer core
// Stage 2: draw engine (pen, freehand highlighter, line/arrow/rect/ellipse,
// undo/redo, clear). Text-snap highlight, text box, brush, eraser: Stage 3.

import * as pdfjsLib from "../lib/pdf.min.mjs";
import { drawAnnotation, hitTestAnnot, cssFontFamily, defaultControl } from "./annots.js";
import { exportAnnotatedPdf } from "./exporter.js";
import { ocrCanvas, setOcrProgress } from "./ocr.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../lib/pdf.worker.min.mjs",
  import.meta.url
).toString();

const api = globalThis.browser || globalThis.chrome;

// Embedded mode: this viewer runs inside a split-view pane (an iframe). Its own
// chrome is hidden; a shared toolbar in the parent shell drives it via postMessage.
const EMBED = new URLSearchParams(location.search).has("embed");

// ---------- global state ----------
const state = {
  pdfDoc: null,
  pdfBytes: null,        // original bytes, kept for export
  numPages: 0,
  scale: 1.0,
  baseScale: 1.0,
  pages: [],
  docId: null,
  sourceLabel: "",
  tool: "pen",
  color: "#e11d48",
  width: 3,
  opacity: 1.0,
  polyShape: "triangle", // active shape for the "poly" tool
  fontFamily: "sans",    // text-box font
  hasText: true,
  ocrRunning: false,
  ocrCancel: false,
  rasterScan: false,        // true = scanned/image PDF (don't upscale → avoid blur)
  scanIdealScale: Infinity, // scale at which a scan renders 1:1 with its source pixels
  history: [],   // [{added:[{pv,annot}], removed:[{pv,annot}]}]
  redo: [],
  io: null,          // IntersectionObserver for lazy rendering
  visible: new Set(),// currently painted (near-viewport) pages
  selected: null,    // { pv, annot } — the object being edited (Select tool)
  drag: null,        // active move/resize gesture
};

const HANDLE_PX = 8; // on-screen size of resize handles
let activeEdit = null; // live text-editor hook: { refresh } while a box is being typed

const SWATCHES = ["#e11d48", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#111827", "#ffffff"];
const DPR = Math.max(1, window.devicePixelRatio || 1);
const measureCtx = document.createElement("canvas").getContext("2d"); // text width measuring (OCR layer)

const PATH_TOOLS = new Set(["pen", "brush", "hlfree"]);
const SHAPE_TOOLS = new Set(["line", "arrow", "dblarrow", "elbowarrow", "curvedarrow", "rect", "rrect", "ellipse", "poly"]);
const BASE_SHAPES = new Set(["line", "arrow", "dblarrow", "elbowarrow", "curvedarrow", "rect", "rrect", "ellipse"]); // drag start→end
const ENDPOINT_SHAPES = new Set(["line", "arrow", "dblarrow", "elbowarrow", "curvedarrow"]); // 2 endpoint handles

let idSeq = 0;
function newId() {
  idSeq += 1;
  return "a" + idSeq;
}

// ---------- DOM refs ----------
const el = {
  stage: document.getElementById("stage"),
  pages: document.getElementById("pages"),
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("file-input"),
  imageInput: document.getElementById("image-input"),
  zoomLabel: document.getElementById("zoom-label"),
  pageReadout: document.getElementById("page-readout"),
  toast: document.getElementById("toast"),
  swatches: document.getElementById("swatches"),
  color: document.getElementById("color"),
  width: document.getElementById("width"),
  opacity: document.getElementById("opacity"),
  properties: document.getElementById("properties"),
  toolName: document.getElementById("tool-name"),
  propWidth: document.getElementById("prop-width"),
  propFont: document.getElementById("prop-font"),
  font: document.getElementById("font"),
  docName: document.getElementById("doc-name"),
};

const TOOL_LABELS = {
  select: "Select", pen: "Pen", brush: "Brush", hltext: "Highlight text",
  hlfree: "Highlighter", line: "Line", arrow: "Arrow", dblarrow: "Double arrow",
  rect: "Rectangle", rrect: "Rounded rect", ellipse: "Ellipse", text: "Text",
  image: "Image", eraser: "Eraser",
};
const NO_WIDTH_TOOLS = new Set(["hltext", "eraser", "image"]);

// ---------- tiny utils ----------
let toastTimer = null;
function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), ms);
}

async function sha1Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function effectiveScale() {
  return state.baseScale * state.scale;
}

// Build an annotation from the current tool + a starting point.
function annotForTool(pageNum, p) {
  const base = { id: newId(), page: pageNum, color: state.color, width: state.width, opacity: state.opacity };
  switch (state.tool) {
    case "pen":
      return { ...base, type: "path", points: [p] };
    case "brush":
      return { ...base, type: "brush", points: [{ ...p, w: 1 }] };
    case "hlfree":
      return {
        ...base, type: "hlfree",
        color: state.color,
        width: Math.max(state.width, 12),
        opacity: Math.min(state.opacity, 0.4),
        points: [p],
      };
    case "line":
    case "arrow":
    case "dblarrow":
    case "elbowarrow":
    case "curvedarrow":
    case "rect":
    case "rrect":
    case "ellipse":
      return { ...base, type: state.tool, points: [p, { ...p }] };
    case "poly":
      return { ...base, type: "poly", shape: state.polyShape, points: [p, { ...p }] };
    default:
      return null;
  }
}

// ---------- image annotations ----------
// Decoded <img> elements, shared by src so duplicates load once. The element is
// attached to the annot as a NON-ENUMERABLE `_img` so chrome.storage's structured
// clone (and JSON) skip it — only the serialisable `src` data-URL is persisted.
const imgCache = new Map();
let pendingImagePlace = null; // { pv, x, y } — where a picked image will land
let replaceTarget = null;     // { pv, annot } — image being swapped via the menu
let imageMenuEl = null;
let imgDelBtn = null;         // floating ✕ shown on the selected image

// A single ✕ button, re-parented to whichever page holds the selected image and
// repositioned by redraw(). Deletes the selected image on click.
function ensureImgDelBtn() {
  if (imgDelBtn) return imgDelBtn;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "img-del";
  b.textContent = "✕";
  b.title = "Delete image (Del)";
  b.setAttribute("aria-label", "Delete image");
  // swallow the gesture so the canvas underneath doesn't grab/deselect
  b.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.selected && state.selected.annot.type === "image") {
      deleteAnnot(state.selected.pv, state.selected.annot);
    }
  });
  imgDelBtn = b;
  return b;
}
function hideImgDelBtn() {
  if (imgDelBtn && imgDelBtn.parentNode) imgDelBtn.parentNode.removeChild(imgDelBtn);
}

function ensureImage(a, onReady) {
  if (a._img) return a._img;
  let img = imgCache.get(a.src);
  if (!img) {
    img = new Image();
    img.decoding = "async";
    img.src = a.src;
    imgCache.set(a.src, img);
  }
  Object.defineProperty(a, "_img", { value: img, writable: true, configurable: true, enumerable: false });
  if (!img.complete) img.addEventListener("load", () => onReady && onReady(), { once: true });
  return img;
}

function loadImageEl(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("could not decode image"));
    img.src = src;
  });
}

// Normalise any picked/dropped image to a PDF-embeddable data URL (PNG, or JPEG
// when the source is a JPEG), capping the largest side so storage stays sane.
async function fileToImageSrc(file) {
  if (!/^image\//i.test(file.type)) throw new Error("not an image file");
  const objUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageEl(objUrl);
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error("empty image");
    const maxDim = 2400;
    const k = Math.min(1, maxDim / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    const c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    c.getContext("2d").drawImage(img, 0, 0, cw, ch);
    const jpg = /jpe?g/i.test(file.type);
    const src = jpg ? c.toDataURL("image/jpeg", 0.92) : c.toDataURL("image/png");
    return { src, ratio: w / h };
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

// Place a new image annotation centred on (ux,uy) in unit space, then select it
// so it's immediately movable/resizable.
function placeImageAt(pv, ux, uy, src, ratio) {
  const vp = unitSizeOf(pv);   // works for both pdf and blank pages
  let w = Math.min(vp.w * 0.4, 260);
  let h = w / (ratio || 1);
  if (h > vp.h * 0.6) { h = vp.h * 0.6; w = h * (ratio || 1); }
  let x = ux - w / 2, y = uy - h / 2;
  x = Math.max(0, Math.min(x, vp.w - w));
  y = Math.max(0, Math.min(y, vp.h - h));
  const annot = { id: newId(), page: pv.pageNum, type: "image", src, x, y, w, h, opacity: state.opacity };
  commit({ added: [{ pv, annot }], removed: [] });
  ensureImage(annot, () => pv.redraw());
  state.selected = { pv, annot };
  state.drag = null;
  pv.redraw();
}

// Swap the picture of an existing image (undoable as remove-old + add-new).
function applyImageReplace(src, ratio) {
  const target = replaceTarget; replaceTarget = null;
  if (!target) return;
  const { pv, annot } = target;
  const idx = pv.annots.indexOf(annot);
  if (idx < 0) return;
  const updated = { ...annot, id: newId(), src, h: annot.w / (ratio || 1) }; // keep width, fix aspect
  pv.annots.splice(idx, 1, updated);                                          // _img is non-enumerable → not copied
  state.history.push({ added: [{ pv, annot: updated }], removed: [{ pv, annot }] });
  state.redo.length = 0;
  scheduleSave();
  ensureImage(updated, () => pv.redraw());
  state.selected = { pv, annot: updated };
  pv.redraw();
}

function deleteAnnot(pv, annot) {
  if (!pv.annots.includes(annot)) return;
  pv.annots = pv.annots.filter((a) => a !== annot);
  commit({ added: [], removed: [{ pv, annot }] });
  if (state.selected && state.selected.annot === annot) { state.selected = null; state.drag = null; }
  pv.redraw();
}

// Double-click menu for an image: replace the picture or delete it.
function closeImageMenu() {
  if (!imageMenuEl) return;
  imageMenuEl.remove();
  imageMenuEl = null;
  document.removeEventListener("pointerdown", onDocDownForMenu, true);
}
function onDocDownForMenu(e) {
  if (imageMenuEl && !imageMenuEl.contains(e.target)) closeImageMenu();
}
function openImageMenu(pv, annot, clientX, clientY) {
  closeImageMenu();
  const m = document.createElement("div");
  m.className = "img-menu";
  const rep = document.createElement("button");
  rep.textContent = "Replace image";
  const del = document.createElement("button");
  del.className = "danger";
  del.textContent = "Delete";
  m.append(rep, del);
  document.body.appendChild(m);
  m.style.left = Math.max(6, Math.min(clientX, window.innerWidth - m.offsetWidth - 8)) + "px";
  m.style.top = Math.max(6, Math.min(clientY, window.innerHeight - m.offsetHeight - 8)) + "px";
  rep.addEventListener("click", () => { replaceTarget = { pv, annot }; closeImageMenu(); el.imageInput.click(); });
  del.addEventListener("click", () => { closeImageMenu(); deleteAnnot(pv, annot); });
  imageMenuEl = m;
  setTimeout(() => document.addEventListener("pointerdown", onDocDownForMenu, true), 0);
}

// Map a client point to the page under it (only painted pages have a live rect).
function pageAtClient(cx, cy) {
  for (const pv of state.pages) {
    const r = pv.drawCanvas.getBoundingClientRect();
    if (r.width && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
      const s = effectiveScale();
      return { pv, x: (cx - r.left) / s, y: (cy - r.top) / s };
    }
  }
  return null;
}

function defaultPlaceTarget() {
  const pv = currentPageView();
  if (!pv) return null;
  const { w, h } = unitSizeOf(pv);
  return { pv, x: w / 2, y: h / 2 };
}

// ---------- blank pages ----------
let blankSeq = 0; // monotonic counter for blank-page uids ("b1", "b2", …)

// A page's size in unit space (PDF points at scale 1).
function unitSizeOf(pv) {
  if (pv.kind === "blank") return { w: pv.blankSize.w, h: pv.blankSize.h };
  const vp = pv.pdfPage.getViewport({ scale: 1 });
  return { w: vp.width, h: vp.height };
}

function makeBlankPageView(size, uid) {
  const pv = new PageView(0);
  pv.kind = "blank";
  pv.blankSize = { w: size.w, h: size.h };
  pv.uid = uid || ("b" + (++blankSeq));
  addBlankChrome(pv);
  return pv;
}

// Centered "Blank page" hint + hover "Remove page" button (hidden once the page
// has annotations so it never covers the user's marks).
function addBlankChrome(pv) {
  const box = document.createElement("div");
  box.className = "blank-chrome";
  const label = document.createElement("span");
  label.className = "blank-label";
  label.textContent = "Blank page";
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "blank-remove";
  rm.textContent = "✕ Remove page";
  rm.title = "Remove this blank page";
  rm.addEventListener("click", (e) => { e.stopPropagation(); removeBlankPage(pv); });
  box.append(label, rm);
  pv.root.appendChild(box);
  pv.blankChrome = box;
}

function removeBlankPage(pv) {
  const idx = state.pages.indexOf(pv);
  if (idx < 0 || pv.kind !== "blank") return;
  if (state.io) state.io.unobserve(pv.root);
  state.visible.delete(pv);
  if (state.selected && state.selected.pv === pv) { state.selected = null; state.drag = null; }
  state.pages.splice(idx, 1);
  pv.root.remove();
  renumberPages();
  scheduleSave();
  updatePageReadout();
  toast("Blank page removed");
}

// Renumber pages by array order and refresh the page count / annot.page fields.
function renumberPages() {
  state.numPages = state.pages.length;
  state.pages.forEach((pv, i) => {
    pv.pageNum = i + 1;
    pv.root.dataset.page = String(i + 1);
    for (const a of pv.annots) a.page = i + 1;
  });
}

// Insert a blank page (sized like its neighbour) directly after `refPv`.
function insertBlankPageAfter(refPv) {
  const idx = state.pages.indexOf(refPv);
  if (idx < 0) return;
  const pv = makeBlankPageView(unitSizeOf(refPv));
  state.pages.splice(idx + 1, 0, pv);
  refPv.root.after(pv.root);
  pv.root.__pv = pv;
  if (state.io) state.io.observe(pv.root);
  renumberPages();
  pv.layout(effectiveScale());
  pv.paint();
  state.visible.add(pv);
  pv.root.scrollIntoView({ block: "nearest", behavior: "smooth" });
  scheduleSave();
  updatePageReadout();
  toast(`Blank page added — now page ${pv.pageNum} of ${state.numPages}`);
}

// ---------- a single rendered page ----------
class PageView {
  constructor(pageNum) {
    this.pageNum = pageNum;
    this.kind = "pdf";      // "pdf" (backed by pdfPage) or "blank"
    this.uid = null;        // stable id for persistence: "p<srcIndex>" or "b<n>"
    this.srcIndex = null;   // pdf: 0-based index in the ORIGINAL document
    this.blankSize = null;  // blank: { w, h } in unit points
    this.pdfPage = null;
    this.viewport = null;
    this.annots = [];
    this.live = null;
    this.drawing = false;

    this.root = document.createElement("div");
    this.root.className = "page";
    this.root.dataset.page = String(pageNum);

    this.pdfCanvas = document.createElement("canvas");
    this.pdfCanvas.className = "pdf-canvas";

    this.textLayer = document.createElement("div");
    this.textLayer.className = "text-layer";

    this.drawCanvas = document.createElement("canvas");
    this.drawCanvas.className = "draw-canvas";

    // hover "＋ Blank page" control living in the gap below the page
    this.insertBar = document.createElement("div");
    this.insertBar.className = "page-insert";
    const line = document.createElement("span");
    line.className = "page-insert-line";
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "page-insert-pill";
    pill.textContent = "＋ Blank page";
    pill.title = "Insert a blank page here";
    pill.addEventListener("click", (e) => { e.stopPropagation(); insertBlankPageAfter(this); });
    this.insertBar.append(line, pill);

    this.root.append(this.pdfCanvas, this.textLayer, this.drawCanvas, this.insertBar);
    this.wirePointer();
  }

  async init(pdfDoc) {
    this.pdfPage = await pdfDoc.getPage(this.pageNum);
  }

  toUnit(e) {
    const rect = this.drawCanvas.getBoundingClientRect();
    const s = effectiveScale();
    return { x: (e.clientX - rect.left) / s, y: (e.clientY - rect.top) / s };
  }

  wirePointer() {
    const c = this.drawCanvas;
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointercancel", (e) => this.onUp(e));
    c.addEventListener("dblclick", (e) => this.onDblClick(e));
  }

  onDown(e) {
    if (imageMenuEl) closeImageMenu();
    // a freshly placed / selected image can be moved or resized under ANY tool
    if (state.selected && state.selected.pv === this && state.selected.annot.type === "image") {
      if (this.tryGrabSelection(e)) return;
    }
    if (state.tool === "hltext") return;                 // native text selection
    if (state.tool === "select") { this.selectDown(e); return; }
    if (state.tool === "eraser") { this.eraseAt(e); return; }
    if (state.tool === "image") { this.imageDown(e); return; }
    if (state.tool === "text") {
      if (this.tryGrabSelection(e)) return;              // move/resize the selected text box
      // clicking an existing text box selects it (single = move, double = edit); empty = new box
      const p = this.toUnit(e);
      const tol = 6 / effectiveScale();
      const hitText = [...this.annots].reverse().find((a) => a.type === "text" && (hitTestAnnot(a, p.x, p.y, tol) || bboxContains(annotBBox(a), p, tol)));
      if (hitText) {
        state.selected = { pv: this, annot: hitText };
        state.drag = { mode: "move", last: p, before: snapshotGeom(hitText) };
        this.drawCanvas.setPointerCapture(e.pointerId);
        this.redraw();
        return;
      }
      if (state.selected) { const pv = state.selected.pv; state.selected = null; state.drag = null; pv.redraw(); }
      this.startTextBox(e);
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;

    // direct manipulation: adjust the just-drawn shape without switching tools
    if (SHAPE_TOOLS.has(state.tool) && this.tryGrabSelection(e)) return;
    if (state.selected) { const pv = state.selected.pv; state.selected = null; state.drag = null; pv.redraw(); }

    e.preventDefault();
    this.drawCanvas.setPointerCapture(e.pointerId);
    this.drawing = true;
    this.live = annotForTool(this.pageNum, this.toUnit(e));
    this.redraw();
  }

  onMove(e) {
    if (state.drag) { this.selectMove(e); return; }       // active move/resize (any tool)
    if (state.tool === "eraser" && (e.buttons & 1)) { this.eraseAt(e); return; }
    if (!this.drawing || !this.live) return;
    const p = this.toUnit(e);
    const pathLike = this.live.type === "path" || this.live.type === "brush" || this.live.type === "hlfree";
    if (pathLike) {
      if (this.live.type === "brush") {
        // uniform on mouse; only a real stylus varies width, via true pressure
        const wf = e.pointerType === "pen" && e.pressure > 0 ? Math.max(0.25, e.pressure * 2) : 1;
        this.live.points.push({ ...p, w: wf });
      } else {
        this.live.points.push(p);
      }
    } else {
      // shape: second point tracks cursor
      this.live.points[1] = p;
    }
    this.redraw();
  }

  onUp(e) {
    if (state.drag) { this.selectUp(e); return; }         // finish move/resize (any tool)
    if (!this.drawing || !this.live) return;
    this.drawing = false;
    const a = this.live;
    this.live = null;
    // discard trivial shapes (no drag)
    if (SHAPE_TOOLS.has(a.type)) {
      const d = Math.hypot(a.points[0].x - a.points[1].x, a.points[0].y - a.points[1].y);
      if (d < 2) { this.redraw(); return; }
    }
    commit({ added: [{ pv: this, annot: a }], removed: [] });
    // auto-select fresh shapes so they can be moved/resized right away
    if (SHAPE_TOOLS.has(a.type)) state.selected = { pv: this, annot: a };
    this.redraw();
  }

  eraseAt(e) {
    const p = this.toUnit(e);
    const tol = 6 / effectiveScale();
    const hit = [];
    for (const a of this.annots) if (hitTestAnnot(a, p.x, p.y, tol)) hit.push(a);
    if (!hit.length) return;
    this.annots = this.annots.filter((a) => !hit.includes(a));
    commit({ added: [], removed: hit.map((annot) => ({ pv: this, annot })) });
    this.redraw();
  }

  // Image tool: click an existing image to select/move it, else open the OS file
  // picker and drop the chosen picture where you clicked.
  imageDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (this.tryGrabSelection(e)) return;                // grab handles/body of the selected image
    const p = this.toUnit(e);
    const tol = 6 / effectiveScale();
    const hitImg = [...this.annots].reverse().find((a) => a.type === "image" && bboxContains(annotBBox(a), p, tol));
    if (hitImg) {
      state.selected = { pv: this, annot: hitImg };
      state.drag = { mode: "move", last: p, before: snapshotGeom(hitImg) };
      this.drawCanvas.setPointerCapture(e.pointerId);
      this.redraw();
      return;
    }
    if (state.selected) { const pv = state.selected.pv; state.selected = null; state.drag = null; pv.redraw(); }
    pendingImagePlace = { pv: this, x: p.x, y: p.y };    // consumed by the image-input change handler
    el.imageInput.click();
  }

  // If the current selection is on this page and the pointer lands on one of
  // its handles or body, begin a resize/move gesture. Returns true if grabbed.
  // Works under ANY tool, so a shape can be adjusted right after drawing it.
  tryGrabSelection(e) {
    if (!state.selected || state.selected.pv !== this) return false;
    const p = this.toUnit(e);
    const s = effectiveScale();
    const a = state.selected.annot;
    const h = hitHandle(a, p, (HANDLE_PX + 5) / s);
    if (h) {
      this.drawCanvas.setPointerCapture(e.pointerId);
      state.drag = { mode: "resize", handle: h, origBox: annotBBox(a), before: snapshotGeom(a) };
      return true;
    }
    if (hitTestAnnot(a, p.x, p.y, 6 / s) || bboxContains(annotBBox(a), p, 6 / s)) {
      this.drawCanvas.setPointerCapture(e.pointerId);
      state.drag = { mode: "move", last: p, before: snapshotGeom(a) };
      return true;
    }
    return false;
  }

  // ----- Select tool: pick / move / resize -----
  selectDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (this.tryGrabSelection(e)) return;

    const p = this.toUnit(e);
    const tol = 6 / effectiveScale();
    const hit = [...this.annots].reverse().find((a) => hitTestAnnot(a, p.x, p.y, tol) || bboxContains(annotBBox(a), p, tol));
    const prev = state.selected;
    if (hit) {
      state.selected = { pv: this, annot: hit };
      this.drawCanvas.setPointerCapture(e.pointerId);
      state.drag = { mode: "move", last: p, before: snapshotGeom(hit) };
    } else {
      state.selected = null;
      state.drag = null;
    }
    if (prev && prev.pv !== this) prev.pv.redraw();
    this.redraw();
  }

  selectMove(e) {
    if (!state.drag || !state.selected) return;
    const p = this.toUnit(e);
    if (state.drag.mode === "move") {
      translateAnnot(state.selected.annot, p.x - state.drag.last.x, p.y - state.drag.last.y);
      state.drag.last = p;
    } else {
      resizeAnnot(state.selected.annot, state.drag, p);
    }
    this.redraw();
  }

  selectUp() {
    if (!state.drag) return;
    const sel = state.selected;
    const before = state.drag.before;
    state.drag = null;
    if (sel) {
      const after = snapshotGeom(sel.annot);
      if (JSON.stringify(before) !== JSON.stringify(after)) commitEdit(sel.pv, sel.annot, before, after);
      sel.pv.redraw();
    }
  }

  // cheap: size the page box (placeholder) at the current scale — no canvas work
  layout(scale) {
    this.scale = scale;
    const vp = this.kind === "blank"
      ? { width: this.blankSize.w * scale, height: this.blankSize.h * scale }
      : this.pdfPage.getViewport({ scale });
    this.viewport = vp;
    this.root.style.width = Math.floor(vp.width) + "px";
    this.root.style.height = Math.floor(vp.height) + "px";
    if (this._painted && this._paintedScale !== scale) this._paintedScale = null; // needs repaint
  }

  // heavy: actually render the PDF image + text + draw layers. Called only for
  // pages near the viewport (lazy rendering — 298 pages won't all paint at once).
  async paint() {
    if (!this.viewport) return;
    if (this.kind === "blank") { this.paintBlank(); return; }
    if (this._painting) return;
    if (this._painted && this._paintedScale === this.scale) return;
    this._painting = true;
    try {
      const vp = this.viewport;
      const w = Math.floor(vp.width), h = Math.floor(vp.height);

      // supersample vector/text PDFs (render ≥2× device res → crisp, dark glyphs);
      // scanned rasters gain nothing from it, so keep them at DPR
      const os = state.rasterScan ? DPR : Math.max(DPR, 2);
      this.pdfCanvas.width = Math.floor(w * os);
      this.pdfCanvas.height = Math.floor(h * os);
      this.pdfCanvas.style.width = w + "px";
      this.pdfCanvas.style.height = h + "px";
      const ctx = this.pdfCanvas.getContext("2d");
      ctx.setTransform(os, 0, 0, os, 0, 0);
      if (this._renderTask) this._renderTask.cancel();
      this._renderTask = this.pdfPage.render({ canvasContext: ctx, viewport: vp });
      await this._renderTask.promise;
      this._renderTask = null;

      this.drawCanvas.width = Math.floor(w * DPR);
      this.drawCanvas.height = Math.floor(h * DPR);
      this.drawCanvas.style.width = w + "px";
      this.drawCanvas.style.height = h + "px";

      await this.renderTextLayer(this.scale);
      this.redraw();
      this._painted = true;
      this._paintedScale = this.scale;
    } catch (e) {
      if (e && e.name !== "RenderingCancelledException") { /* ignore */ }
    } finally {
      this._painting = false;
    }
  }

  // blank page: no PDF/text to render — just size the draw layer (the white .page
  // background shows through) and paint any annotations onto it.
  paintBlank() {
    if (this._painted && this._paintedScale === this.scale) return;
    const w = Math.floor(this.viewport.width), h = Math.floor(this.viewport.height);
    this.drawCanvas.width = Math.floor(w * DPR);
    this.drawCanvas.height = Math.floor(h * DPR);
    this.drawCanvas.style.width = w + "px";
    this.drawCanvas.style.height = h + "px";
    this.redraw();
    this._painted = true;
    this._paintedScale = this.scale;
  }

  // free the pixel buffers of an off-screen page to cap memory (keeps placeholder)
  unpaint() {
    if (this._renderTask) { try { this._renderTask.cancel(); } catch { /* */ } this._renderTask = null; }
    if (!this._painted) return;
    this.pdfCanvas.width = 0; this.pdfCanvas.height = 0;
    this.drawCanvas.width = 0; this.drawCanvas.height = 0;
    this._painted = false;
    this._paintedScale = null;
  }

  // Selectable text layer (renders once; zoom only updates --scale-factor).
  async renderTextLayer(scale) {
    this.textLayer.style.setProperty("--scale-factor", String(scale));
    if (this._textRendered || this._textRendering) return;
    this._textRendering = true;
    try {
      const textContent = await this.pdfPage.getTextContent();
      this.textLayer.replaceChildren();
      const task = pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: this.textLayer,
        viewport: this.viewport,
      });
      await task.promise;
      this.addSelectionSink();   // pdf.js "endOfContent" trick — tames selection
      this._textRendered = true;
    } catch {
      // best-effort: scanned/image PDFs have no text layer → freehand highlight only
    } finally {
      this._textRendering = false;
    }
  }

  // pdf.js "endOfContent" sink: an empty block that, while selecting, expands to
  // cover the layer so a drag past a line's end can't jump into the next block.
  addSelectionSink() {
    const div = this.textLayer;
    if (!div.querySelector(".endOfContent")) {
      const end = document.createElement("div");
      end.className = "endOfContent";
      div.appendChild(end);
    }
    if (this._sinkBound) return;   // bind the drag listeners only once per page
    this._sinkBound = true;

    div.addEventListener("mousedown", (evt) => {
      const e = div.querySelector(".endOfContent");
      if (!e) return;
      let adjustTop = evt.target !== div;
      adjustTop &&= getComputedStyle(e).getPropertyValue("-moz-user-select") !== "none";
      if (adjustTop) {
        const b = div.getBoundingClientRect();
        const r = Math.max(0, (evt.clientY - b.top) / b.height);
        e.style.top = (r * 100).toFixed(2) + "%";
      }
      e.classList.add("active");
    });
    div.addEventListener("mouseup", () => {
      const e = div.querySelector(".endOfContent");
      if (!e) return;
      e.style.top = "";
      e.classList.remove("active");
    });
  }

  // Inline editable text box; commits a 'text' annotation on blur/Enter.
  // Shared inline text editor with a live resize grip.
  // `live` = reflect the toolbar Size/Color/Font while typing. onCommit(text, fontUnit).
  openTextEditor({ x, y, value, fontUnit, family, color, live, onCommit, onCancel }) {
    const s0 = effectiveScale();
    let curFont = fontUnit;
    let curX = x, curY = y;

    const ta = document.createElement("textarea");
    ta.className = "textbox-edit";
    ta.value = value || "";
    ta.style.left = curX * s0 + "px";
    ta.style.top = curY * s0 + "px";
    ta.style.fontSize = curFont * s0 + "px";
    ta.style.fontFamily = cssFontFamily(family);
    ta.style.color = color;
    ta.rows = 1;
    this.root.appendChild(ta);

    const grip = document.createElement("div");     // bottom-right: resize
    grip.className = "textbox-grip";
    this.root.appendChild(grip);
    const moveGrip = document.createElement("div");  // top-left: move
    moveGrip.className = "textbox-move";
    this.root.appendChild(moveGrip);

    const placeGrip = () => {
      const s = effectiveScale();
      ta.style.left = curX * s + "px";
      ta.style.top = curY * s + "px";
      grip.style.left = parseFloat(ta.style.left) + ta.offsetWidth - 6 + "px";
      grip.style.top = parseFloat(ta.style.top) + ta.offsetHeight - 6 + "px";
      moveGrip.style.left = parseFloat(ta.style.left) - 6 + "px";
      moveGrip.style.top = parseFloat(ta.style.top) - 6 + "px";
    };
    const autosize = () => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
      ta.style.width = "auto";
      ta.style.width = Math.max(60, ta.scrollWidth + 6) + "px";
      placeGrip();
    };
    const setFont = (unit) => {
      curFont = Math.max(8, unit);
      ta.style.fontSize = curFont * effectiveScale() + "px";
      autosize();
    };
    ta.addEventListener("input", autosize);

    if (live) {
      // toolbar Size/Color/Font change the box as you type
      activeEdit = {
        refresh: () => {
          curFont = Math.max(12, state.width * 4);
          ta.style.color = state.color;
          ta.style.fontFamily = cssFontFamily(state.fontFamily);
          setFont(curFont);
        },
      };
    }

    let busy = false; // dragging a grip — keep the editor open

    // bottom-right grip → scale the text live
    grip.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      busy = true;
      grip.setPointerCapture(ev.pointerId);
      const startY = ev.clientY;
      const startFont = curFont;
      const lines = Math.max(1, ta.value.split("\n").length);
      const onMove = (mv) => setFont(startFont + (mv.clientY - startY) / effectiveScale() / (lines * 1.25));
      const onUpG = () => {
        busy = false;
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUpG);
        ta.focus();
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUpG);
    });

    // top-left grip → move the box anywhere, while writing
    moveGrip.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      busy = true;
      moveGrip.setPointerCapture(ev.pointerId);
      const s = effectiveScale();
      const startX = ev.clientX, startY = ev.clientY, ox = curX, oy = curY;
      const onMove = (mv) => {
        curX = ox + (mv.clientX - startX) / s;
        curY = oy + (mv.clientY - startY) / s;
        placeGrip();
      };
      const onUpM = () => {
        busy = false;
        moveGrip.removeEventListener("pointermove", onMove);
        moveGrip.removeEventListener("pointerup", onUpM);
        ta.focus();
      };
      moveGrip.addEventListener("pointermove", onMove);
      moveGrip.addEventListener("pointerup", onUpM);
    });

    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      if (live) activeEdit = null;
      ta.removeEventListener("blur", onBlur);
      const text = ta.value;
      ta.remove();
      grip.remove();
      moveGrip.remove();
      if (keep && text.trim()) onCommit(text, curFont, curX, curY);
      else if (onCancel) onCancel();
    };
    const onBlur = (ev) => {
      // keep the editor open while dragging a grip
      if (busy || (ev && (ev.relatedTarget === grip || ev.relatedTarget === moveGrip))) return;
      finish(true);
    };
    ta.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      else if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); ta.blur(); }
    });

    requestAnimationFrame(() => {
      ta.focus();
      if (value) ta.select();
      autosize();
      ta.addEventListener("blur", onBlur);
    });
  }

  startTextBox(e) {
    e.preventDefault(); // keep focus off the canvas so the box survives this click
    const p = this.toUnit(e);
    this.openTextEditor({
      x: p.x, y: p.y, value: "", live: true,
      fontUnit: Math.max(12, state.width * 4), family: state.fontFamily, color: state.color,
      onCommit: (text, fontUnit, x, y) => {
        const annot = {
          id: newId(), page: this.pageNum, type: "text",
          x, y, text, fontSize: fontUnit,
          fontFamily: state.fontFamily, color: state.color, opacity: state.opacity,
        };
        commit({ added: [{ pv: this, annot }], removed: [] });
        state.selected = { pv: this, annot }; // auto-select → movable/resizable at once
        this.redraw();
      },
    });
  }

  // double-click a text box to re-edit its words in place
  editTextBox(annot) {
    const idx = this.annots.indexOf(annot);
    if (idx < 0) return;
    this.annots.splice(idx, 1);        // hide the original while editing
    state.selected = null; state.drag = null;
    this.redraw();
    this.openTextEditor({
      x: annot.x, y: annot.y, value: annot.text, live: false,
      fontUnit: annot.fontSize || 16, family: annot.fontFamily || "sans", color: annot.color,
      onCommit: (text, fontUnit, x, y) => {
        const updated = { ...annot, text, fontSize: fontUnit, x, y };
        this.annots.splice(idx, 0, updated);
        state.history.push({ added: [{ pv: this, annot: updated }], removed: [{ pv: this, annot }] });
        state.redo.length = 0;
        scheduleSave();
        state.selected = { pv: this, annot: updated };
        this.redraw();
      },
      onCancel: () => { this.annots.splice(idx, 0, annot); this.redraw(); },
    });
  }

  onDblClick(e) {
    if (state.tool === "hltext") return;
    const p = this.toUnit(e);
    const tol = 6 / effectiveScale();
    const hitImg = [...this.annots].reverse().find((a) => a.type === "image" && bboxContains(annotBBox(a), p, tol));
    if (hitImg) {
      e.preventDefault();
      state.selected = { pv: this, annot: hitImg };
      state.drag = null;
      this.redraw();
      openImageMenu(this, hitImg, e.clientX, e.clientY);
      return;
    }
    const hit = [...this.annots].reverse().find((a) => a.type === "text" && (hitTestAnnot(a, p.x, p.y, tol) || bboxContains(annotBBox(a), p, tol)));
    if (hit) { e.preventDefault(); this.editTextBox(hit); }
  }

  redraw() {
    if (!this.viewport) return;
    const ctx = this.drawCanvas.getContext("2d");
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, this.viewport.width, this.viewport.height);
    const s = effectiveScale();

    // read-aloud: highlight the sentence currently being spoken
    if (this._readRects) {
      ctx.save();
      ctx.fillStyle = "rgba(59,130,246,0.28)";
      for (const r of this._readRects) ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
      ctx.restore();
    }

    // kick off decoding of any image annots; each redraws this page when ready
    for (const a of this.annots) if (a.type === "image") ensureImage(a, () => this.redraw());

    // highlights first (under everything), composited flat per color so
    // overlapping highlights don't stack into darker patches
    drawGroupedHighlights(ctx, this.annots, s, this);
    for (const a of this.annots) if (a.type !== "hltext" && a.type !== "hlfree") drawAnnotation(ctx, a, s);
    if (this.live) drawAnnotation(ctx, this.live, s);
    if (state.selected && state.selected.pv === this) drawSelectionChrome(ctx, state.selected.annot, s);

    // floating ✕ delete button, top-right of a selected image (offset clear of the handle)
    if (state.selected && state.selected.pv === this && state.selected.annot.type === "image") {
      const a = state.selected.annot;
      const b = ensureImgDelBtn();
      if (b.parentNode !== this.root) this.root.appendChild(b);
      b.style.left = ((a.x + a.w) * s + 4) + "px";
      b.style.top = (a.y * s - 24) + "px";
    } else if (imgDelBtn && imgDelBtn.parentNode === this.root) {
      hideImgDelBtn();
    }

    // blank pages: show the "Blank page / Remove" hint only while empty
    if (this.kind === "blank" && this.blankChrome) {
      this.blankChrome.style.display = this.annots.length ? "none" : "flex";
    }
  }
}

// ---------- history ----------
function commit(entry) {
  // apply is already done by caller for removes; for adds, push into pv.annots
  for (const { pv, annot } of entry.added) if (!pv.annots.includes(annot)) pv.annots.push(annot);
  state.history.push(entry);
  state.redo.length = 0;
  if (state.history.length > 500) state.history.shift();
  scheduleSave();
}

function undo() {
  const entry = state.history.pop();
  if (!entry) return;
  for (const { pv, annot } of entry.added || []) pv.annots = pv.annots.filter((a) => a !== annot);
  for (const { pv, annot } of entry.removed || []) if (!pv.annots.includes(annot)) pv.annots.push(annot);
  for (const { annot, before } of entry.edits || []) applyGeom(annot, before);
  state.redo.push(entry);
  pruneSelection();
  touchedPages(entry).forEach((pv) => pv.redraw());
  scheduleSave();
}

function redo() {
  const entry = state.redo.pop();
  if (!entry) return;
  for (const { pv, annot } of entry.removed || []) pv.annots = pv.annots.filter((a) => a !== annot);
  for (const { pv, annot } of entry.added || []) if (!pv.annots.includes(annot)) pv.annots.push(annot);
  for (const { annot, after } of entry.edits || []) applyGeom(annot, after);
  state.history.push(entry);
  pruneSelection();
  touchedPages(entry).forEach((pv) => pv.redraw());
  scheduleSave();
}

function touchedPages(entry) {
  const set = new Set();
  [...(entry.added || []), ...(entry.removed || []), ...(entry.edits || [])].forEach(({ pv }) => set.add(pv));
  return set;
}

// drop the selection if its annotation is no longer on the page (e.g. after undo)
function pruneSelection() {
  if (state.selected && !state.selected.pv.annots.includes(state.selected.annot)) {
    state.selected = null;
    state.drag = null;
  }
}

function clearCurrentPage() {
  const pv = currentPageView();
  if (!pv || !pv.annots.length) return;
  const removed = pv.annots.map((annot) => ({ pv, annot }));
  pv.annots = [];
  state.history.push({ added: [], removed });
  state.redo.length = 0;
  pv.redraw();
  scheduleSave();
  toast(`Cleared page ${pv.pageNum} — undo with Ctrl+Z`);
}

// ---------- persistence (chrome.storage, keyed by PDF hash) ----------
function storageKey() { return "pdfdraw:" + state.docId; }

function serialize() {
  // v2: full page order (incl. inserted blanks) + annots keyed by STABLE uid, so
  // inserting/removing pages never mis-maps saved markup on reload.
  const order = state.pages.map((pv) => pv.kind === "blank"
    ? { uid: pv.uid, kind: "blank", w: pv.blankSize.w, h: pv.blankSize.h }
    : { uid: pv.uid, kind: "pdf", srcIndex: pv.srcIndex });
  const annots = {};
  for (const pv of state.pages) if (pv.annots.length) annots[pv.uid] = pv.annots;
  return { v: 2, savedAt: Date.now(), label: state.sourceLabel, order, annots };
}

async function saveAnnots(manual) {
  if (!state.docId) return;
  try {
    await api.storage.local.set({ [storageKey()]: serialize() });
    if (manual) toast("Saved ✓");
  } catch (e) {
    toast("Save failed: " + e.message, 3500);
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveAnnots(false), 700);
}

async function loadAnnots() {
  if (!state.docId) return;
  let stored;
  try {
    const got = await api.storage.local.get(storageKey());
    stored = got[storageKey()];
  } catch { return; }
  if (!stored) return;

  let count = 0, blanks = 0;
  if (stored.v === 2 && Array.isArray(stored.order)) {
    // rebuild the page order, recreating any saved blank pages
    const pdfByUid = new Map(state.pages.map((pv) => [pv.uid, pv]));
    const order = [];
    let maxBlank = 0;
    for (const e of stored.order) {
      if (e.kind === "blank") {
        order.push(makeBlankPageView({ w: e.w, h: e.h }, e.uid));
        blanks++;
        const n = parseInt(String(e.uid).replace(/^b/, ""), 10);
        if (Number.isFinite(n)) maxBlank = Math.max(maxBlank, n);
      } else {
        const pv = pdfByUid.get(e.uid) || pdfByUid.get("p" + e.srcIndex);
        if (pv) order.push(pv);
      }
    }
    for (const pv of state.pages) if (!order.includes(pv)) order.push(pv); // safety: keep any missing pdf pages
    blankSeq = Math.max(blankSeq, maxBlank);
    state.pages = order;
    el.pages.replaceChildren(...order.map((pv) => pv.root));
    for (const pv of state.pages) {
      const arr = stored.annots && stored.annots[pv.uid];
      if (Array.isArray(arr)) { pv.annots = arr; count += arr.length; }
    }
    renumberPages();
  } else if (stored.pages) {
    // v1: annots keyed by original pageNum (no blanks existed) → map by position
    for (const pv of state.pages) {
      const arr = stored.pages[pv.pageNum];
      if (Array.isArray(arr)) { pv.annots = arr; count += arr.length; }
    }
  }

  if (count || blanks) {
    const parts = [];
    if (count) parts.push(`${count} annotation${count > 1 ? "s" : ""}`);
    if (blanks) parts.push(`${blanks} blank page${blanks > 1 ? "s" : ""}`);
    toast(`Restored ${parts.join(" + ")}`);
  }
}

// ---------- export flattened PDF ----------
// One entry per output page IN DISPLAY ORDER (every page, so the exporter can place
// inserted blanks at the right indices). `blank` pages carry their size.
function buildOutPages() {
  return state.pages.map((pv) => {
    // merge text highlights per color so the exported PDF matches the screen
    const groups = new Map();
    for (const a of pv.annots) {
      if (a.type !== "hltext") continue;
      const k = `${a.color}|${a.opacity}`;
      let g = groups.get(k);
      if (!g) { g = { color: a.color, opacity: a.opacity, rects: [] }; groups.set(k, g); }
      for (const r of a.rects || []) g.rects.push({ ...r });
    }
    const mergedHl = [...groups.values()].map((g) => ({
      type: "hltext", color: g.color, opacity: g.opacity, rects: mergeLineRects(g.rects),
    }));
    const others = pv.annots.filter((a) => a.type !== "hltext");
    const size = unitSizeOf(pv);
    return { blank: pv.kind === "blank", w: size.w, h: size.h, annots: [...mergedHl, ...others] };
  });
}

function exportName() {
  const base = shortLabel(state.sourceLabel || "document").replace(/\.pdf$/i, "");
  return `${base} (annotated).pdf`;
}

// Uint8Array → base64 (chunked so large PDFs don't blow the call stack).
function bytesToB64(u8) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

// Open the split view, handing the currently-open PDF to its first pane so it
// stays open; the second pane starts empty for the user to pick another file.
const SPLIT_HANDOFF_KEY = "puff:split-handoff";
async function openSplitView() {
  try {
    if (state.pdfBytes) {
      await api.storage.local.set({ [SPLIT_HANDOFF_KEY]: { b64: bytesToB64(state.pdfBytes), name: state.sourceLabel || "document.pdf" } });
    } else {
      await api.storage.local.remove(SPLIT_HANDOFF_KEY);   // no stale doc for an empty split
    }
  } catch { /* handoff is best-effort */ }
  window.open("split.html", "_blank");
}

function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportPdf() {
  if (!state.pdfBytes) { toast("Open a PDF first"); return; }
  const outPages = buildOutPages();
  const hasMarkup = outPages.some((op) => op.blank || op.annots.length);
  if (!hasMarkup) { toast("Nothing to export yet — draw something or add a page"); return; }
  const name = exportName();
  toast("Building PDF…", 60000);
  postToShell({ __puff: "export", phase: "start", name });   // split view: show which PDF is exporting
  try {
    const { bytes, rotatedWarn } = await exportAnnotatedPdf(state.pdfBytes, outPages);
    downloadBytes(bytes, name);
    toast(rotatedWarn ? "Exported (note: rotated pages may be offset)" : "Exported ✓");
    postToShell({ __puff: "export", phase: "done", name });
  } catch (e) {
    toast("Export failed: " + e.message, 4000);
    postToShell({ __puff: "export", phase: "error", name, message: e.message });
  }
}

// ---------- document loading ----------
async function loadFromArrayBuffer(buf, label) {
  const docId = await sha1Hex(buf);
  state.pdfBytes = new Uint8Array(buf.slice(0));       // retained for export
  const data = new Uint8Array(buf.slice(0));           // pdf.js detaches this one
  const pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  await onDocLoaded(pdfDoc, docId, label);
}

async function loadFromUrl(url) {
  toast("Loading PDF…", 60000);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${resp.status}`);
  const buf = await resp.arrayBuffer();
  await loadFromArrayBuffer(buf, url);
}

async function onDocLoaded(pdfDoc, docId, label) {
  state.pdfDoc = pdfDoc;
  state.numPages = pdfDoc.numPages;
  state.docId = docId;
  state.sourceLabel = label;
  state.history = [];
  state.redo = [];

  el.dropzone.classList.add("hidden");
  el.pages.innerHTML = "";
  state.pages = [];

  if (state.io) { state.io.disconnect(); state.io = null; }
  state.visible = new Set();

  blankSeq = 0;
  for (let i = 1; i <= state.numPages; i++) {
    const pv = new PageView(i);
    pv.kind = "pdf";
    pv.uid = "p" + (i - 1);   // stable id independent of later inserts
    pv.srcIndex = i - 1;      // original 0-based index, for export
    await pv.init(pdfDoc);
    el.pages.appendChild(pv.root);
    state.pages.push(pv);
  }

  const nativeText = await detectTextLayer();
  const scan = await detectRasterScan();    // key off actual image content, not text layer
  state.rasterScan = scan.isRaster;         // scanned/image page → don't upscale past native
  state.scanIdealScale = scan.idealScale;

  computeFitScale();
  await loadAnnots();                       // may re-insert saved blank pages → do before layout
  relayoutAll();                            // size all page placeholders incl. blanks (cheap)
  const ocrRestored = await loadOcrCache(); // restore any previously-OCR'd pages (by stable uid)
  state.hasText = nativeText || ocrRestored;
  reflectTextAvailability();
  setupPageObserver();                      // now paint only pages near the viewport
  updatePageReadout();

  if (nativeText) {
    toast(`Loaded ${state.numPages} page${state.numPages > 1 ? "s" : ""}`);
  } else if (ocrRestored) {
    toast("Loaded — recognized text restored. Run 🔎 OCR on other pages as needed.", 4500);
  } else {
    toast("This PDF is scanned (no text). Click 🔎 OCR to make the current page selectable, or use the freehand highlighter (M).", 6000);
  }
  el.docName.textContent = shortLabel(label);
  document.title = "Puff PDF — " + shortLabel(label);
  setTool(state.tool);   // sync tool UI / show the properties bar now a doc is open
  syncShell();           // tell the split-view shell this pane's new doc/readout
}

// Does this PDF have a usable text layer? Sample the first few pages.
async function detectTextLayer() {
  for (const pv of state.pages.slice(0, 4)) {
    try {
      const tc = await pv.pdfPage.getTextContent();
      if (tc.items.some((i) => (i.str || "").trim().length)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

// Is this a scanned/image PDF (each page dominated by a raster image)? Keys off
// actual image ops — a scanned book with a hidden OCR text layer still counts.
// Also reports idealScale = the scale at which the scan renders 1:1 with source.
async function detectRasterScan() {
  const OPS = pdfjsLib.OPS || {};
  const imgOps = new Set(
    [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter((v) => typeof v === "number")
  );
  let scanned = 0, checked = 0, idealScale = Infinity;
  for (const pv of state.pages.slice(0, 4)) {
    try {
      const ops = await pv.pdfPage.getOperatorList();
      checked++;
      let has = false, maxW = 0;
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (imgOps.has(ops.fnArray[i])) {
          has = true;
          const a = ops.argsArray[i];
          const w = a && typeof a[1] === "number" ? a[1] : 0; // image intrinsic width
          if (w > maxW) maxW = w;
        }
      }
      // a real scanned page = basically just an image; a vector page (incl.
      // outlined text) has hundreds of path/fill ops even with no fonts.
      if (has && ops.fnArray.length < 25) {
        scanned++;
        const ptW = pv.pdfPage.getViewport({ scale: 1 }).width;
        if (maxW > 0 && ptW > 0) idealScale = Math.min(idealScale, maxW / ptW);
      }
    } catch { /* ignore */ }
  }
  return { isRaster: checked > 0 && scanned / checked >= 0.5, idealScale };
}

function reflectTextAvailability() {
  const btn = document.querySelector('.tb-tool[data-tool="hltext"]');
  if (!btn) return;
  btn.classList.toggle("disabled", !state.hasText);
  btn.dataset.tip = state.hasText
    ? "Highlight text — drag across words, snaps to them (H)"
    : "Unavailable — this PDF is scanned. Run OCR (🔎) first, or use the freehand highlighter (M).";
  syncShell();
}

// ---------- OCR: build a selectable text layer over a scanned page ----------
// `words` are in unit space: { text, x, y, w, h }.
function buildOcrTextLayer(pv, words) {
  pv.textLayer.replaceChildren();
  const kept = [];
  for (const wd of words) {
    if (!wd.text || !wd.text.trim() || wd.w <= 0 || wd.h <= 0) continue;
    const span = document.createElement("span");
    span.textContent = wd.text;
    span.dataset.i = String(kept.length);
    span.style.left = `calc(var(--scale-factor) * ${wd.x}px)`;
    span.style.top = `calc(var(--scale-factor) * ${wd.y}px)`;
    span.style.fontSize = `calc(var(--scale-factor) * ${wd.h}px)`;
    span.style.fontFamily = "sans-serif";
    // stretch the transparent glyphs to fill the OCR word box (scale-independent ratio)
    measureCtx.font = `${wd.h}px sans-serif`;
    const natural = measureCtx.measureText(wd.text).width || wd.w;
    span.style.transform = `scaleX(${(wd.w / natural).toFixed(3)})`;
    pv.textLayer.appendChild(span);
    kept.push(wd);
  }
  pv._ocrWords = kept;   // used to snap highlights to real word boxes
  pv.addSelectionSink();
  pv._textRendered = true;
  pv._ocrDone = true;
}

// Recognize one page: render image → OCR → build text layer → cache. Returns word count.
async function ocrOnePage(pv, onProgress) {
  if (pv._ocrDone) return 0;
  const vp1 = pv.pdfPage.getViewport({ scale: 1 });
  const ocrScale = Math.min(3.5, Math.max(1.5, 2000 / vp1.width));
  const vp = pv.pdfPage.getViewport({ scale: ocrScale });

  const c = document.createElement("canvas");
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  const cx = c.getContext("2d");
  cx.fillStyle = "#fff";
  cx.fillRect(0, 0, c.width, c.height);
  await pv.pdfPage.render({ canvasContext: cx, viewport: vp }).promise;

  setOcrProgress((m) => { if (m.status === "recognizing text" && onProgress) onProgress(m.progress || 0); });
  let words;
  try {
    words = await ocrCanvas(c);
  } finally {
    setOcrProgress(null);
  }

  const unit = words.map((w) => ({
    text: w.text,
    x: w.x0 / ocrScale, y: w.y0 / ocrScale,
    w: (w.x1 - w.x0) / ocrScale, h: (w.y1 - w.y0) / ocrScale,
  }));
  buildOcrTextLayer(pv, unit);
  state.hasText = true;
  reflectTextAvailability();
  try { await api.storage.local.set({ [`ocr:${state.docId}:${pv.uid}`]: unit }); } catch { /* ignore */ }
  return unit.length;
}

async function ocrCurrentPage() {
  if (!globalThis.Tesseract) { toast("OCR engine failed to load"); return; }
  const pv = currentPageView();
  if (!pv) { toast("Open a PDF first"); return; }
  if (pv.kind === "blank") { toast("This is a blank page — nothing to recognize."); return; }
  if (pv._ocrDone) { toast(`Page ${pv.pageNum} is already recognized`); return; }
  toast("OCR: rendering page…", 60000);
  try {
    const n = await ocrOnePage(pv, (p) => toast(`OCR page ${pv.pageNum}: ${Math.round(p * 100)}%`, 60000));
    toast(`OCR done — ${n} words on page ${pv.pageNum}. Select & highlight now work.`, 4000);
  } catch (e) {
    toast("OCR failed: " + e.message, 4000);
  }
}

function setOcrAllBtn(running) {
  const btn = document.getElementById("btn-ocr-all");
  if (!btn) return;
  btn.textContent = running ? "⏹ Stop" : "🔎 All";
  btn.dataset.tip = running ? "Stop OCR (Esc)" : "OCR every page (runs in background, cancellable)";
  syncShell();
}

// Recognize all pages sequentially (cancellable). Re-click / Esc to stop.
async function ocrAllPages() {
  if (state.ocrRunning) { state.ocrCancel = true; return; }
  if (!globalThis.Tesseract) { toast("OCR engine failed to load"); return; }
  const pending = state.pages.filter((pv) => pv.kind !== "blank" && !pv._ocrDone);
  if (!pending.length) { toast("All pages are already recognized"); return; }

  state.ocrRunning = true;
  state.ocrCancel = false;
  setOcrAllBtn(true);
  toast(`OCR all: ${pending.length} page(s) to go — this can take a while. Click Stop or press Esc to cancel.`, 5000);

  let done = 0;
  for (const pv of pending) {
    if (state.ocrCancel) break;
    try {
      await ocrOnePage(pv, (p) =>
        toast(`OCR ${done + 1}/${pending.length} (page ${pv.pageNum}): ${Math.round(p * 100)}%`, 60000)
      );
    } catch { /* skip a failed page, keep going */ }
    done++;
  }

  state.ocrRunning = false;
  setOcrAllBtn(false);
  toast(state.ocrCancel ? `OCR stopped — ${done} page(s) done.` : `OCR complete — ${done} page(s) recognized.`, 4000);
}

// ---------- read aloud (SpeechSynthesis) ----------
const synth = window.speechSynthesis;
const reader = { active: false, paused: false, pvIndex: 0, pv: null, sentences: [], si: 0, rate: 1, voice: null };

// Build sentences (with on-page rects) from a page's rendered text-layer spans.
function pageSentences(pv) {
  const spans = [...pv.textLayer.querySelectorAll("span")];
  if (!spans.length) return [];
  const pr = pv.drawCanvas.getBoundingClientRect();
  const s = effectiveScale();
  let text = "";
  const map = [];
  for (const sp of spans) {
    const t = sp.textContent;
    if (!t) continue;
    const r = sp.getBoundingClientRect();
    const start = text.length;
    text += t + " ";
    map.push({ start, end: text.length, rect: { x: (r.left - pr.left) / s, y: (r.top - pr.top) / s, w: r.width / s, h: r.height / s } });
  }
  const sentences = [];
  const re = /[^.!?]+[.!?]*\s*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const str = m[0].trim();
    if (!str) continue;
    const s0 = m.index, s1 = m.index + m[0].length;
    const rects = map.filter((mp) => mp.start < s1 && mp.end > s0).map((mp) => mp.rect);
    sentences.push({ text: str, rects });
  }
  return sentences;
}

function clearReadHighlight() {
  for (const pv of state.pages) if (pv._readRects) { pv._readRects = null; pv.redraw(); }
}

function loadReaderPage() {
  reader.pv = state.pages[reader.pvIndex];
  reader.sentences = reader.pv ? pageSentences(reader.pv) : [];
  reader.si = 0;
}

function startReading() {
  if (!("speechSynthesis" in window)) { toast("Read-aloud not supported in this browser"); return; }
  const pv = currentPageView();
  if (!pv) { toast("Open a PDF first"); return; }
  synth.cancel();
  reader.active = true;
  reader.paused = false;
  reader.pvIndex = state.pages.indexOf(pv);
  loadReaderPage();
  if (!reader.sentences.length) { toast("No text on this page — run OCR first."); reader.active = false; return; }
  document.getElementById("read-bar").classList.remove("hidden");
  updateReadUI();
  speakNextSentence();
}

async function speakNextSentence() {
  if (!reader.active) return;
  if (reader.si >= reader.sentences.length) {           // page done → next page
    clearReadHighlight();
    if (reader.pvIndex >= state.pages.length - 1) { stopReading(); toast("Finished reading"); return; }
    reader.pvIndex++;
    const pv = state.pages[reader.pvIndex];
    pv.root.scrollIntoView({ block: "start", behavior: "smooth" });
    await pv.paint();
    await new Promise((r) => setTimeout(r, 60)); // let layout settle
    loadReaderPage();
    return speakNextSentence();
  }
  const sen = reader.sentences[reader.si];
  clearReadHighlight();
  reader.pv._readRects = sen.rects;
  reader.pv.redraw();

  const u = new SpeechSynthesisUtterance(sen.text);
  u.rate = reader.rate;
  if (reader.voice) u.voice = reader.voice;
  u.onend = () => { if (reader.active && !reader.paused) { reader.si++; speakNextSentence(); } };
  u.onerror = () => { if (reader.active) { reader.si++; speakNextSentence(); } };
  synth.speak(u);
}

function toggleReadPause() {
  if (!reader.active) return;
  if (reader.paused) { reader.paused = false; synth.resume(); }
  else { reader.paused = true; synth.pause(); }
  updateReadUI();
}

function stopReading() {
  reader.active = false;
  reader.paused = false;
  synth.cancel();
  clearReadHighlight();
  document.getElementById("read-bar").classList.add("hidden");
}

function updateReadUI() {
  const btn = document.getElementById("rb-play");
  if (btn) btn.textContent = reader.paused ? "▶" : "⏸";
}

function wireReadAloud() {
  const bar = document.getElementById("read-bar");
  if (!bar) return;
  document.getElementById("btn-read").addEventListener("click", startReading);
  document.getElementById("rb-play").addEventListener("click", toggleReadPause);
  document.getElementById("rb-stop").addEventListener("click", stopReading);
  document.getElementById("rb-rate").addEventListener("input", (e) => { reader.rate = +e.target.value; });

  const voiceSel = document.getElementById("rb-voice");
  const fillVoices = () => {
    const voices = synth.getVoices();
    if (!voices.length) return;
    voiceSel.innerHTML = "";
    voices.forEach((v, i) => {
      const o = document.createElement("option");
      o.value = i; o.textContent = `${v.name} (${v.lang})`;
      voiceSel.appendChild(o);
    });
    const en = voices.findIndex((v) => /^en/i.test(v.lang));
    voiceSel.value = en >= 0 ? en : 0;
    reader.voice = voices[+voiceSel.value];
  };
  fillVoices();
  if ("speechSynthesis" in window) synth.onvoiceschanged = fillVoices;
  voiceSel.addEventListener("change", () => { reader.voice = synth.getVoices()[+voiceSel.value]; });
}

async function loadOcrCache() {
  if (!state.docId) return;
  let all;
  try { all = await api.storage.local.get(null); } catch { return; }
  const prefix = `ocr:${state.docId}:`;
  const byUid = new Map(state.pages.map((pv) => [pv.uid, pv]));
  let any = false;
  for (const k of Object.keys(all)) {
    if (!k.startsWith(prefix)) continue;
    const suffix = k.slice(prefix.length);
    let pv = byUid.get(suffix);
    if (!pv && /^\d+$/.test(suffix)) pv = byUid.get("p" + (parseInt(suffix, 10) - 1)); // legacy numeric key
    if (pv && Array.isArray(all[k])) { buildOcrTextLayer(pv, all[k]); any = true; }
  }
  return any;
}

function shortLabel(label) {
  try {
    const u = new URL(label);
    return decodeURIComponent(u.pathname.split("/").pop() || u.hostname);
  } catch {
    return label || "document";
  }
}

// ---------- zoom / render ----------
const MAX_PAGE_WIDTH = 1400; // px — cap so ultra-wide monitors don't over-zoom

// Default: fit the page to the available width (fills the stage), capped so a
// 4K monitor doesn't blow it up absurdly. Zoom controls adjust from there.
function computeFitScale() {
  if (!state.pages.length) return;
  // fit the WIDEST page (mixed-size PDFs have landscape pages) so none overflows
  // horizontally; for uniform PDFs this equals the first page's width.
  let maxW = 0;
  for (const pv of state.pages) maxW = Math.max(maxW, unitSizeOf(pv).w);
  if (!maxW) return;
  const avail = Math.min(el.stage.clientWidth - 48, MAX_PAGE_WIDTH);
  let s = avail / maxW;
  // for scans, don't enlarge past the source's own pixels (upscaling = blur)
  if (state.rasterScan) s = Math.min(s, state.scanIdealScale);
  state.baseScale = Math.max(0.2, Math.min(3, s));
  state.scale = 1.0;
}

// Explicit "Fit" button: fill the available width (may upscale).
function fitToWidth() {
  if (!state.pages.length) return;
  let maxW = 0;
  for (const pv of state.pages) maxW = Math.max(maxW, unitSizeOf(pv).w);
  if (!maxW) return;
  const avail = Math.min(el.stage.clientWidth - 48, MAX_PAGE_WIDTH);
  state.baseScale = Math.max(0.2, avail / maxW);
  state.scale = 1.0;
  rerender();
}

// Lazy rendering: size every page (cheap), paint only near-viewport pages.
function relayoutAll() {
  const s = effectiveScale();
  for (const pv of state.pages) pv.layout(s);
  el.zoomLabel.textContent = Math.round(state.scale * 100) + "%";
  syncShell();
}

async function repaintVisible() {
  for (const pv of [...state.visible]) await pv.paint();
}

function rerender() {
  relayoutAll();
  repaintVisible();
}

function setupPageObserver() {
  if (state.io) state.io.disconnect();
  state.io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const pv = e.target.__pv;
        if (!pv) continue;
        if (e.isIntersecting) { state.visible.add(pv); pv.paint(); }
        else { state.visible.delete(pv); pv.unpaint(); }
      }
    },
    { root: el.stage, rootMargin: "1000px 0px", threshold: 0 }
  );
  for (const pv of state.pages) { pv.root.__pv = pv; state.io.observe(pv.root); }
}

let rerenderTimer = null;
function scheduleRerender() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(rerender, 120);
}

function setZoom(mult) {
  state.scale = Math.min(5, Math.max(0.2, state.scale * mult));
  scheduleRerender();
}

// ---------- current page (by viewport center) ----------
function currentPageView() {
  if (!state.pages.length) return null;
  const mid = el.stage.scrollTop + el.stage.clientHeight / 2;
  let cur = state.pages[0];
  for (const pv of state.pages) {
    if (pv.root.offsetTop <= mid) cur = pv;
    else break;
  }
  return cur;
}

function updatePageReadout() {
  if (!state.numPages) { el.pageReadout.textContent = "— / —"; }
  else {
    const pv = currentPageView();
    el.pageReadout.textContent = `${pv ? pv.pageNum : 1} / ${state.numPages}`;
  }
  syncShell();
}

// ---------- toolbar ----------
function setTool(tool) {
  if (tool === "hltext" && !state.hasText) {
    toast("No text layer in this PDF — switched to the freehand highlighter.", 3500);
    tool = "hlfree";
  }
  state.tool = tool;
  document.querySelectorAll(".tb-tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  el.pages.dataset.mode = tool;

  if (tool !== "select" && state.selected) {   // leaving select clears the selection
    const pv = state.selected.pv;
    state.selected = null; state.drag = null;
    pv.redraw();
  }

  // contextual properties bar: hidden for select; width hidden for tools that ignore it
  el.properties.classList.toggle("hidden", tool === "select");
  const shape = tool === "poly" ? state.polyShape : tool;
  el.toolName.textContent = tool === "poly" ? shape[0].toUpperCase() + shape.slice(1) : (TOOL_LABELS[tool] || "");
  el.propWidth.classList.toggle("hidden", NO_WIDTH_TOOLS.has(tool));
  el.propFont.classList.toggle("hidden", tool !== "text");

  // sync the Shapes rail button (it stands in for all shape tools)
  const shapesBtn = document.getElementById("btn-shapes");
  if (shapesBtn) shapesBtn.classList.toggle("active", SHAPE_TOOLS.has(tool));
  if (SHAPE_TOOLS.has(tool)) {
    const u = document.getElementById("shapes-icon-use");
    if (u) u.setAttribute("href", "#i-" + shape);
  }
}

// Precise highlight rects: instead of the Range's coarse line-box rects (which
// stretch to the container edge and bleed across paragraph gaps), clip the
// selection to each individual text-layer span and take that substring's rects.
// Result: rectangles hug the actual selected glyphs only.
function preciseSelectionRectsByPage() {
  const byPage = new Map();
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return byPage;
  const range = sel.getRangeAt(0);
  const s = effectiveScale();

  for (const pv of state.pages) {
    if (!range.intersectsNode(pv.textLayer)) continue;
    const pr = pv.drawCanvas.getBoundingClientRect();
    const push = (q) => (byPage.get(pv) || byPage.set(pv, []).get(pv)).push(q);

    for (const span of pv.textLayer.children) {
      const node = span.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      if (!range.intersectsNode(node)) continue;

      // OCR pages: snap to the real word box (uniform bars, no font-metric drift)
      if (pv._ocrWords) {
        const wd = pv._ocrWords[+span.dataset.i];
        if (wd) push({ x: wd.x, y: wd.y, w: wd.w, h: wd.h });   // exact word box, no padding
        continue;
      }

      // native text: clip selection to this text node and use its glyph rects
      const sub = document.createRange();
      sub.setStart(node, node === range.startContainer ? range.startOffset : 0);
      sub.setEnd(node, node === range.endContainer ? range.endOffset : node.length);
      if (sub.collapsed) continue;
      for (const cr of sub.getClientRects()) {
        if (cr.width < 0.5 || cr.height < 0.5) continue;
        push({ x: (cr.left - pr.left) / s, y: (cr.top - pr.top) / s, w: cr.width / s, h: cr.height / s });
      }
    }
  }
  return byPage;
}

function hlScratch(pv) {
  let c = pv._hlScratch;
  if (!c) { c = document.createElement("canvas"); pv._hlScratch = c; }
  if (c.width !== pv.drawCanvas.width || c.height !== pv.drawCanvas.height) {
    c.width = pv.drawCanvas.width;
    c.height = pv.drawCanvas.height;
  }
  return c;
}

// Render highlights (hltext + hlfree) as a flat layer per (color,opacity):
// draw opaque into an offscreen canvas, then blit the whole layer once at the
// group's opacity. Overlaps become a single uniform shade — no alpha stacking.
function drawGroupedHighlights(ctx, annots, s, pv) {
  const groups = new Map();
  for (const a of annots) {
    if (a.type !== "hltext" && a.type !== "hlfree") continue;
    const key = `${a.color}|${a.opacity ?? 1}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(a);
  }
  if (!groups.size) return;

  const off = hlScratch(pv);
  const octx = off.getContext("2d");
  for (const items of groups.values()) {
    const opacity = items[0].opacity ?? 1;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, off.width, off.height);
    octx.setTransform(DPR, 0, 0, DPR, 0, 0);
    for (const a of items) drawAnnotation(octx, { ...a, opacity: 1 }, s); // opaque
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = opacity;
    ctx.drawImage(off, 0, 0);
    ctx.restore(); // restores the DPR transform + alpha the caller set
  }
}

// Merge rects that sit on the same line into single bars (cleaner, fewer objects).
function mergeLineRects(qs) {
  if (qs.length < 2) return qs;
  qs.sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const q of qs) {
    const last = out[out.length - 1];
    const sameLine = last && Math.abs(last.y - q.y) <= Math.max(last.h, q.h) * 0.6;
    if (sameLine && q.x <= last.x + last.w + 2) {
      const right = Math.max(last.x + last.w, q.x + q.w);
      last.x = Math.min(last.x, q.x);
      last.w = right - last.x;
      last.y = Math.min(last.y, q.y);
      last.h = Math.max(last.h, q.h);
    } else {
      out.push({ ...q });
    }
  }
  return out;
}

// ---------- selection / move / resize geometry (unit space) ----------
function annotBBox(a) {
  if (a.type === "image") return { x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 };
  if (a.type === "hltext") {
    const rs = a.rects || [];
    if (!rs.length) return { x: 0, y: 0, w: 0, h: 0 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rs) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  if (a.type === "text") {
    const fs = a.fontSize || 16;
    const lines = String(a.text || "").split("\n");
    const w = Math.max(1, ...lines.map((l) => l.length)) * fs * 0.55;
    return { x: a.x, y: a.y, w, h: lines.length * fs * 1.25 };
  }
  const P = a.points || [];
  if (!P.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of P) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function bboxContains(b, p, tol) {
  return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
}

function getHandles(a) {
  if (a.type === "curvedarrow") {
    const c = a.points[2] || defaultControl(a.points[0], a.points[1]);
    return [
      { id: "p0", x: a.points[0].x, y: a.points[0].y },
      { id: "p1", x: a.points[1].x, y: a.points[1].y },
      { id: "pc", x: c.x, y: c.y }, // drag to bend the curve
    ];
  }
  if (ENDPOINT_SHAPES.has(a.type)) {
    return [{ id: "p0", x: a.points[0].x, y: a.points[0].y }, { id: "p1", x: a.points[1].x, y: a.points[1].y }];
  }
  const b = annotBBox(a), mx = b.x + b.w / 2, my = b.y + b.h / 2;
  return [
    { id: "nw", x: b.x, y: b.y }, { id: "n", x: mx, y: b.y }, { id: "ne", x: b.x + b.w, y: b.y },
    { id: "e", x: b.x + b.w, y: my }, { id: "se", x: b.x + b.w, y: b.y + b.h }, { id: "s", x: mx, y: b.y + b.h },
    { id: "sw", x: b.x, y: b.y + b.h }, { id: "w", x: b.x, y: my },
  ];
}

function hitHandle(a, p, tol) {
  for (const h of getHandles(a)) if (Math.abs(h.x - p.x) <= tol && Math.abs(h.y - p.y) <= tol) return h.id;
  return null;
}

function translateAnnot(a, dx, dy) {
  if (a.type === "hltext") { for (const r of a.rects) { r.x += dx; r.y += dy; } return; }
  if (a.type === "text" || a.type === "image") { a.x += dx; a.y += dy; return; }
  for (const p of a.points) { p.x += dx; p.y += dy; }
}

function resizeAnnot(a, drag, p) {
  const before = drag.before;
  if (drag.handle === "pc") {                           // curved-arrow control point
    a.points[2] = { x: p.x, y: p.y };
    return;
  }
  if (drag.handle === "p0" || drag.handle === "p1") {   // line/arrow endpoint
    const i = drag.handle === "p0" ? 0 : 1;
    a.points[i].x = p.x; a.points[i].y = p.y;
    return;
  }
  const ob = drag.origBox;
  let left = ob.x, right = ob.x + ob.w, top = ob.y, bottom = ob.y + ob.h;
  const H = drag.handle;
  if (H.includes("w")) left = p.x;
  if (H.includes("e")) right = p.x;
  if (H.includes("n")) top = p.y;
  if (H.includes("s")) bottom = p.y;
  const nb = { x: Math.min(left, right), y: Math.min(top, bottom), w: Math.abs(right - left), h: Math.abs(bottom - top) };
  const sx = ob.w ? nb.w / ob.w : 1, sy = ob.h ? nb.h / ob.h : 1;
  const mapX = (x) => nb.x + (x - ob.x) * sx;
  const mapY = (y) => nb.y + (y - ob.y) * sy;
  if (a.type === "hltext") {
    a.rects = before.rects.map((r) => ({ x: mapX(r.x), y: mapY(r.y), w: r.w * sx, h: r.h * sy }));
  } else if (a.type === "text") {
    a.x = mapX(before.x); a.y = mapY(before.y);
    a.fontSize = Math.max(6, (before.fontSize || 16) * sy);
  } else if (a.type === "image") {
    a.x = mapX(before.x); a.y = mapY(before.y);
    a.w = Math.max(1, (before.w || 0) * sx);
    a.h = Math.max(1, (before.h || 0) * sy);
  } else {
    a.points = before.points.map((pt) => ({ ...pt, x: mapX(pt.x), y: mapY(pt.y) }));
  }
}

function snapshotGeom(a) {
  return JSON.parse(JSON.stringify({ points: a.points, rects: a.rects, x: a.x, y: a.y, w: a.w, h: a.h, fontSize: a.fontSize }));
}
function applyGeom(a, snap) {
  if (snap.points !== undefined) a.points = JSON.parse(JSON.stringify(snap.points));
  if (snap.rects !== undefined) a.rects = JSON.parse(JSON.stringify(snap.rects));
  if (snap.x !== undefined) a.x = snap.x;
  if (snap.y !== undefined) a.y = snap.y;
  if (snap.w !== undefined) a.w = snap.w;
  if (snap.h !== undefined) a.h = snap.h;
  if (snap.fontSize !== undefined) a.fontSize = snap.fontSize;
}

function commitEdit(pv, annot, before, after) {
  state.history.push({ edits: [{ pv, annot, before, after }] });
  state.redo.length = 0;
  if (state.history.length > 500) state.history.shift();
  scheduleSave();
}

function drawSelectionChrome(ctx, a, s) {
  const b = annotBBox(a);
  ctx.save();
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(b.x * s, b.y * s, b.w * s, b.h * s);
  ctx.setLineDash([]);
  const hs = HANDLE_PX;
  for (const h of getHandles(a)) {
    if (h.id === "pc") {
      // curve control point: a filled accent circle to distinguish it
      ctx.beginPath();
      ctx.arc(h.x * s, h.y * s, hs / 2 + 1, 0, Math.PI * 2);
      ctx.fillStyle = "#3b82f6";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.strokeStyle = "#3b82f6";
    } else {
      ctx.fillStyle = "#fff";
      ctx.fillRect(h.x * s - hs / 2, h.y * s - hs / 2, hs, hs);
      ctx.strokeRect(h.x * s - hs / 2, h.y * s - hs / 2, hs, hs);
    }
  }
  ctx.restore();
}

// Turn the current native text selection into a 'hltext' annotation (per page).
function commitTextHighlightFromSelection() {
  const byPage = preciseSelectionRectsByPage();
  if (!byPage.size) return;

  const added = [];
  for (const [pv, qs] of byPage) {
    added.push({
      pv,
      annot: {
        id: newId(), page: pv.pageNum, type: "hltext",
        color: state.color, opacity: Math.min(state.opacity, 0.4),
        rects: mergeLineRects(qs),
      },
    });
  }
  commit({ added, removed: [] });
  added.forEach(({ pv }) => pv.redraw());
  window.getSelection().removeAllRanges();
}

function buildSwatches() {
  SWATCHES.forEach((c, i) => {
    const s = document.createElement("div");
    s.className = "swatch" + (i === 0 ? " active" : "");
    s.style.background = c;
    s.dataset.color = c;
    s.addEventListener("click", () => { setColor(c, s); if (activeEdit) activeEdit.refresh(); });
    el.swatches.appendChild(s);
  });
}
function setColor(c, swatchEl) {
  state.color = c;
  el.color.value = c;
  document.querySelectorAll(".swatch").forEach((x) => x.classList.remove("active"));
  if (swatchEl) swatchEl.classList.add("active");
}

function wireToolbar() {
  document.getElementById("btn-open").addEventListener("click", () => el.fileInput.click());
  const splitBtn = document.getElementById("btn-split");
  if (splitBtn) splitBtn.addEventListener("click", openSplitView);
  document.getElementById("btn-zoom-in").addEventListener("click", () => setZoom(1.15));
  document.getElementById("btn-zoom-out").addEventListener("click", () => setZoom(1 / 1.15));
  document.getElementById("btn-fit").addEventListener("click", fitToWidth);

  document.querySelectorAll(".tb-tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));

  const liveText = () => { if (activeEdit) activeEdit.refresh(); };
  el.color.addEventListener("input", () => { setColor(el.color.value, null); liveText(); });
  el.width.addEventListener("input", () => { state.width = +el.width.value; liveText(); });
  el.opacity.addEventListener("input", () => (state.opacity = +el.opacity.value / 100));
  el.font.addEventListener("change", () => { state.fontFamily = el.font.value; liveText(); });

  document.getElementById("btn-undo").addEventListener("click", undo);
  document.getElementById("btn-redo").addEventListener("click", redo);
  document.getElementById("btn-clear").addEventListener("click", clearCurrentPage);
  document.getElementById("btn-save").addEventListener("click", () => saveAnnots(true));
  document.getElementById("btn-export").addEventListener("click", exportPdf);
  document.getElementById("btn-ocr").addEventListener("click", ocrCurrentPage);
  document.getElementById("btn-ocr-all").addEventListener("click", ocrAllPages);
}

function wireKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
    if (e.key === "Escape" && state.ocrRunning) { state.ocrCancel = true; return; }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected) {
      e.preventDefault();
      const { pv, annot } = state.selected;
      pv.annots = pv.annots.filter((a) => a !== annot);
      commit({ added: [], removed: [{ pv, annot }] });
      state.selected = null; state.drag = null;
      pv.redraw();
      return;
    }
    if (e.key === "Escape" && state.selected) {
      const pv = state.selected.pv;
      state.selected = null; state.drag = null;
      pv.redraw();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveAnnots(true); }
    else if (mod && e.key.toLowerCase() === "e") { e.preventDefault(); exportPdf(); }
    else if (!mod) {
      const map = { p: "pen", b: "brush", h: "hltext", m: "hlfree", l: "line", a: "arrow", r: "rect", o: "ellipse", t: "text", i: "image", e: "eraser", v: "select" };
      const t = map[e.key.toLowerCase()];
      if (t) {
        // in split view the tool is shared: let the shell switch every pane
        if (EMBED) postToShell({ __puff: "toolKey", tool: t });
        else setTool(t);
      }
    }
  });
}

// ---------- split-view embed bridge (postMessage to/from the shell) ----------
function postToShell(msg) {
  if (EMBED && window.parent && window.parent !== window) window.parent.postMessage(msg, "*");
}

// Report this pane's readout so the shared toolbar can mirror the active pane.
function syncShell() {
  if (!EMBED) return;
  const pv = currentPageView();
  postToShell({
    __puff: "state",
    hasDoc: !!state.pdfDoc,
    docName: state.sourceLabel ? shortLabel(state.sourceLabel) : "",
    page: pv ? pv.pageNum : 0,
    numPages: state.numPages,
    zoom: Math.round(state.scale * 100),
    hasText: state.hasText,
    ocrRunning: state.ocrRunning,
  });
}

// Commands from the shared toolbar → drive this pane through existing functions.
function onShellMessage(e) {
  const m = e.data;
  if (!m || m.__puff !== "cmd") return;
  switch (m.cmd) {
    case "tool": if (m.tool === "poly" && m.shape) state.polyShape = m.shape; setTool(m.tool); break;
    case "color": setColor(m.color, null); if (activeEdit) activeEdit.refresh(); break;
    case "width": state.width = m.value; if (activeEdit) activeEdit.refresh(); break;
    case "opacity": state.opacity = m.value / 100; break;
    case "font": state.fontFamily = m.value; if (activeEdit) activeEdit.refresh(); break;
    case "undo": undo(); break;
    case "redo": redo(); break;
    case "clear": clearCurrentPage(); break;
    case "save": saveAnnots(true); break;
    case "export": exportPdf(); break;
    case "ocrPage": ocrCurrentPage(); break;
    case "ocrAll": ocrAllPages(); break;
    case "read": startReading(); break;
    case "zoomIn": setZoom(1.15); break;
    case "zoomOut": setZoom(1 / 1.15); break;
    case "fit": fitToWidth(); break;
    case "loadBuffer": loadFromArrayBuffer(m.buf, m.name || "document.pdf").catch((err) => toast("Open failed: " + err.message)); break;
    case "loadUrl": loadFromUrl(m.url).catch((err) => toast("Could not load PDF: " + err.message)); break;
    case "requestState": syncShell(); break;
  }
}

function wireEmbed() {
  if (!EMBED) return;
  document.body.classList.add("embed");
  window.addEventListener("message", onShellMessage);
  // clicking anywhere in this pane makes it the active pane
  el.stage.addEventListener("pointerdown", () => postToShell({ __puff: "focus" }), true);
  el.dropzone.addEventListener("pointerdown", () => postToShell({ __puff: "focus" }), true);
  // tell the shell we're ready to receive commands (tool sync, queued loads)
  postToShell({ __puff: "ready" });
}

// ---------- file open / drag-drop ----------
function wireFileEntry() {
  el.fileInput.addEventListener("change", async () => {
    const f = el.fileInput.files[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    await loadFromArrayBuffer(buf, f.name).catch((e) => toast("Open failed: " + e.message));
    el.fileInput.value = "";
  });

  document.getElementById("dz-pick").addEventListener("click", () => el.fileInput.click());

  // picked an image (via the Image tool, or the Replace menu)
  el.imageInput.addEventListener("change", async () => {
    const f = el.imageInput.files[0];
    el.imageInput.value = "";
    if (!f) { pendingImagePlace = null; replaceTarget = null; return; }
    try {
      const { src, ratio } = await fileToImageSrc(f);
      if (replaceTarget) {
        applyImageReplace(src, ratio);
      } else {
        const t = pendingImagePlace || defaultPlaceTarget();
        if (t) placeImageAt(t.pv, t.x, t.y, src, ratio);
      }
    } catch (err) {
      toast("Couldn't add image: " + err.message, 3500);
    } finally {
      pendingImagePlace = null;
    }
  });

  ["dragenter", "dragover"].forEach((ev) =>
    el.stage.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    el.stage.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove("dragover"); })
  );
  el.stage.addEventListener("drop", async (e) => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    // an image dropped onto an open PDF becomes an image annotation where it landed
    if (/^image\//i.test(f.type)) {
      if (!state.pdfDoc) { toast("Open a PDF first, then drop images onto it."); return; }
      const t = pageAtClient(e.clientX, e.clientY) || defaultPlaceTarget();
      if (!t) return;
      try {
        const { src, ratio } = await fileToImageSrc(f);
        placeImageAt(t.pv, t.x, t.y, src, ratio);
      } catch (err) {
        toast("Couldn't add image: " + err.message, 3500);
      }
      return;
    }
    const buf = await f.arrayBuffer();
    await loadFromArrayBuffer(buf, f.name).catch((err) => toast("Open failed: " + err.message));
  });
}

// ---------- boot ----------
// ---------- hover tooltips ----------
function wireTooltips() {
  const tip = document.createElement("div");
  tip.id = "tip";
  document.body.appendChild(tip);

  const show = (text, target) => {
    tip.textContent = text;
    tip.style.display = "block";
    const r = target.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
    let top = r.bottom + 6;
    if (top + tr.height > window.innerHeight - 6) top = r.top - tr.height - 6;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  };
  const hide = () => { tip.style.display = "none"; };

  document.querySelectorAll("[data-tip]").forEach((elm) => {
    elm.addEventListener("mouseenter", () => show(elm.getAttribute("data-tip"), elm));
    elm.addEventListener("mouseleave", hide);
    elm.addEventListener("mousedown", hide);
  });
}

// Shapes flyout: one rail button opens a grid of shapes (keeps the rail compact).
function wireShapesFlyout() {
  const btn = document.getElementById("btn-shapes");
  const fly = document.getElementById("shapes-flyout");
  if (!btn || !fly) return;

  const pick = (shape) => {
    if (BASE_SHAPES.has(shape)) setTool(shape);
    else { state.polyShape = shape; setTool("poly"); }
    fly.querySelectorAll(".shape-opt").forEach((o) => o.classList.toggle("active", o.dataset.shape === shape));
    fly.classList.add("hidden");
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (fly.classList.contains("hidden")) {
      const r = btn.getBoundingClientRect();
      fly.classList.remove("hidden");
      fly.style.left = r.right + 8 + "px";
      fly.style.top = Math.max(8, r.top - 8) + "px";
    } else {
      fly.classList.add("hidden");
    }
  });
  fly.querySelectorAll(".shape-opt").forEach((o) => o.addEventListener("click", () => pick(o.dataset.shape)));
  document.addEventListener("click", (e) => {
    if (!fly.contains(e.target) && !btn.contains(e.target)) fly.classList.add("hidden");
  });
}

function boot() {
  buildSwatches();
  wireToolbar();
  wireFileEntry();
  wireKeyboard();
  wireTooltips();
  wireShapesFlyout();
  wireReadAloud();
  wireEmbed();
  setTool("pen");

  el.stage.addEventListener("scroll", updatePageReadout, { passive: true });
  window.addEventListener("resize", () => { if (state.pdfDoc) scheduleRerender(); });

  // text-snap highlighter: convert a completed selection into a highlight
  document.addEventListener("mouseup", () => {
    if (state.tool === "hltext") setTimeout(commitTextHighlightFromSelection, 0);
  });

  const params = new URLSearchParams(location.search);
  const fileUrl = params.get("file");
  const pick = params.get("pick");

  if (fileUrl) {
    el.dropzone.classList.add("hidden");
    loadFromUrl(fileUrl).catch((e) => {
      el.dropzone.classList.remove("hidden");
      el.dropzone.classList.add("active");
      toast("Could not load PDF: " + e.message, 4000);
    });
  } else {
    el.dropzone.classList.add("active");
    el.properties.classList.add("hidden");   // no controls until a PDF is open
    if (pick) el.fileInput.click();
  }
}

boot();
