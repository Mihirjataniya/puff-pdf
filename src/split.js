// Split view shell. Hosts each PDF as an embedded viewer (viewer.html?embed=1)
// and drives the active pane from one shared toolbar via postMessage.
//
// - tool / colour / size / opacity / font  →  broadcast to ALL panes (shared)
// - undo / save / export / OCR / zoom / …   →  sent to the ACTIVE pane only
// - each pane reports its readout + focus back so the toolbar mirrors it

const api = globalThis.browser || globalThis.chrome;
const IFRAME_SRC = "viewer.html?embed=1";
const HANDOFF_KEY = "puff:split-handoff";

function b64ToBuffer(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

const SWATCHES = ["#e11d48", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#111827", "#ffffff"];
const TOOL_LABELS = {
  select: "Select", pen: "Pen", brush: "Brush", hltext: "Highlight text",
  hlfree: "Highlighter", line: "Line", arrow: "Arrow", dblarrow: "Double arrow",
  elbowarrow: "Elbow arrow", curvedarrow: "Curved arrow", rect: "Rectangle",
  rrect: "Rounded rect", ellipse: "Ellipse", text: "Text", image: "Image", eraser: "Eraser",
};
const NO_WIDTH_TOOLS = new Set(["hltext", "eraser", "image"]);
const SHAPE_TOOLS = new Set(["line", "arrow", "dblarrow", "elbowarrow", "curvedarrow", "rect", "rrect", "ellipse", "poly"]);
const BASE_SHAPES = new Set(["line", "arrow", "dblarrow", "elbowarrow", "curvedarrow", "rect", "rrect", "ellipse"]);

// shared tool/style state (mirrors the single toolbar)
const tools = { tool: "pen", color: "#e11d48", width: 3, opacity: 1, polyShape: "triangle", fontFamily: "sans" };

const byId = (id) => document.getElementById(id);
const el = {
  panes: byId("panes"), swatches: byId("swatches"), color: byId("color"),
  width: byId("width"), opacity: byId("opacity"), font: byId("font"),
  properties: byId("properties"), toolName: byId("tool-name"),
  propWidth: byId("prop-width"), propFont: byId("prop-font"),
  zoomLabel: byId("zoom-label"), pageReadout: byId("page-readout"),
  fileInput: byId("file-input"),
};

let panes = [];        // { id, wrap, iframe, title, ready, queue[] }
let activeId = null;
let seq = 0;
let pendingTarget = null;      // pane id awaiting the shell file picker
const paneState = new Map();   // id → last {state} message from that pane

const paneById = (id) => panes.find((p) => p.id === id);
const activePane = () => paneById(activeId);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

// ---------- messaging ----------
function postCmd(pane, cmd, transfer) {
  if (!pane) return;
  if (!pane.ready && !transfer) { pane.queue.push(cmd); return; }
  pane.iframe.contentWindow.postMessage({ __puff: "cmd", ...cmd }, "*", transfer || []);
}
function sendActive(cmd) { postCmd(activePane(), cmd); }
function broadcast(cmd) { for (const p of panes) postCmd(p, cmd); }

// push the current shared tool/style into a freshly-ready pane
function syncPaneTools(pane) {
  postCmd(pane, { cmd: "color", color: tools.color });
  postCmd(pane, { cmd: "width", value: tools.width });
  postCmd(pane, { cmd: "opacity", value: Math.round(tools.opacity * 100) });
  postCmd(pane, { cmd: "font", value: tools.fontFamily });
  postCmd(pane, { cmd: "tool", tool: tools.tool, shape: tools.tool === "poly" ? tools.polyShape : undefined });
}

window.addEventListener("message", (e) => {
  const pane = panes.find((p) => p.iframe.contentWindow === e.source);
  if (!pane) return;
  const m = e.data;
  if (!m || typeof m !== "object") return;

  if (m.__puff === "ready") {
    pane.ready = true;
    syncPaneTools(pane);
    const q = pane.queue; pane.queue = [];
    for (const cmd of q) postCmd(pane, cmd);
    if (pane.pendingLoad) {                 // a handoff/opened PDF waiting for this pane
      const pl = pane.pendingLoad; pane.pendingLoad = null;
      postCmd(pane, { cmd: "loadBuffer", buf: pl.buf, name: pl.name }, [pl.buf]);
    }
    return;
  }
  if (m.__puff === "focus") { setActive(pane.id); return; }
  if (m.__puff === "export") { handleExportPhase(pane, m); return; }
  if (m.__puff === "toolKey") { if (pane.id === activeId) setTool(m.tool); return; }
  if (m.__puff === "state") {
    paneState.set(pane.id, m);
    pane.title.textContent = m.docName || (m.hasDoc ? "Untitled PDF" : "No PDF — open or drop one");
    if (pane.id === activeId) reflect(m);
    return;
  }
});

// ---------- panes ----------
function addPane() {
  const id = "pane" + (++seq);
  const wrap = document.createElement("div");
  wrap.className = "pane";
  wrap.dataset.id = id;

  const head = document.createElement("div");
  head.className = "pane-head";
  const title = document.createElement("span");
  title.className = "pane-title";
  title.textContent = "No PDF — open or drop one";
  const openBtn = document.createElement("button");
  openBtn.className = "pane-open";
  openBtn.textContent = "Open";
  const closeBtn = document.createElement("button");
  closeBtn.className = "pane-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close pane";
  head.append(title, openBtn, closeBtn);

  const iframe = document.createElement("iframe");
  iframe.className = "pane-frame";
  iframe.src = IFRAME_SRC;
  wrap.append(head, iframe);

  if (panes.length) {
    const d = document.createElement("div");
    d.className = "divider";
    wireDivider(d);
    el.panes.appendChild(d);
  }
  el.panes.appendChild(wrap);

  const pane = { id, wrap, iframe, title, ready: false, queue: [] };
  panes.push(pane);

  wrap.addEventListener("mousedown", () => setActive(id));
  openBtn.addEventListener("click", (ev) => { ev.stopPropagation(); setActive(id); pickInto(id); });
  closeBtn.addEventListener("click", (ev) => { ev.stopPropagation(); closePane(id); });

  setActive(id);
  return pane;
}

function closePane(id) {
  const idx = panes.findIndex((p) => p.id === id);
  if (idx < 0) return;
  paneState.delete(id);
  const pane = panes[idx];

  if (panes.length === 1) {          // keep at least one pane — reset it to blank
    pane.ready = false; pane.queue = [];
    pane.title.textContent = "No PDF — open or drop one";
    pane.iframe.src = IFRAME_SRC;
    return;
  }

  const prev = pane.wrap.previousElementSibling, next = pane.wrap.nextElementSibling;
  if (prev && prev.classList.contains("divider")) prev.remove();
  else if (next && next.classList.contains("divider")) next.remove();
  pane.wrap.remove();
  panes.splice(idx, 1);
  if (activeId === id) setActive(panes[Math.max(0, idx - 1)].id);
}

function setActive(id) {
  activeId = id;
  for (const p of panes) p.wrap.classList.toggle("active", p.id === id);
  reflect(paneState.get(id));
}

// ---------- export progress overlay: a loading bar naming the pane's PDF ----------
function handleExportPhase(pane, m) {
  if (m.phase === "start") startPaneProgress(pane, `Exporting “${m.name}”…`);
  else if (m.phase === "done") finishPaneProgress(pane, `Downloaded “${m.name}” ✓`, "ok", 1300);
  else if (m.phase === "error") finishPaneProgress(pane, `Export failed: ${m.message || ""}`, "error", 3000);
}

function ensureBusy(pane) {
  let o = pane.wrap.querySelector(".pane-busy");
  if (!o) {
    o = document.createElement("div");
    o.className = "pane-busy";
    o.innerHTML = '<div class="pane-busy-card"><div class="pane-busy-text"></div>'
      + '<div class="pane-busy-bar"><div class="pane-busy-fill"></div></div></div>';
    pane.wrap.appendChild(o);
  }
  return o;
}

// mock progress: creep toward 92% while the (variable-length) build runs
function startPaneProgress(pane, text) {
  const o = ensureBusy(pane);
  o.classList.remove("done", "error");
  o.querySelector(".pane-busy-text").textContent = text;
  const fill = o.querySelector(".pane-busy-fill");
  clearInterval(o._tick); clearTimeout(o._timer);
  let w = 8;
  fill.style.width = w + "%";
  o._tick = setInterval(() => {
    w += (92 - w) * 0.06 + 0.4;
    if (w > 92) w = 92;
    fill.style.width = w.toFixed(1) + "%";
  }, 120);
}

// build finished → fill to 100% (the download fires now), then fade out
function finishPaneProgress(pane, text, mode, hideMs) {
  const o = pane.wrap.querySelector(".pane-busy");
  if (!o) return;
  clearInterval(o._tick);
  o.classList.toggle("done", mode === "ok");
  o.classList.toggle("error", mode === "error");
  o.querySelector(".pane-busy-text").textContent = text;
  o.querySelector(".pane-busy-fill").style.width = "100%";
  clearTimeout(o._timer);
  o._timer = setTimeout(() => hidePaneBusy(pane), hideMs);
}

function hidePaneBusy(pane) {
  const o = pane.wrap.querySelector(".pane-busy");
  if (o) { clearInterval(o._tick); clearTimeout(o._timer); o.remove(); }
}

// ---------- divider drag (disable iframe pointer events so we keep the mouse) ----------
function wireDivider(d) {
  d.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const prev = d.previousElementSibling, next = d.nextElementSibling;
    if (!prev || !next) return;
    const startX = e.clientX;
    const pw = prev.getBoundingClientRect().width, nw = next.getBoundingClientRect().width;
    el.panes.classList.add("dragging");
    const onMove = (mv) => {
      const dx = mv.clientX - startX;
      prev.style.flex = `1 1 ${Math.max(140, pw + dx)}px`;
      next.style.flex = `1 1 ${Math.max(140, nw - dx)}px`;
    };
    const onUp = () => {
      el.panes.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---------- file open (shell reads bytes → hands them to a pane) ----------
function pickInto(id) { pendingTarget = id; el.fileInput.click(); }

el.fileInput.addEventListener("change", async () => {
  const f = el.fileInput.files[0];
  el.fileInput.value = "";
  const pane = paneById(pendingTarget) || activePane();
  pendingTarget = null;
  if (!f || !pane) return;
  const buf = await f.arrayBuffer();
  setActive(pane.id);
  // transferable ArrayBuffer — send directly (pane is ready by now: the picker took a user turn)
  postCmd(pane, { cmd: "loadBuffer", buf, name: f.name }, [buf]);
});

// ---------- shared toolbar ----------
function setTool(tool) {
  tools.tool = tool;
  updateToolbarUI();
  broadcast({ cmd: "tool", tool, shape: tool === "poly" ? tools.polyShape : undefined });
}
function pickShape(shape) {
  if (BASE_SHAPES.has(shape)) tools.tool = shape;
  else { tools.polyShape = shape; tools.tool = "poly"; }
  document.querySelectorAll("#shapes-flyout .shape-opt")
    .forEach((o) => o.classList.toggle("active", o.dataset.shape === shape));
  byId("shapes-flyout").classList.add("hidden");
  updateToolbarUI();
  broadcast({ cmd: "tool", tool: tools.tool, shape: tools.tool === "poly" ? tools.polyShape : undefined });
}
function setColor(c) {
  tools.color = c;
  el.color.value = c;
  document.querySelectorAll(".swatch").forEach((x) => x.classList.toggle("active", x.dataset.color === c));
  broadcast({ cmd: "color", color: c });
}

function updateToolbarUI() {
  const tool = tools.tool;
  document.querySelectorAll(".tb-tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  const shapesBtn = byId("btn-shapes");
  shapesBtn.classList.toggle("active", SHAPE_TOOLS.has(tool));
  const shape = tool === "poly" ? tools.polyShape : tool;
  if (SHAPE_TOOLS.has(tool)) {
    const u = byId("shapes-icon-use");
    if (u) u.setAttribute("href", "#i-" + shape);
  }
  el.properties.classList.toggle("hidden", tool === "select");
  el.toolName.textContent = tool === "poly" ? cap(shape) : (TOOL_LABELS[tool] || "");
  el.propWidth.classList.toggle("hidden", NO_WIDTH_TOOLS.has(tool));
  el.propFont.classList.toggle("hidden", tool !== "text");
}

// mirror the active pane's readout in the shared toolbar
function reflect(s) {
  el.zoomLabel.textContent = s && s.hasDoc ? s.zoom + "%" : "—";
  el.pageReadout.textContent = s && s.numPages ? `${s.page} / ${s.numPages}` : "— / —";
  const hlBtn = document.querySelector('.tb-tool[data-tool="hltext"]');
  if (hlBtn) hlBtn.classList.toggle("disabled", s ? !s.hasText : false);
  const ocrAll = byId("btn-ocr-all");
  if (ocrAll) ocrAll.textContent = s && s.ocrRunning ? "⏹ Stop" : "All";
}

function buildSwatches() {
  SWATCHES.forEach((c, i) => {
    const s = document.createElement("div");
    s.className = "swatch" + (i === 0 ? " active" : "");
    s.style.background = c;
    s.dataset.color = c;
    s.addEventListener("click", () => setColor(c));
    el.swatches.appendChild(s);
  });
}

function wireShapesFlyout() {
  const btn = byId("btn-shapes"), fly = byId("shapes-flyout");
  if (!btn || !fly) return;
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
  fly.querySelectorAll(".shape-opt").forEach((o) => o.addEventListener("click", () => pickShape(o.dataset.shape)));
  document.addEventListener("click", (e) => {
    if (!fly.contains(e.target) && !btn.contains(e.target)) fly.classList.add("hidden");
  });
}

function wireToolbar() {
  document.querySelectorAll(".tb-tool[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  wireShapesFlyout();
  buildSwatches();

  el.color.addEventListener("input", () => setColor(el.color.value));
  el.width.addEventListener("input", () => { tools.width = +el.width.value; broadcast({ cmd: "width", value: tools.width }); });
  el.opacity.addEventListener("input", () => { tools.opacity = +el.opacity.value / 100; broadcast({ cmd: "opacity", value: +el.opacity.value }); });
  el.font.addEventListener("change", () => { tools.fontFamily = el.font.value; broadcast({ cmd: "font", value: tools.fontFamily }); });

  byId("btn-undo").addEventListener("click", () => sendActive({ cmd: "undo" }));
  byId("btn-redo").addEventListener("click", () => sendActive({ cmd: "redo" }));
  byId("btn-clear").addEventListener("click", () => sendActive({ cmd: "clear" }));
  byId("btn-save").addEventListener("click", () => sendActive({ cmd: "save" }));
  byId("btn-export").addEventListener("click", () => sendActive({ cmd: "export" }));
  byId("btn-ocr").addEventListener("click", () => sendActive({ cmd: "ocrPage" }));
  byId("btn-ocr-all").addEventListener("click", () => sendActive({ cmd: "ocrAll" }));
  byId("btn-read").addEventListener("click", () => sendActive({ cmd: "read" }));
  byId("btn-zoom-in").addEventListener("click", () => sendActive({ cmd: "zoomIn" }));
  byId("btn-zoom-out").addEventListener("click", () => sendActive({ cmd: "zoomOut" }));
  byId("btn-fit").addEventListener("click", () => sendActive({ cmd: "fit" }));

  byId("btn-open").addEventListener("click", () => { if (activeId) pickInto(activeId); });
  byId("btn-add").addEventListener("click", () => { const p = addPane(); pickInto(p.id); });
}

function wireKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); sendActive({ cmd: "undo" }); }
    else if (mod && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); sendActive({ cmd: "redo" }); }
    else if (mod && k === "s") { e.preventDefault(); sendActive({ cmd: "save" }); }
    else if (mod && k === "e") { e.preventDefault(); sendActive({ cmd: "export" }); }
    else if (!mod) {
      const map = { p: "pen", b: "brush", h: "hltext", m: "hlfree", l: "line", a: "arrow", r: "rect", o: "ellipse", t: "text", i: "image", n: "note", e: "eraser", v: "select" };
      if (map[k]) setTool(map[k]);
    }
  });
}

// If the viewer stashed the currently-open PDF, load it into the first pane so
// it stays open; the second pane is left empty for the user to pick another.
async function maybeLoadHandoff() {
  let h;
  try { const g = await api.storage.local.get(HANDOFF_KEY); h = g[HANDOFF_KEY]; } catch { /* none */ }
  if (!h || !h.b64) return;
  try { await api.storage.local.remove(HANDOFF_KEY); } catch { /* ignore */ }
  const pane = panes[0];
  if (!pane) return;
  const buf = b64ToBuffer(h.b64);
  if (pane.ready) postCmd(pane, { cmd: "loadBuffer", buf, name: h.name }, [buf]);
  else pane.pendingLoad = { buf, name: h.name };   // send once the iframe reports ready
}

function boot() {
  wireToolbar();
  wireKeyboard();
  setColor(tools.color);
  updateToolbarUI();

  // start side by side with two panes
  addPane();
  addPane();
  setActive(panes[0].id);

  // a PDF URL handed in by the background script loads into the first pane
  const fileUrl = new URLSearchParams(location.search).get("file");
  if (fileUrl) postCmd(panes[0], { cmd: "loadUrl", url: fileUrl });

  maybeLoadHandoff();   // carry over the PDF that was open when Split was clicked
}

boot();
