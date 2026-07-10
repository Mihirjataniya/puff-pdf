const api = globalThis.browser || globalThis.chrome;

function openPage(page, extraQuery) {
  const url = api.runtime.getURL(page) + (extraQuery || "");
  api.tabs.create({ url });
  window.close();
}

// Both entry points open the viewer; the viewer itself has the file picker + drag-drop.
document.getElementById("open").addEventListener("click", () => openPage("viewer.html", "?pick=1"));
document.getElementById("blank").addEventListener("click", () => openPage("viewer.html", ""));
document.getElementById("split").addEventListener("click", () => openPage("split.html", ""));
