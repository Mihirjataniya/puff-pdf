const api = globalThis.browser || globalThis.chrome;

function openViewer(extraQuery) {
  const url = api.runtime.getURL("viewer.html") + (extraQuery || "");
  api.tabs.create({ url });
  window.close();
}

// Both entry points open the viewer; the viewer itself has the file picker + drag-drop.
document.getElementById("open").addEventListener("click", () => openViewer("?pick=1"));
document.getElementById("blank").addEventListener("click", () => openViewer(""));
