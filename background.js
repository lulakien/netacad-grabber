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
const pending = new Map(); // id -> resolve

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

async function fetchAsset(url) {
  try {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return { ok: false, status: r.status, url, type: "application/octet-stream", size: 0, data: "" };
    const type = (r.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_ASSET_BYTES) return { ok: false, error: "too large", url, type, size: buf.byteLength };
    return { ok: true, status: r.status, url, type, size: buf.byteLength, data: u8ToB64(new Uint8Array(buf)) };
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
          const opts = { filename: msg.filename, saveAs: false, conflictAction: "uniquify" };
          let e1 = null;
          if (msg.blobUrl) {
            try {
              const id = await chrome.downloads.download({ ...opts, url: msg.blobUrl });
              send({ ok: true, id, via: "blob" });
              break;
            } catch (e) { e1 = e; }
          }
          if (typeof msg.b64 !== "string" || !msg.b64 || msg.b64.length >= 48e6) {
            send({ ok: false, error: "blob: " + (e1 ? e1.message : "no url") + " | data: payload too large or empty" });
            break;
          }
          try {
            const id = await chrome.downloads.download({ ...opts, url: "data:application/zip;base64," + msg.b64 });
            send({ ok: true, id, via: "data", note: e1 && e1.message });
          } catch (e2) {
            send({ ok: false, error: "blob: " + (e1 ? e1.message : "no url") + " | data: " + e2.message });
          }
          break;
        }
        case "downloadUrl": {
          const res = await fetchAsset(msg.url);
          if (!res.ok) { send(res); break; }
          const bytes = b64ToU8(res.data);
          const mime = (res.type || "application/octet-stream").split(";")[0];
          const opts = { filename: msg.filename, saveAs: false, conflictAction: "uniquify" };
          if (bytes.byteLength > 1.4 * 1024 * 1024) {
            if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function" || typeof Blob === "undefined") {
              send({ ok: false, error: "asset too large for data URL and blob URLs are unavailable" });
              break;
            }
            const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
            try {
              const id = await chrome.downloads.download({ ...opts, url: blobUrl });
              send({ ok: true, id, via: "blob" });
            } catch (e) {
              send({ ok: false, error: "asset too large for data URL; blob download failed: " + String((e && e.message) || e) });
            } finally {
              setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 60000);
            }
            break;
          }
          const id = await chrome.downloads.download({ ...opts, url: "data:" + mime + ";base64," + res.data });
          send({ ok: true, id });
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

// Broadcast download-start events (used to detect resource entries that trigger downloads)
chrome.downloads.onCreated.addListener((item) => {
  chrome.runtime.sendMessage({ type: "downloadStarted", url: item.url, filename: item.filename }).catch(() => {});
});
