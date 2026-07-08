// PDF Draw — viewer core
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
  rect: "Rectangle", rrect: "Rounded rect", ellipse: "Ellipse", text: "Text", eraser: "Eraser",
};
const NO_WIDTH_TOOLS = new Set(["hltext", "eraser"]);

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

// ---------- a single rendered page ----------
class PageView {
  constructor(pageNum) {
    this.pageNum = pageNum;
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

    this.root.append(this.pdfCanvas, this.textLayer, this.drawCanvas);
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
    if (state.tool === "hltext") return;                 // native text selection
    if (state.tool === "select") { this.selectDown(e); return; }
    if (state.tool === "eraser") { this.eraseAt(e); return; }
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
    const vp = this.pdfPage.getViewport({ scale });
    this.viewport = vp;
    this.root.style.width = Math.floor(vp.width) + "px";
    this.root.style.height = Math.floor(vp.height) + "px";
    if (this._painted && this._paintedScale !== scale) this._paintedScale = null; // needs repaint
  }

  // heavy: actually render the PDF image + text + draw layers. Called only for
  // pages near the viewport (lazy rendering — 298 pages won't all paint at once).
  async paint() {
    if (!this.viewport) return;
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
    const hit = [...this.annots].reverse().find((a) => a.type === "text" && (hitTestAnnot(a, p.x, p.y, tol) || bboxContains(annotBBox(a), p, tol)));
    if (hit) { e.preventDefault(); this.editTextBox(hit); }
  }

  redraw() {
    if (!this.viewport) return;
    const ctx = this.drawCanvas.getContext("2d");
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, this.viewport.width, this.viewport.height);
    const s = effectiveScale();

    // highlights first (under everything), composited flat per color so
    // overlapping highlights don't stack into darker patches
    drawGroupedHighlights(ctx, this.annots, s, this);
    for (const a of this.annots) if (a.type !== "hltext" && a.type !== "hlfree") drawAnnotation(ctx, a, s);
    if (this.live) drawAnnotation(ctx, this.live, s);
    if (state.selected && state.selected.pv === this) drawSelectionChrome(ctx, state.selected.annot, s);
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
  const pages = {};
  for (const pv of state.pages) if (pv.annots.length) pages[pv.pageNum] = pv.annots;
  return { v: 1, savedAt: Date.now(), label: state.sourceLabel, pages };
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
  if (!stored || !stored.pages) return;
  let count = 0;
  for (const pv of state.pages) {
    const arr = stored.pages[pv.pageNum];
    if (Array.isArray(arr)) { pv.annots = arr; count += arr.length; pv.redraw(); }
  }
  if (count) toast(`Restored ${count} saved annotation${count > 1 ? "s" : ""}`);
}

// ---------- export flattened PDF ----------
function pageAnnotSnapshot() {
  return state.pages
    .filter((pv) => pv.annots.length)
    .map((pv) => {
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
        type: "hltext", page: pv.pageNum, color: g.color, opacity: g.opacity, rects: mergeLineRects(g.rects),
      }));
      const others = pv.annots.filter((a) => a.type !== "hltext");
      return { pageNum: pv.pageNum, annots: [...mergedHl, ...others] };
    });
}

