# Privacy Policy — Puff PDF

_Last updated: 2026-07-17_

Puff PDF ("the extension") is a browser extension that lets you view, annotate,
and export PDF files entirely on your own device.

## Summary

**Puff PDF collects nothing, sends nothing, and has no servers.** All PDF
rendering, drawing, OCR, and exporting happen locally in your browser. No data
ever leaves your device.

## What the extension accesses, and why

- **PDF page URLs / page content (`<all_urls>` host access, `webNavigation`,
  `webRequest`, `tabs`).** The extension detects when you open a PDF so it can
  replace the browser's built-in viewer with its own annotator. It reads the
  URL and response headers of the page you are navigating to only to decide
  whether that page is a PDF and, if so, redirect it into the local viewer. It
  does not read, log, or transmit the contents of non-PDF pages, and it does not
  track your browsing.
- **The PDF file you open.** Loaded into memory and rendered locally so you can
  view and annotate it. It is never uploaded.

## What is stored, and where

- **Your annotations** are saved in the browser's local extension storage
  (`storage`, `unlimitedStorage`), keyed to a hash of the specific PDF, so your
  markup reappears when you reopen the same file. This data stays on your device
  and is removed if you clear the extension's storage or uninstall it.
- **OCR results** (for scanned PDFs) are cached in the same local storage so
  recognized text does not need to be recomputed. OCR runs fully offline using a
  bundled engine (Tesseract.js).

## What is NOT done

- No analytics, telemetry, or tracking.
- No accounts, sign-in, or cloud sync.
- No network requests to any external server.
- No selling or sharing of any data (there is no data to sell or share).

## Third-party libraries

The extension bundles unmodified builds of open-source libraries that run
locally: PDF.js (rendering), pdf-lib (export), and Tesseract.js (OCR). These run
on your device and make no network calls in this extension.

## Contact

Questions about this policy: **mihirjataniya1612@gmail.com**
