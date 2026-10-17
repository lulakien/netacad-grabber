/* NetAcad Course Grabber - background service worker
 * Responsibilities:
 *  - fetch assets on behalf of the content script (credentials + CORS bypass)
 *  - zip collected files (fflate) and hand to chrome.downloads
 *  - observe chrome.downloads onCreated so the page can detect click-triggered downloads
 */
"use strict";
try { importScripts("zip/fflate.min.js"); } catch (e) { console.error("ngb: fflate load failed", e); }
// pdf.js 3.11.174 (last UMD release). The worker script MUST be imported first:
// a service worker has neither Worker nor document, so pdf.js cannot spawn a
// worker or loadScript() a fallback; with pdfjsWorker preloaded it uses an
// in-thread "fake worker" instead.
try {
  importScripts("pdf/pdf.worker.min.js");
  importScripts("pdf/pdf.min.js");
} catch (e) { console.error("ngb: pdf.js load failed", e); }
const pdfjsLib = globalThis.pdfjsLib || null;
if (pdfjsLib) {
  try { pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf/pdf.worker.min.js"); } catch (e) {}
}

const MAX_ASSET_BYTES = 40 * 1024 * 1024; // base64 stays below the 64 MiB message cap
const MAX_B64_CHARS = 56e6;

function safeFilename(name) {
  const base = String(name || "download")
    .replace(/^.*[\\/]/, "") // never let a caller turn this into a path
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return (base || "download").slice(0, 180);
}

function b64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function u8ToB64(u8) {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  return btoa(s);
}

async function readCappedBody(r) {
  if (!r.body || typeof r.body.getReader !== "function") {
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_ASSET_BYTES) return { tooLarge: true, size: buf.byteLength };
    return { u8: new Uint8Array(buf) };
  }
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_ASSET_BYTES) {
        try { await reader.cancel(); } catch (e) {}
        return { tooLarge: true, size: total };
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
  const u8 = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { u8.set(c, off); off += c.byteLength; }
  return { u8 };
}

async function fetchAsset(url) {
  try {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return { ok: false, status: r.status, url, type: "application/octet-stream", size: 0, data: "" };
    const type = (r.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
    const declared = parseInt(r.headers.get("content-length") || "0", 10);
    if (declared > MAX_ASSET_BYTES) return { ok: false, error: "too large", url, type, size: declared };
    const read = await readCappedBody(r);
    if (read.tooLarge) return { ok: false, error: "too large", url, type, size: read.size };
    return { ok: true, status: r.status, url, type, size: read.u8.byteLength, data: u8ToB64(read.u8) };
  } catch (e) {
    return { ok: false, url, type: "application/octet-stream", size: 0, data: "", error: e && e.message || String(e) };
  }
}
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: "ngb-toggle" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "fetchAsset": {
          const res = await fetchAsset(msg.url);
          send(res);
          break;
        }
        case "extractPdf": {
          if (!pdfjsLib) { send({ ok: false, error: "pdf.js not loaded" }); break; }
          if (typeof msg.b64 !== "string" || !msg.b64 || msg.b64.length > 56e6) { send({ ok: false, error: "bad pdf payload" }); break; }
          const size = Math.round(msg.b64.length * 0.75);
          let task = null;
          try {
            const data = b64ToU8(msg.b64);
            task = pdfjsLib.getDocument({ data, isEvalSupported: false });
            const doc = await task.promise;
            let text = "";
            for (let i = 1; i <= doc.numPages; i++) {
              const tc = await (await doc.getPage(i)).getTextContent();
              text += tc.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join("") + "\n";
            }
            send({ ok: true, pages: doc.numPages, size, text, empty: text.trim().length < 32 });
          } catch (e) {
            send({ ok: false, error: String((e && e.message) || e), size });
          } finally {
            if (task) {
              try { await task.destroy(); } catch (e) {}
            }
          }
          break;
        }
        case "saveZip": {
          if (typeof msg.b64 !== "string" || !msg.b64 || msg.b64.length >= 48e6) {
            send({ ok: false, error: "ZIP payload too large or empty" });
            break;
          }
          try {
            const id = await chrome.downloads.download({
              filename: safeFilename(msg.filename || "course.zip"),
              saveAs: false,
              conflictAction: "uniquify",
              url: "data:application/zip;base64," + msg.b64,
            });
            send({ ok: true, id, via: "data" });
          } catch (e2) {
            send({ ok: false, error: String((e2 && e2.message) || e2) });
          }
          break;
        }
        case "saveAsset": {
          // Blob downloads created by the page cannot be re-fetched in the
          // service worker (object URLs are page-origin), so the content
          // script sends the bytes it already read in the page. A service
          // worker has no URL.createObjectURL, so use a data: URL here.
          if (typeof msg.b64 !== "string" || !msg.b64 || msg.b64.length >= MAX_B64_CHARS) {
            send({ ok: false, error: "asset payload too large or empty" });
            break;
          }
          const mime = String(msg.mime || "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
          try {
            const id = await chrome.downloads.download({
              filename: safeFilename(msg.filename),
              saveAs: false,
              conflictAction: "uniquify",
              url: "data:" + mime + ";base64," + msg.b64,
            });
            send({ ok: true, id, via: "data" });
          } catch (e) {
            send({ ok: false, error: String((e && e.message) || e) });
          }
          break;
        }
        case "downloadUrlDirect": {
          // Fallback for a suppressed resource-tab click when reading the
          // signed URL through fetch fails: let Chrome download it directly.
          if (typeof msg.url !== "string" || !/^https:\/\//.test(msg.url)) {
            send({ ok: false, error: "bad url" });
            break;
          }
          try {
            const id = await chrome.downloads.download({
              filename: safeFilename(msg.filename || "resource"),
              saveAs: false,
              conflictAction: "uniquify",
              url: msg.url,
            });
            send({ ok: true, id, via: "url" });
          } catch (e) {
            send({ ok: false, error: String((e && e.message) || e) });
          }
          break;
        }
        case "ping": {
          send({ ok: true, hasFflate: typeof fflate !== "undefined", hasCreateObjectURL: typeof URL.createObjectURL });
          break;
        }
        default:
          send({ ok: false, error: "unknown message type: " + (msg && msg.type) });
      }
    } catch (e) {
      send({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // async response
});

// Broadcast download-start events to NetAcad content frames. runtime.sendMessage
// does not reach content scripts reliably, so use tabs.sendMessage.
function broadcastDownloadStarted(item) {
  const msg = {
    type: "downloadStarted",
    url: item.url,
    filename: item.filename || "",
    mime: item.mime || "",
  };
  const sendTo = (tabs) => {
    for (const tab of tabs || []) {
      if (!tab || tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
    }
  };
  try {
    chrome.tabs.query({ url: ["https://*.netacad.com/*"] }, (tabs) => {
      if (chrome.runtime.lastError || !tabs || !tabs.length) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (fallback) => sendTo(fallback));
      } else {
        sendTo(tabs);
      }
    });
  } catch (e) {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (fallback) => sendTo(fallback));
  }
}

chrome.downloads.onCreated.addListener((item) => {
  // Ignore files this extension itself saves; otherwise a captured download
  // could feed back into another capture.
  if (item.byExtensionId) return;
  broadcastDownloadStarted(item);
});
