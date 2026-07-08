// Cross-browser background: hijack PDF navigations into our annotating viewer.
// Two triggers:
//   1) onBeforeNavigate — URL ends in .pdf  (redirect BEFORE the fetch, no double load)
//   2) onHeadersReceived — Content-Type: application/pdf with no .pdf extension
const api = globalThis.browser || globalThis.chrome;

const VIEWER_PATH = "viewer.html";
const VIEWER_URL = api.runtime.getURL(VIEWER_PATH);

function viewerUrl(pdfUrl) {
  return VIEWER_URL + "?file=" + encodeURIComponent(pdfUrl);
}

function isOurViewer(url) {
  return url && url.startsWith(VIEWER_URL);
}

function looksLikePdfUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "chrome-extension:" || u.protocol === "moz-extension:") return false;
    return /\.pdf($|[?#])/i.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

// De-dupe so the two triggers don't both redirect the same navigation.
const recentlyRedirected = new Map(); // tabId -> {url, t}
function alreadyRedirected(tabId, url) {
  const hit = recentlyRedirected.get(tabId);
  const now = Date.now();
  if (hit && hit.url === url && now - hit.t < 4000) return true;
  recentlyRedirected.set(tabId, { url, t: now });
  return false;
}

function toViewer(tabId, url) {
  if (isOurViewer(url)) return;
  if (alreadyRedirected(tabId, url)) return;
  api.tabs.update(tabId, { url: viewerUrl(url) });
}

// 1) extension-based
api.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  if (!looksLikePdfUrl(d.url)) return;
  toViewer(d.tabId, d.url);
});

// 2) content-type based (PDFs served without a .pdf extension)
function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? (h.value || "") : "";
}

if (api.webRequest && api.webRequest.onHeadersReceived) {
  api.webRequest.onHeadersReceived.addListener(
    (d) => {
      if (d.type !== "main_frame") return;
      if (isOurViewer(d.url)) return;
      const ct = headerValue(d.responseHeaders, "content-type");
      const disp = headerValue(d.responseHeaders, "content-disposition");
      // inline PDFs only; leave forced downloads to the browser
      if (/application\/pdf/i.test(ct) && !/attachment/i.test(disp)) {
        toViewer(d.tabId, d.url);
      }
    },
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["responseHeaders"]
  );
}

// housekeeping
api.tabs.onRemoved.addListener((tabId) => recentlyRedirected.delete(tabId));

// popup / other UI entry points
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "open-pdf-url" && msg.url) {
    api.tabs.create({ url: viewerUrl(msg.url) });
    sendResponse({ ok: true });
  } else if (msg && msg.type === "open-blank-viewer") {
    api.tabs.create({ url: VIEWER_URL });
    sendResponse({ ok: true });
  }
  return true;
});
