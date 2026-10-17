/* NetAcad Course Grabber - main-world shim
 *
 * Declarative content scripts run in an isolated world, so patching
 * EventTarget.prototype / URL there only affects extension code. This file is
 * injected into the page's own world at document_start so the site's copy
 * guards and object URLs are actually reachable.
 *
 * It never touches chrome.*; the isolated content script talks to it with
 * window.postMessage:
 *   {__ngbMain:"getBlob", url, seq} -> {__ngbMain:"blobData", seq, ok, data}
 */
(() => {
  "use strict";
  if (window.__ngbMainLoaded) return;
  window.__ngbMainLoaded = true;

  // --------------------------------------------------- copy guards
  // Swallow the site's copy-blocking listeners. Keep the original listener in
  // a registry so removeEventListener(fn) still works and the page does not
  // accumulate broken registrations.
  const BLOCKED_EVENTS = new Set(["contextmenu", "selectstart", "dragstart", "copy", "cut", "paste", "auxclick", "select"]);
  const proto = EventTarget.prototype;
  const origAdd = proto.addEventListener;
  const origRemove = proto.removeEventListener;
  const wrappers = new WeakMap(); // listener -> Map("type|capture" -> wrapper)

  function keyFor(type, opts) {
    const capture = typeof opts === "boolean" ? opts : !!(opts && opts.capture);
    return type + "|" + (capture ? "1" : "0");
  }
  function wrapperFor(type, fn, k) {
    let map = wrappers.get(fn);
    if (!map) { map = new Map(); wrappers.set(fn, map); }
    let w = map.get(k);
    if (!w) {
      w = function (e) {
        // Do not run the site's copy blocker. stopImmediatePropagation also
        // keeps any sibling listener at the same target from cancelling it.
        if (e && typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      };
      map.set(k, w);
    }
    return w;
  }

  proto.addEventListener = function (type, fn, opts) {
    if (BLOCKED_EVENTS.has(type) && fn && (typeof fn === "function" || typeof fn === "object")) {
      const k = keyFor(type, opts);
      const w = wrapperFor(type, fn, k);
      return origAdd.call(this, type, w, opts);
    }
    return origAdd.call(this, type, fn, opts);
  };

  proto.removeEventListener = function (type, fn, opts) {
    if (BLOCKED_EVENTS.has(type) && fn) {
      const map = wrappers.get(fn);
      const k = keyFor(type, opts);
      const w = map && map.get(k);
      if (w) return origRemove.call(this, type, w, opts);
    }
    return origRemove.call(this, type, fn, opts);
  };

  function clearInlineGuards() {
    const attrs = ["oncontextmenu", "onselectstart", "ondragstart", "oncopy", "oncut", "onpaste", "onselect"];
    const stack = [document.documentElement];
    while (stack.length) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;
      for (const a of attrs) {
        if (el.hasAttribute(a)) el.removeAttribute(a);
      }
      for (const c of el.children) stack.push(c);
      if (el.shadowRoot) for (const c of el.shadowRoot.children) stack.push(c);
    }
  }

  // ------------------------------------------- resource downloads
  // The Resources tab signs a CloudFront URL and clicks a hidden
  // <a download>. Capture that URL instead of letting the file land outside
  // the ZIP. Restrict the hook to the course resource path.
  const RESOURCE_RE = /^https:\/\/www\.netacad\.com\/s\/[^/]+\/resources\/[^/]+\/v1\//;
  let captureResources = false;
  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      const href = this.href || "";
      if (captureResources && this.hasAttribute("download") && RESOURCE_RE.test(href)) {
        window.postMessage({ __ngbMain: "resourceDownload", url: href, filename: this.download || "" }, "*");
        return;
      }
    } catch (e) {}
    return origAnchorClick.call(this);
  };

  // --------------------------------------------------- object URLs
  const blobs = new Map(); // blob: URL -> Blob
  const MAX_TRACKED_BLOBS = 200;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreate.call(URL, obj);
    try {
      blobs.set(url, obj);
      if (blobs.size > MAX_TRACKED_BLOBS) blobs.delete(blobs.keys().next().value);
    } catch (e) { /* non-blob object */ }
    return url;
  };
  URL.revokeObjectURL = function (url) {
    // downloads.onCreated is asynchronous; keep the Blob reachable briefly so
    // an immediately-revoked object URL can still be captured.
    setTimeout(() => { try { blobs.delete(url); } catch (e) {} }, 30000);
    return origRevoke.call(URL, url);
  };

  // The page may create a blob URL before this script runs (document_start is
  // very early, but extensions can load after an inline script). Nothing can
  // recover those; normal downloads still work without capture.
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d.__ngbMain === "resourceCapture") {
      captureResources = !!d.on;
      return;
    }
    if (d && d.__ngbMain === "clearInline") {
      clearInlineGuards();
      return;
    }
    if (!d || d.__ngbMain !== "getBlob" || typeof d.url !== "string" || typeof d.seq !== "number") return;
    const blob = blobs.get(d.url);
    if (!blob) {
      window.postMessage({ __ngbMain: "blobData", seq: d.seq, ok: false, error: "blob not found" }, "*");
      return;
    }
    Promise.resolve(blob.arrayBuffer()).then((buf) => {
      window.postMessage(
        { __ngbMain: "blobData", seq: d.seq, ok: true, size: blob.size, type: blob.type || "", data: buf },
        "*",
        [buf]
      );
    }).catch((err) => {
      window.postMessage({ __ngbMain: "blobData", seq: d.seq, ok: false, error: String((err && err.message) || err) }, "*");
    });
  });
})();
