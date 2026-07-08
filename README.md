# Puff PDF — browser PDF annotator

Draw, highlight, and mark up **any PDF** in your browser, then export a real
`.pdf` with your markup baked in — it opens correctly in Acrobat, Preview, or
anywhere, even after this extension is uninstalled.

Works from **one codebase** on Chrome, Edge, Brave, Opera, and Firefox
(Chromium + Firefox MV3). Safari needs a separate native wrapper and is not
included.

## Why a custom viewer?
The browser's built-in PDF viewer is a closed plugin — you can't draw on top of
it. So the extension replaces it: when you open a PDF, it loads our viewer
(PDF.js render + a transparent drawing canvas + a selectable text layer per
page).

## Install (developer / unpacked)

**Chrome / Edge / Brave / Opera**
1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. **Load unpacked** → select this `pdf-annotator/` folder.
4. (Optional, for local `file://` PDFs) open the extension's *Details* and
   enable **Allow access to file URLs**.

**Firefox**
1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `manifest.json` in this folder.
   (Temporary add-ons are removed on restart; that's a Firefox dev limitation.)

## Use
- Click the toolbar icon → **Open a PDF file…**, or just **navigate to any
  `.pdf` link** and it opens in the annotator automatically. You can also drag a
  PDF onto the window.
- Pick a tool, color, width, and opacity, then draw.
- **Save** stores your markup locally (keyed to that exact PDF) and it comes
  back next time you open the same file. Autosaves as you go.
- **Export** downloads a flattened `<name> (annotated).pdf`.

## Tools
Pen · Brush (pressure/speed width) · **Highlight text** (drag across words — snaps
to them) · Highlighter (freehand) · Line · Arrow · Rectangle · Ellipse · Text
box · Eraser · color swatches + custom color · width · opacity · undo/redo ·
clear page · zoom · fit.

### Keyboard
`P` pen · `B` brush · `H` highlight-text · `M` highlighter · `L` line · `A` arrow
· `R` rect · `O` ellipse · `T` text · `E` eraser · `V` select/pan ·
`Ctrl/Cmd+Z` undo · `Ctrl/Cmd+Y` (or `Shift+Z`) redo · `Ctrl/Cmd+S` save ·
`Ctrl/Cmd+E` export.

## Two kinds of highlight
- **Highlight text (`H`)** uses the PDF's real text layer + native text
  selection, so it snaps to words/sentences. Only works on PDFs that *have* a
  text layer (born-digital PDFs).
- **Highlighter (`M`)** is a freehand translucent stroke — works on anything,
  including scanned/image-only PDFs.

## Scanned PDFs — OCR
Scanned/image PDFs have no text to select. Click **🔎 OCR** to recognize the
**current page** (Tesseract.js, fully offline): it reads the page image into
word boxes and builds a selectable text layer, so text-select and **Highlight
text** start working on that page. Results are cached per page, so reopening the
PDF restores them. OCR runs one page at a time (a few seconds each); accuracy is
good on clean scans, weaker on skewed/low-res ones.

## Known limitations (v1)
- **Scanned/image PDFs**: not selectable until you run **🔎 OCR** on the page
  (or just use the freehand highlighter).
- **Rotated pages / non-zero crop origin**: export may offset markup on those
  pages (you'll get a toast). On-screen drawing is unaffected.
- **Safari**: not supported (needs a native Xcode wrapper).
- Local `file://` auto-open needs the *Allow access to file URLs* toggle; the
  file picker / drag-drop always works without it.

## Project layout
```
manifest.json      MV3 manifest (Chromium + Firefox)
background.js      hijack PDF navigations → viewer
popup.html/.js     toolbar-icon menu
viewer.html/.css   the annotator page
src/viewer.js      app: load, render, tools, history, save/load
src/annots.js      annotation rendering + eraser hit-testing (canvas)
src/exporter.js    burn annotations into a real PDF (pdf-lib)
lib/               pdf.js (render + worker), pdf-lib (export)
```

## Data / privacy
Rendering and drawing are fully local. Saved markup lives in the browser's
extension storage. Nothing is uploaded.