function exportName() {
  const base = shortLabel(state.sourceLabel || "document").replace(/\.pdf$/i, "");
  return `${base} (annotated).pdf`;
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
  const snap = pageAnnotSnapshot();
  if (!snap.length) { toast("Nothing to export yet — draw something"); return; }
  toast("Building PDF…", 60000);
  try {
    const { bytes, rotatedWarn } = await exportAnnotatedPdf(state.pdfBytes, snap);
    downloadBytes(bytes, exportName());
    toast(rotatedWarn ? "Exported (note: rotated pages may be offset)" : "Exported ✓");
  } catch (e) {
    toast("Export failed: " + e.message, 4000);
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

  for (let i = 1; i <= state.numPages; i++) {
    const pv = new PageView(i);
    await pv.init(pdfDoc);
    el.pages.appendChild(pv.root);
    state.pages.push(pv);
  }

  const nativeText = await detectTextLayer();
  const scan = await detectRasterScan();    // key off actual image content, not text layer
  state.rasterScan = scan.isRaster;         // scanned/image page → don't upscale past native
  state.scanIdealScale = scan.idealScale;

  computeFitScale();
  relayoutAll();                            // size all page placeholders (cheap)
  await loadAnnots();                       // restore saved markup
  const ocrRestored = await loadOcrCache(); // restore any previously-OCR'd pages
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
  document.title = "PDF Draw — " + shortLabel(label);
  setTool(state.tool);   // sync tool UI / show the properties bar now a doc is open
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
  try { await api.storage.local.set({ [`ocr:${state.docId}:${pv.pageNum}`]: unit }); } catch { /* ignore */ }
  return unit.length;
}

async function ocrCurrentPage() {
  if (!globalThis.Tesseract) { toast("OCR engine failed to load"); return; }
  const pv = currentPageView();
  if (!pv) { toast("Open a PDF first"); return; }
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
}

// Recognize all pages sequentially (cancellable). Re-click / Esc to stop.
async function ocrAllPages() {
  if (state.ocrRunning) { state.ocrCancel = true; return; }
  if (!globalThis.Tesseract) { toast("OCR engine failed to load"); return; }
  const pending = state.pages.filter((pv) => !pv._ocrDone);
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

async function loadOcrCache() {
  if (!state.docId) return;
  let all;
  try { all = await api.storage.local.get(null); } catch { return; }
  const prefix = `ocr:${state.docId}:`;
  let any = false;
  for (const k of Object.keys(all)) {
    if (!k.startsWith(prefix)) continue;
    const pv = state.pages[(+k.slice(prefix.length)) - 1];
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
  const first = state.pages[0];
  if (!first) return;
  const vpAt1 = first.pdfPage.getViewport({ scale: 1 });
  const avail = Math.min(el.stage.clientWidth - 48, MAX_PAGE_WIDTH);
  let s = avail / vpAt1.width;
  // for scans, don't enlarge past the source's own pixels (upscaling = blur)
  if (state.rasterScan) s = Math.min(s, state.scanIdealScale);
  state.baseScale = Math.max(0.2, Math.min(3, s));
  state.scale = 1.0;
}

// Explicit "Fit" button: fill the available width (may upscale).
function fitToWidth() {
  const first = state.pages[0];
  if (!first) return;
  const vpAt1 = first.pdfPage.getViewport({ scale: 1 });
  const avail = Math.min(el.stage.clientWidth - 48, MAX_PAGE_WIDTH);
  state.baseScale = Math.max(0.2, avail / vpAt1.width);
  state.scale = 1.0;
  rerender();
}

// Lazy rendering: size every page (cheap), paint only near-viewport pages.
function relayoutAll() {
  const s = effectiveScale();
  for (const pv of state.pages) pv.layout(s);
  el.zoomLabel.textContent = Math.round(state.scale * 100) + "%";
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
  if (!state.numPages) { el.pageReadout.textContent = "— / —"; return; }
  const pv = currentPageView();
  el.pageReadout.textContent = `${pv ? pv.pageNum : 1} / ${state.numPages}`;
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
  if (a.type === "text") { a.x += dx; a.y += dy; return; }
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
  } else {
    a.points = before.points.map((pt) => ({ ...pt, x: mapX(pt.x), y: mapY(pt.y) }));
  }
}

function snapshotGeom(a) {
  return JSON.parse(JSON.stringify({ points: a.points, rects: a.rects, x: a.x, y: a.y, fontSize: a.fontSize }));
}
function applyGeom(a, snap) {
  if (snap.points !== undefined) a.points = JSON.parse(JSON.stringify(snap.points));
  if (snap.rects !== undefined) a.rects = JSON.parse(JSON.stringify(snap.rects));
  if (snap.x !== undefined) a.x = snap.x;
  if (snap.y !== undefined) a.y = snap.y;
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
      const map = { p: "pen", b: "brush", h: "hltext", m: "hlfree", l: "line", a: "arrow", r: "rect", o: "ellipse", t: "text", e: "eraser", v: "select" };
      if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
    }
  });
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

  ["dragenter", "dragover"].forEach((ev) =>
    el.stage.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    el.stage.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove("dragover"); })
  );
  el.stage.addEventListener("drop", async (e) => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
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
