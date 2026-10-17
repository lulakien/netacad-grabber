/* NetAcad Course Grabber - content script
 *
 * Runs on every netacad.com frame (all_frames).
 *  - Unlocks copy protection (user-select, contextmenu/selectstart/copy guards, blob-download capture)
 *  - Extracts a lesson page: structured Markdown + raw HTML + media list
 *  - Walks the course outline (modules -> submodules -> lessons) and captures every page
 *  - Pulls the authoring JSON manifests (course/blocks/contentObjects/articles/components/assets/config)
 *    when the new Skills-for-All platform pattern is present, including all lab/doc assets
 *  - Packages everything into a ZIP via the background service worker
 */
(() => {
  "use strict";
  if (window.__ngbLoaded) return;
  window.__ngbLoaded = true;

  const IS_TOP = window === window.top;
  const NG = (m) => console.info("[netacad-grabber]", m);
  // bump on every content-script change; shown as <html data-ngb-cs> for diagnostics
  const CS_VERSION = "1.0.8-r3";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------- utils
  function sanitizeName(s, maxLen) {
    maxLen = maxLen || 60;
    const out = String(s || "")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/-+/g, "-")
      .trim();
    return (out || "untitled").slice(0, maxLen);
  }

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  // Visit an element and every element inside any nested shadow roots.
  function* walkAll(node) {
    if (!node) return;
    if (node.nodeType === 1) yield node;
    // light DOM children
    for (const c of node.children) yield* walkAll(c);
    // shadow root children
    if (node.shadowRoot) {
      for (const c of node.shadowRoot.children) yield* walkAll(c);
    }
  }

  function visible(el) {
    try {
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    } catch (e) {
      return true;
    }
  }

  function elementText(el) {
    // innerText is layout-aware; fall back to textContent
    try { return el.innerText || el.textContent || ""; } catch (e) { return el.textContent || ""; }
  }
  // text of an element's subtree INCLUDING nested shadow roots (textContent cannot cross them)
  function shadowText(el) {
    let out = "";
    if (!el) return out;
    const stack = [el];
    while (stack.length && out.length < 20000) {
      const n = stack.pop();
      if (n.nodeType === 3) { out += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT|HEAD)$/.test(n.tagName)) continue;
      for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]);
      if (n.shadowRoot) for (let i = n.shadowRoot.childNodes.length - 1; i >= 0; i--) stack.push(n.shadowRoot.childNodes[i]);
    }
    return out;
  }

  // head/tail text for page signatures: keeps the full length and both ends without
  // retaining a potentially huge string in memory
  function shadowTextParts(el, headLen, tailLen) {
    let head = "", tail = "", total = 0;
    if (!el) return { head, tail, total };
    const stack = [el];
    while (stack.length) {
      const n = stack.pop();
      if (n.nodeType === 3) {
        const s = n.nodeValue || "";
        total += s.length;
        if (head.length < headLen) head += s.slice(0, headLen - head.length);
        tail = (tail + s).slice(-tailLen);
        continue;
      }
      if (n.nodeType !== 1) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT|HEAD)$/.test(n.tagName)) continue;
      for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]);
      if (n.shadowRoot) for (let i = n.shadowRoot.childNodes.length - 1; i >= 0; i--) stack.push(n.shadowRoot.childNodes[i]);
    }
    return { head, tail, total };
  }

  // ----------------------------------------------------- 1. copy unlock
  const BLOCKED_EVENTS = new Set(["contextmenu", "selectstart", "dragstart", "copy", "auxclick", "select"]);

  function installUnlock() {
    const doc = document;
    const win = doc.defaultView;

    // (a) force text selectable everywhere
    let style = doc.getElementById("__ngbUnlockStyle");
    if (!style) {
      style = doc.createElement("style");
      style.id = "__ngbUnlockStyle";
      style.textContent =
        "*,*::before,*::after{-webkit-user-select:text!important;user-select:text!important;}";
      (doc.head || doc.documentElement).appendChild(style);
    }

    // (b) swallow the site's own copy-blocking listeners
    if (!win.__ngbListenPatched) {
      win.__ngbListenPatched = true;
      const proto = win.EventTarget.prototype;
      const origAdd = proto.addEventListener;
      proto.addEventListener = function (type, fn, opts) {
        if (BLOCKED_EVENTS.has(type) && (typeof fn === "function" || typeof fn === "object")) {
          const wrapper = function (e) {
            // let the browser default happen (copy works); suppress the site handler entirely
            if (e) e.stopPropagation();
          };
          // keep a registry so we can restore if needed
          (win.__ngbSwallowed = win.__ngbSwallowed || []).push({ type, fn, opts });
          return origAdd.call(this, type, wrapper, opts);
        }
        return origAdd.call(this, type, fn, opts);
      };
    }

    // (c) clear inline on<event> attributes the site may set
    try {
      for (const el of walkAll(doc.documentElement)) {
        for (const ev of ["oncontextmenu", "onselectionstart", "ondragstart", "oncopy"]) {
          if (el[ev] !== null) el[ev] = null;
        }
      }
    } catch (e) { /* best effort */ }

    // (d) capture pointer-event overlay divs: zero them out
    try {
      for (const el of walkAll(doc.body)) {
        const cs = win.getComputedStyle(el);
        if (cs.position === "absolute" || cs.position === "fixed") {
          const r = el.getBoundingClientRect();
          const big = r.width > 200 && r.height > 200;
          const empty = !el.textContent.trim() && el.children.length === 0 && !el.querySelector("img,canvas,video");
          if (big && empty && cs.pointerEvents === "auto" && r.zIndex !== "0" && (el.className || "").toString() !== "") {
            // suspicious full-cover overlay; disable it
            el.style.pointerEvents = "none";
          }
        }
      }
    } catch (e) { /* best effort */ }
  }

  // capture object URLs (blob downloads) so we can grab their bytes later
  const objectUrlToBlob = new Map(); // "blob:..." -> Blob
  function installBlobHook() {
    const win = window;
    if (win.__ngbBlobPatched) return;
    win.__ngbBlobPatched = true;
    const origCreate = win.URL.createObjectURL;
    win.URL.createObjectURL = function (blob) {
      const url = origCreate.call(win.URL, blob);
      try { objectUrlToBlob.set(url, blob); } catch (e) {}
      return url;
    };
    const origRevoke = win.URL.revokeObjectURL;
    win.URL.revokeObjectURL = function (url) {
      objectUrlToBlob.delete(url);
      return origRevoke.call(win.URL, url);
    };
  }

  async function blobToB64(blob) {
    const buf = await blob.arrayBuffer();
    const u8 = new Uint8Array(buf);
    let s = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  // ------------------------------------------------- 2. content root
  const PENALTY_RE = /nav|sidebar|outline|drawer|menu|header|footer|popup|banner|cookie|tooltip|progress|survey|chat|webex/i;

  function findContentRoot(doc) {
    const win = doc.defaultView;
    const candidates = [];
    const consider = (el) => {
      if (!el || el.nodeType !== 1) return;
      if (/^(SCRIPT|STYLE|NOSCRIPT|LINK|META|TITLE|HEAD)$/.test(el.tagName)) return;
      const clsId = ((el.className && typeof el.className === "string" ? el.className : "") + " " + (el.id || "")).toLowerCase();
      const boosted = el.id === "Wrapper" || el.tagName === "MAIN" || el.getAttribute("role") === "main" ||
        el.tagName === "PAGE-VIEW" || el.tagName === "BASE-VIEW";
      // boosted containers may hold their content inside shadow roots; measure shadow-aware
      let score = (boosted ? shadowText(el) : elementText(el)).replace(/\s+/g, " ").length;
      if (PENALTY_RE.test(clsId)) score *= 0.25;
      if (boosted) score *= 2;
      if (score < 40) return;
      candidates.push({ el, score });
    };
    for (const el of walkAll(doc.documentElement)) {
      if (!el.offsetParent && el.tagName !== "BODY" && getComputedStyle(el).position !== "fixed") continue;
      consider(el);
      if (candidates.length > 400) break;
    }
    if (!candidates.length) return doc.body;
    candidates.sort((a, b) => b.score - a.score);
    // if the top candidate contains the second one, prefer the inner (denser) one? No - prefer outer
    // container that still holds most text; pick best score.
    return candidates[0].el;
  }

  // ------------------------------------------------- 3. markdown
  function escMd(s) {
    return s.replace(/([\\_*`[\]])/g, "\\$1");
  }

  function inlineMd(node, ctx) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue.replace(/\s+/g, " ");
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (tag === "BR") { out += "\n"; continue; }
        if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|IFRAME|OBJECT|EMBED)$/.test(tag)) {
          if (tag === "IFRAME") {
            const src = child.src || "";
            if (src && !ctx.iframeSkipped.has(src)) { ctx.iframeLinks.push(src); ctx.iframeSkipped.add(src); out += " [embed: " + src + "] "; }
          }
          continue;
        }
        if (tag === "IMG") {
          const src = child.currentSrc || child.src;
          if (src) {
            ctx.imgs.push(src);
            const rel = ctx.mediaIndex.get(src);
            out += " ![" + (child.alt || "") + "](" + (rel || src) + ") ";
          }
          continue;
        }
        if (tag === "A") {
          const t = inlineMd(child, ctx).trim();
          const href = child.href || "";
          out += href ? " [" + t + "](" + href + ") " : " " + t + " ";
          ctx.links.push(href);
          continue;
        }
        if (/^(STRONG|B)$/.test(tag)) { const t = inlineMd(child, ctx).trim(); if (t) out += "**" + t + "**"; continue; }
        if (/^(EM|I)$/.test(tag)) { const t = inlineMd(child, ctx).trim(); if (t) out += "*" + t + "*"; continue; }
        if (/^(DEL|S|STRIKE)$/.test(tag)) { const t = inlineMd(child, ctx).trim(); if (t) out += "~~" + t + "~~"; continue; }
        if (tag === "CODE") { const t = child.textContent; if (t) out += "`" + t + "`"; continue; }
        if (tag === "SUB") { const t = inlineMd(child, ctx).trim(); out += " " + t + " "; continue; }
        out += inlineMd(child, ctx);
      }
    }
    return out;
  }

  function blockMd(node, ctx, depth) {
    // returns array of markdown lines
    const lines = [];
    const tag = node.tagName;
    // non-content nodes: skip (e.g. the <style id="customCSS"> blobs in shadow roots)
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/.test(tag)) return lines;
    const isBlock = /^(P|H1|H2|H3|H4|H5|H6|UL|OL|TABLE|BLOCKQUOTE|PRE|HR|DIV|SECTION|ARTICLE|FIGURE|LI)$/.test(tag) || node.shadowRoot;

    if (/^H[1-6]$/.test(tag)) {
      const t = inlineMd(node, ctx).replace(/\s+/g, " ").trim();
      if (t) lines.push("#".repeat(+tag[1]) + " " + t, "");
      return lines;
    }
    if (tag === "HR") { lines.push("---", ""); return lines; }
    if (tag === "PRE") {
      const t = node.textContent.replace(/\s+$/g, "");
      lines.push("```", t, "```", "");
      return lines;
    }
    if (tag === "BLOCKQUOTE") {
      const inner = [];
      for (const c of node.children) inner.push(...blockMd(c, ctx, depth));
      const txt = inner.join("\n");
      lines.push(txt.split("\n").map((l) => (l ? "> " + l : ">")).join("\n"), "");
      return lines;
    }
    if (tag === "UL" || tag === "OL") {
      let n = 0;
      for (const c of node.children) {
        if (c.tagName === "LI") {
          n++;
          const bullet = tag === "OL" ? n + ". " : "- ";
          const kids = [...c.children].filter((k) => k.tagName !== "UL" && k.tagName !== "OL");
          const sub = [...c.children].filter((k) => k.tagName === "UL" || k.tagName === "OL");
          const main = inlineMd(c, { ...ctx, liMain: kids }).trim();
          const t = kids.length ? inlineMd(kids[0], ctx).trim() : "";
          let line = bullet + (t || main).slice(0, 500);
          // fallback: strip nested-list text already included
          lines.push(line);
          for (const s of sub) {
            for (const sc of s.children) {
              if (sc.tagName === "LI") {
                const st = inlineMd(sc, ctx).trim();
                lines.push((s.tagName === "OL" ? "  " + (n + 1) + ". " : "  - ") + st);
              }
            }
          }
        }
      }
      lines.push("");
      return lines;
    }
    if (tag === "TABLE") {
      const rows = [...node.querySelectorAll("tr")];
      const mdRows = rows.map((tr) =>
        ["|", ...[...tr.children].map((td) => " " + (td.textContent || "").trim().replace(/\|/g, "\\|").replace(/\s+/g, " ") + " "), "|"].join("")
      );
      if (mdRows.length) {
        lines.push(mdRows[0], "| " + "---- |".repeat(Math.max(1, rows[0].children.length)), ...mdRows.slice(1), "");
      }
      return lines;
    }
    if (tag === "P") {
      const t = inlineMd(node, ctx).replace(/[ \t]+/g, " ").trim();
      if (t) lines.push(t, "");
      return lines;
    }
    if (tag === "IMG") {
      const src = node.currentSrc || node.src;
      if (src) {
        ctx.imgs.push(src);
        const rel = ctx.mediaIndex.get(src);
        lines.push("![image](" + (rel || src) + ")", "");
      }
      return lines;
    }
    if (tag === "VIDEO" || tag === "AUDIO") {
      const src = node.src || node.currentSrc || (node.querySelector("source") || {}).src || "";
      if (src) {
        ctx.media.push({ url: src, kind: tag === "VIDEO" ? "video" : "audio" });
        lines.push("[" + tag.toLowerCase() + ": " + src + "]", "");
      }
      return lines;
    }
    // DIV/SECTION/etc: recurse
    if (isBlock) {
      for (const c of node.children) {
        if (c.nodeType === 1) lines.push(...blockMd(c, ctx, depth + 1));
      }
      // direct text (not inside a block child)
      const directText = [...node.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ");
      const t = directText.replace(/\s+/g, " ").trim();
      if (t) lines.push(t, "");
      if (node.shadowRoot) {
        for (const c of node.shadowRoot.children) lines.push(...blockMd(c, ctx, depth + 1));
      }
      // collapse extra blank lines
      return lines;
    }
    const t = inlineMd(node, ctx).replace(/\s+/g, " ").trim();
    if (t) lines.push(t, "");
    return lines;
  }

  function docToMarkdown(root) {
    const ctx = { imgs: [], media: [], links: [], iframeLinks: [], iframeSkipped: new Set(), mediaIndex: new Map() };
    const lines = [];
    // direct children of root
    for (const c of root.children) lines.push(...blockMd(c, ctx));
    if (root.shadowRoot) for (const c of root.shadowRoot.children) lines.push(...blockMd(c, ctx));
    let md = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    return { md, ctx };
  }

  // ------------------------------------------------- 4. media collect
  const MEDIA_EXT_RE = /\.(mp4|webm|mov|avi|mkv|m4v|m3u8|mp3|wav|m4a|ogg|flac|pdf|pptx?|docx?|xlsx?|csv|zip|rar|7z|pka|pkt|json|xml|png|jpe?g|gif|webp|svg|bmp|ico)(\?|$)/i;

  function extFromUrl(url, ct) {
    const m = url.match(/\.[a-z0-9]{2,5}(\?|$)/i);
    if (m && /^(mp4|webm|mov|avi|mkv|m4v|m3u8|mp3|wav|m4a|ogg|flac|pdf|ppt|pptx|doc|docx|xls|xlsx|csv|zip|rar|7z|pka|pkt|json|xml|png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(m[1])) return "." + m[1].toLowerCase();
    if (ct) {
      const map = { "image/png": ".png", "image/jpeg": ".jpg", "image/svg+xml": ".svg", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "application/pdf": ".pdf" };
      if (map[ct.split(";")[0]]) return map[ct.split(";")[0]];
    }
    return ".bin";
  }

  function collectMedia(root, ctx) {
    const found = new Map(); // url -> entry
    const add = (url, kind, name) => {
      if (!url) return;
      if (url.startsWith("data:")) {
        // keep data uris under their content hash
        const h = hashStr(url.slice(0, 4000));
        const key = "data:" + h;
        if (!found.has(key)) found.set(key, { url, kind: kind || "file", name: name || h + extFromUrl("", url.includes("image") ? "image/png" : "") });
        return;
      }
      const key = url;
      if (!found.has(key)) found.set(key, { url, kind: kind || "file", name: name || null });
    };

    for (const el of walkAll(root)) {
      const tag = el.tagName;
      if (tag === "IMG") {
        add(el.currentSrc || el.src, "image");
      } else if (tag === "VIDEO" || tag === "AUDIO") {
        add(el.src || el.currentSrc, tag === "VIDEO" ? "video" : "audio");
        for (const s of el.querySelectorAll("source")) add(s.src, tag === "VIDEO" ? "video" : "audio");
      } else if (tag === "A") {
        const href = el.href;
        if (href && MEDIA_EXT_RE.test(href)) add(href, "doc");
      } else if (tag === "OBJECT" || tag === "EMBED") {
        add(el.data || el.src, "file");
      } else if (el.children.length <= 2) {
        try {
          const bg = getComputedStyle(el).backgroundImage;
          if (bg && bg !== "none") {
            const m = bg.match(/url\((['"]?)(.*?)\1\)/);
            if (m && m[2] && !m[2].startsWith("data:image/svg")) add(m[2], "image");
          }
        } catch (e) {}
      }
    }
    for (const e of ctx.media) add(e.url, e.kind);
    for (const e of ctx.iframeLinks) if (e) add(e, "embed");
    return [...found.values()];
  }

  // ------------------------------------------ 5. authoring manifests
  const AUTHORING_RE = /authoring-resources\/courses\/([^/]+)\/([^/]+)\/([^/?#]+)/;

  function detectManifest() {
    // from this frame or any iframe
    const urls = [location.href];
    for (const f of document.querySelectorAll("iframe")) {
      // the iframe src attribute goes stale after in-iframe navigation; prefer the live document URL
      let u = f.src || "";
      try { u = f.contentWindow.location.href || u; } catch (e) {}
      urls.push(u);
    }
    for (const u of urls) {
      // direct-path form: .../authoring-resources/courses/<cid>/<mid>/<lang>/...
      const m = u.match(AUTHORING_RE);
      if (m) return { courseId: m[1], moduleId: m[2], lang: m[3], moduleNumber: null };
      // app form: .../authoring-resources/index.html?...&lang=XX&moduleNumber=N#/courses/<cid>/<mid>/id/<pid>
      if (/authoring-resources\/index\.html/.test(u)) {
        const h = u.match(/#\/courses\/([^/?#]+)\/([^/?#]+)\/id\/([^/?#]+)/);
        const lang = (u.match(/[?&]lang=([a-zA-Z0-9-]+)/) || [])[1] || "en-US";
        const mn = (u.match(/[?&]moduleNumber=(\d+)/) || [])[1] || null;
        if (h) return { courseId: h[1], moduleId: h[2], pageId: h[3], lang, moduleNumber: mn };
      }
    }
    return null;
  }

  async function fetchText(url) {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, text: await r.text() };
  }

  async function fetchManifestFiles(courseId, moduleId, lang) {
    const base = "https://www.netacad.com/authoring-resources/courses/" + courseId + "/" + moduleId + "/";
    const out = { files: {}, assets: [], resources: [] };
    for (const name of ["assets.json", "course.json", "contentObjects.json", "components.json", "blocks.json", "articles.json"]) {
      const r = await fetchText(base + lang + "/" + name);
      if (r.ok) out.files[lang + "/" + name] = r.text;
    }
    const cfg = await fetchText(base + "config.json");
    if (cfg.ok) out.files["config.json"] = cfg.text;

    // assets
    if (out.files[lang + "/assets.json"]) {
      try {
        const list = JSON.parse(out.files[lang + "/assets.json"]);
        if (Array.isArray(list)) {
          const seen = new Set();
          for (const rel of list) {
            if (typeof rel !== "string" || seen.has(rel)) continue;
            seen.add(rel);
            out.assets.push(base + rel.replace(/^\//, ""));
          }
        }
      } catch (e) {}
    }
    // resources declared in course.json — keep title/description/type so PDFs
    // can be text-extracted and unreachable ones can leave a metadata stub
    if (out.files[lang + "/course.json"]) {
      try {
        const c = JSON.parse(out.files[lang + "/course.json"]);
        const items = (c._resources && c._resources._resourcesItems) || [];
        for (const it of items) {
          const link = it._link || it._media;
          if (!link) continue;
          out.resources.push({
            url: base + link.replace(/^\//, ""),
            title: it.title || link.split("/").pop(),
            description: it.description || "",
            type: it._type || "file",
          });
        }
      } catch (e) {}
    }
    return out;
  }

  // ------------------------------------------------- 6. downloads
  async function bgFetch(url) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: "timeout" }); } }, 120000);
      try {
        chrome.runtime.sendMessage({ type: "fetchAsset", url }, (res) => {
          if (!done) { done = true; clearTimeout(t); resolve(res || { ok: false, error: "no response" }); }
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(t); resolve({ ok: false, error: String(e) }); }
      }
    });
  }
  // ------------------------------------------------ 6b. pdf capture
  // The "viewed ingredients" route: instead of only grabbing the raw file,
  // parse the document the course shows/links and keep its information as text.
  // pdf.js runs in the service worker (in-thread fake worker; an SW has no
  // Worker constructor and no document), so we ship bytes over the message
  // channel and come back with text.
  const MAX_PDF_BYTES = 40 * 1024 * 1024;

  function isPdfUrl(url) {
    return /\.pdf(\?|#|$)/i.test(url);
  }

  async function extractPdfViaSW(b64, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: "timeout" }); } }, timeoutMs || 90000);
      try {
        chrome.runtime.sendMessage({ type: "extractPdf", b64 }, (res) => {
          if (!done) { done = true; clearTimeout(t); resolve(res || { ok: false, error: "no response" }); }
        });
      } catch (e) {
        if (!done) { done = true; resolve({ ok: false, error: String(e) }); }
      }
    });
  }

  function pdfMetaMd(r, extra) {
    const lines = ["> **Resource**: " + (r.title || "(untitled)")];
    if (r.description) lines.push("> " + r.description);
    lines.push("> **Type**: " + (r.type || "document"));
    lines.push("> **Source**: " + r.url);
    if (extra) lines.push("> " + extra);
    return lines.join("\n") + "\n\n";
  }

  // Capture one declared resource:
  //  - PDF reachable with the current session -> extract its text (pdf.js)
  //  - other reachable files -> raw bytes
  //  - unreachable (403/...) -> metadata stub so the resource is never lost
  async function captureResource(entries, r, dir, used) {
    let name = sanitizeName(r.title || "resource", 80);
    if (used.has(name)) name = hashStr(r.url) + name;
    used.add(name);
    let fr = null, status = null, b64 = null;
    try {
      fr = await fetch(r.url, { credentials: "include" });
      status = fr.status;
      if (fr.ok) {
        const buf = await fr.arrayBuffer();
        if (buf.byteLength <= MAX_PDF_BYTES) b64 = u8ToB64(new Uint8Array(buf));
      }
    } catch (e) { status = "error"; }
    const ct = fr && fr.ok ? (fr.headers.get("content-type") || "") : "";
    const isPdf = isPdfUrl(r.url) || /pdf/i.test(ct);
    if (fr && fr.ok && isPdf && b64) {
      const ex = await extractPdfViaSW(b64);
      const mdPath = dir + "/" + name + ".md";
      if (ex && ex.ok && !ex.empty) {
        if (!entries.some((e) => e.path === mdPath)) {
          entries.push({
            path: mdPath,
            text: pdfMetaMd(r, "**Extracted**: " + ex.pages + " page(s), " + ex.text.length + " chars of text via pdf.js (the document's content, not the raw file)") + ex.text,
          });
        }
        log("pdf " + (r.title || name) + ": " + ex.pages + "p, " + ex.text.length + " chars");
        return mdPath;
      }
      // PDF but no text layer (scanned) or parse failure -> keep raw bytes + note
      if (b64) await saveFileEntry(entries, dir, name + ".pdf", b64, false);
      if (!entries.some((e) => e.path === mdPath)) {
        entries.push({ path: mdPath, text: pdfMetaMd(r, (ex && ex.ok) ? "No extractable text layer (scanned/image PDF); raw file saved alongside" : "Extraction failed: " + (ex && ex.error) + "; raw file saved alongside") });
      }
      log("pdf " + (r.title || name) + ": no text (" + (ex && ex.error || "scanned") + "), raw saved");
      return mdPath;
    }
    if (fr && fr.ok && b64) {
      await saveFileEntry(entries, dir, name + (extFromUrl(r.url, ct) || ""), b64, false);
      return null;
    }
    if (fr && fr.ok) {
      // reachable but too big to copy -> stub with pointer
      const mdPath = dir + "/" + name + ".md";
      if (!entries.some((e) => e.path === mdPath)) entries.push({ path: mdPath, text: pdfMetaMd(r, "File reachable but over the copy limit; see source URL") });
      return mdPath;
    }
    const mdPath = dir + "/" + name + ".md";
    if (!entries.some((e) => e.path === mdPath)) {
      entries.push({ path: mdPath, text: pdfMetaMd(r, "**Status**: HTTP " + status + " — not fetchable with the current session, no content captured") });
    }
    log("resource " + (r.title || name) + ": HTTP " + status + " -> stub");
    return mdPath;
  }

  // Capture PDFs currently rendered inside the player (the on-screen route):
  // Chrome's native PDF viewer exposes no DOM text layer, so we fetch the same
  // document the viewer is showing and parse it.
  async function captureViewedPdfs(entries, dir, seen) {
    const f = activeIframe();
    if (!f) return;
    let doc = null;
    try { doc = f.contentDocument; } catch (e) { return; }
    if (!doc) return;
    const vids = [...doc.querySelectorAll('iframe[src*=".pdf"], embed[type="application/pdf"], object[type="application/pdf"]')];
    for (const v of vids) {
      const src = v.src || v.data || "";
      if (!src || seen.has(src)) continue;
      seen.add(src);
      try {
        const fr = await fetch(src, { credentials: "include" });
        if (!fr.ok) { log("viewed pdf " + src + " -> HTTP " + fr.status); continue; }
        const buf = await fr.arrayBuffer();
        if (buf.byteLength > MAX_PDF_BYTES) { log("viewed pdf too big (" + buf.byteLength + ")"); continue; }
        const ex = await extractPdfViaSW(u8ToB64(new Uint8Array(buf)));
        if (ex && ex.ok && !ex.empty) {
          const nm = mediaNameFor(src, "pdf", 0);
          const p = dir + "/pdf/" + nm + ".md";
          if (!entries.some((e) => e.path === p)) entries.push({ path: p, text: "## PDF: " + nm + "\n\n" + ex.text });
          log("viewed pdf " + nm + ": " + ex.pages + "p, " + ex.text.length + " chars");
        } else {
          log("viewed pdf " + src + ": no text layer" + (ex && ex.error ? " (" + ex.error + ")" : ""));
        }
      } catch (e) { log("viewed pdf failed: " + (e.message || e)); }
    }
  }

  // ------------------------------------------------- 7. page extract
  function pageSignature(root) {
    if (!root) return "null";
    let url = "";
    try { url = root.ownerDocument.defaultView.location.href || ""; } catch (e) {}
    const t = shadowTextParts(root, 6000, 2000);
    return hashStr(url + "\n" + t.head + "\n" + t.tail) + ":" + t.total;
  }

  async function extractPageInFrame() {
    const doc = document;
    const root = findContentRoot(doc);
    const { md, ctx } = docToMarkdown(root);
    const html = root ? root.innerHTML : "";
    const title = document.title.replace(/\s*\|\s*.*$/, "").trim() || "page";
    const media = collectMedia(root || doc.body, ctx);
    const manifest = detectManifest();
    return { title, md, html, media, manifest, url: location.href };
  }

  // iframe bridge: parent (top frame) asks, this frame answers
  function contentDocOf(iframe) {
    try {
      const d = iframe.contentDocument;
      if (d && d.body) return d;
    } catch (e) {}
    return null;
  }

  function iframeSignature(iframe) {
    const d = contentDocOf(iframe);
    if (!d) return null;
    let best = null;
    for (const el of walkAll(d.documentElement)) {
      if (el.id === "Wrapper" || el.tagName === "PAGE-VIEW") { best = el; break; }
    }
    return best ? pageSignature(best) : null;
  }

  // ------------------------------------------------- 8. outline
  // SFA course outline:
  //   div.nodeContainer (module)
  //     ├─ div.nodeInfoContainerWrapper (module title + progress)
  //     └─ div.subSection
  //          └─ div.subModuleContainer
  //               ├─ button[class*=subModuleBtn] (submodule title + "N / M")
  //               └─ div.blocks → a.blockContainer (lessons; rendered only when expanded)
  // Collapsed submodules hide their lesson links; the caller must expand each first.
  function cleanOutlineText(s) {
    return (s || "")
      .replace(/\s+/g, " ")
      .replace(/\s*\d+\s*\/\s*\d+\s*$/, "")
      .replace(/\s*\d+\s*%\s*$/, "")
      .replace(/\s*\d+\s*Prerequisites?\s*$/i, "")
      .trim();
  }

  // returns [{ module, modEl, subs: [{ title, btnEl, containerEl }] }]
  function parseOutline(doc) {
    const groups = [];
    for (const mod of doc.querySelectorAll("[class*=nodeContainer]")) {
      const header = mod.querySelector("[class*=nodeInfoContainerWrapper]");
      if (!header) continue;
      const subs = [];
      for (const c of mod.querySelectorAll("[class*=subModuleContainer]")) {
        const btn = c.querySelector("button[class*=subModuleBtn]") || c;
        subs.push({ title: cleanOutlineText(btn.textContent), btnEl: btn, containerEl: c });
      }
      groups.push({ module: cleanOutlineText(header.textContent), modEl: header, subs });
    }
    return groups;
  }



  // ------------------------------------------------- 9. UI
  let ui = null;

  function buildUI() {
    if (document.getElementById("__ngbPanelHost")) return;
    const doc = document;
    const host = doc.createElement("div");
    host.id = "__ngbPanelHost";
    Object.assign(host.style, {
      position: "fixed", right: "12px", bottom: "12px", zIndex: "2147483647",
      fontFamily: "system-ui, sans-serif", fontSize: "13px",
      background: "#101418", color: "#e8edf2", borderRadius: "10px",
      boxShadow: "0 8px 30px rgba(0,0,0,.45)", border: "1px solid #2a3340",
      width: "320px", padding: "10px 12px",
    });
    host.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
      '<b style="font-size:14px">NetAcad Grabber</b>' +
      '<button data-ngb="close" style="background:none;border:none;color:#8b98a5;cursor:pointer;font-size:16px">&#215;</button></div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">' +
      '<button data-ngb="copy" style="grid:1">Copy text</button>' +
      '<button data-ngb="page" style="grid:1">Save this page</button>' +
      '<button data-ngb="course" style="grid:1;background:#1d6fd6">Download full course</button></div>' +
      '<div data-ngb="status" style="color:#9fb2c4;min-height:16px;margin-bottom:6px"></div>' +
      '<details><summary style="cursor:pointer;color:#8b98a5">Log</summary>' +
      '<pre data-ngb="log" style="max-height:180px;overflow:auto;background:#0b0e12;padding:8px;border-radius:6px;font-size:11px;white-space:pre-wrap"></pre></details>' +
      '<style>' +
      "#__ngbPanelHost button{background:#1b232d;border:1px solid #2c3948;color:#dbe4ec;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12.5px}" +
      "#__ngbPanelHost button:hover{background:#243040}" +
      "#__ngbPanelHost button:disabled{opacity:.5;cursor:default}" +
      "</style>";
    (doc.body || doc.documentElement).appendChild(host);
    ui = {
      host,
      status: host.querySelector('[data-ngb="status"]'),
      logEl: host.querySelector('[data-ngb="log"]'),
      setStatus(t) {
        this.status.textContent = t;
        this.logEl.textContent = NG.buffer.join("\n");
      },
    };
    host.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-ngb]");
      if (!b) return;
      const act = b.getAttribute("data-ngb");
      if (act === "close") host.remove();
      else if (act === "copy") onCopyText();
      else if (act === "page") onSavePage();
      else if (act === "course") onDownloadCourse();
    });
    // re-sync status on interval (cheap)
    setInterval(() => { if (ui && ui.status) ui.setStatus(NG.last || ""); }, 1500);
    host.addEventListener("mouseenter", () => host.style.display = "block");
  }

  NG.buffer = [];
  NG.last = "";
  function log2(m) {
    const s = new Date().toISOString().slice(11, 19) + " " + m;
    NG.buffer.push(s);
    if (NG.buffer.length > 400) NG.buffer.shift();
    NG.last = s;
    NG(s);
    if (ui && ui.status) ui.setStatus(s);
  }
  // shadow the earlier log name
  const log = log2;
  // capture uncaught errors (incl. their stacks) into the panel log
  window.addEventListener("error", (e) => {
    const s = (e && e.error && e.error.stack) || e.message || "unknown";
    try { log("UNCAUGHT: " + s.slice(0, 700)); } catch (x) {}
  });

  function iframeHref(f) {
    let href = f.src || "";
    try { href = f.contentWindow.location.href || href; } catch (e) {}
    return href || "";
  }

  // active content iframe (the one hosting the lesson content)
  function activeIframe() {
    let best = null, bestArea = 0;
    let bestAuthoring = null, bestAuthoringArea = 0;
    for (const f of document.querySelectorAll("iframe")) {
      const r = f.getBoundingClientRect();
      const area = r.width * r.height;
      if (area <= 0) continue;
      if (area > bestArea) { best = f; bestArea = area; }
      if (iframeHref(f).includes("authoring-resources") && area > bestAuthoringArea) {
        bestAuthoring = f;
        bestAuthoringArea = area;
      }
    }
    return bestAuthoring || best;
  }

  function expandTemplate(s, m) {
    if (!s) return s;
    if (m && m.moduleNumber) {
      s = s.replace(/\{\{_globals\._moduleNumber\}\}/g, m.moduleNumber)
           .replace(/\{\{_moduleNumber\}\}/g, m.moduleNumber);
    }
    s = s.replace(/\{\{\s*[\w.]+\s*\}\}/g, "").replace(/\s{2,}/g, " ");
    return s.trim();
  }
  // whitespace-safe variant for multi-line markdown (expandTemplate collapses newlines)
  function expandMd(s, m) {
    if (!s) return s;
    if (m && m.moduleNumber) {
      s = s.replace(/\{\{_globals\._moduleNumber\}\}/g, m.moduleNumber)
           .replace(/\{\{_moduleNumber\}\}/g, m.moduleNumber);
    }
    return s.replace(/\{\{\s*[\w.]+\s*\}\}/g, "");
  }


  function courseTitle() {
    const t = (document.title || "")
      .replace(/^Cisco Networking Academy:\s*/, "")
      .replace(/\s*[|–—-]\s*(Cisco Networking Academy|Course Launch).*$/, "")
      .trim();
    return t || "course";
  }
  // current page signature (iframe-aware) — used for load-settle detection
  function currentSig() {
    const f2 = activeIframe();
    if (f2) {
      const d2 = contentDocOf(f2);
      if (d2) {
        let best2 = null;
        for (const el of walkAll(d2.documentElement)) {
          if (el.id === "Wrapper" || el.tagName === "PAGE-VIEW") { best2 = el; break; }
        }
        return best2 ? "if:" + d2.title + ":" + pageSignature(best2) : "if:loading:" + d2.title;
      }
    }
    return "top:" + pageSignature(findContentRoot(document));
  }

  // wait until the displayed page's content is stable (lazy/shadow content has finished loading)
  async function settleContent(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    let lastSig = null, stable = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      const s = currentSig();
      if (s === lastSig) {
        if (++stable >= 2) return;
      } else {
        stable = 0;
        lastSig = s;
      }
    }
  }

  async function getActiveContent() {
    const manifest = detectManifest();
    // same-origin direct
    const f = activeIframe();
    if (f) {
      const d = contentDocOf(f);
      if (d) {
        const root = findContentRoot(d);
        const { md: rawMd, ctx } = docToMarkdown(root);
        const md = expandMd(rawMd, manifest);
        const rawTitle = (d.title || "").trim();
        // the app renders "<module title> | <page name>"; the page name is already expanded
        const pagePart = rawTitle.includes("|") ? rawTitle.split("|").pop().trim() : "";
        return {
          doc: d, root, md, ctx,
          html: root ? root.innerHTML : "",
          title: expandTemplate(rawTitle.replace(/\s*\|\s*.*$/, "").trim() || "page", manifest),
          pageTitle: pagePart,
          media: collectMedia(root || d.body, ctx),
          manifest,
          iframe: f,
        };
      }
    }
    // fallback: this frame itself (in case the top frame is the content)
    const root = findContentRoot(document);
    const { md: rawMd, ctx } = docToMarkdown(root);
    const md = expandMd(rawMd, manifest);
    return {
      doc: document, root, md, ctx,
      html: root ? root.innerHTML : "",
      title: expandTemplate(document.title.replace(/\s*\|\s*.*$/, "").trim() || "page", manifest),
      media: collectMedia(root, ctx),
      manifest,
      iframe: null,
    };
  }

  // ------------------------------------------------- 10. actions
  async function onCopyText() {
    try {
      await settleContent(12000);
      const c = await getActiveContent();
      await navigator.clipboard.writeText("# " + c.title + "\n\n" + c.md);
      log("Copied " + c.title + " (" + c.md.length + " chars) to clipboard");
    } catch (e) {
      log("Copy failed: " + e.message);
    }
  }

  function u8ToB64(u8) {
    let s = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    return btoa(s);
  }

  async function saveFileEntry(entries, dir, name, dataB64OrText, isText) {
    const path = dir + "/" + name;
    if (entries.some((e) => e.path === path)) return path;
    entries.push(isText ? { path, text: dataB64OrText } : { path, data: dataB64OrText });
    return path;
  }

  async function fetchAndAdd(entries, dir, url, name) {
    const key = "fetch:" + url;
    if (fetchCache.has(key)) {
      const r = fetchCache.get(key);
      if (r.ok) await saveFileEntry(entries, dir, name, r.data, false);
      return r.ok;
    }
    const r = await bgFetch(url);
    fetchCache.set(key, r);
    if (r.ok) {
      await saveFileEntry(entries, dir, name, r.data, false);
      log("fetched " + name + " (" + r.size + " bytes)");
    } else {
      log("FAILED " + name + " -> " + (r.status || r.error));
    }
    return r.ok;
  }
  const fetchCache = new Map();

  function mediaNameFor(url, kind, i) {
    let base;
    if (url.startsWith("data:")) {
      base = "img-" + i + extFromUrl("", url.includes("image") ? "image/png" : "");
    } else {
      const u = new URL(url, location.href);
      let p = decodeURIComponent(u.pathname.split("/").pop() || "");
      if (!/\.[a-z0-9]{2,5}$/i.test(p)) p += extFromUrl(url, "");
      base = (p.length > 60 ? hashStr(url) + p.slice(-20) : p);
    }
    return sanitizeName(base, 80);
  }

  function uniqueMediaName(name, url, used) {
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let suffix = "-" + hashStr(url).slice(0, 8);
    let i = 2;
    let candidate = "";
    while (true) {
      const room = Math.max(1, 80 - suffix.length - ext.length);
      candidate = sanitizeName(stem.slice(0, room) + suffix + ext, 80);
      if (!used.has(candidate)) break;
      suffix = "-" + hashStr(url).slice(0, 8) + "-" + i++;
    }
    used.add(candidate);
    return candidate;
  }

  function dataUriInfo(url) {
    const comma = url.indexOf(",");
    const meta = comma >= 0 ? url.slice(5, comma) : "";
    const payload = comma >= 0 ? url.slice(comma + 1) : "";
    const mime = (meta.split(";")[0] || "application/octet-stream").toLowerCase();
    const ext = extFromUrl("", mime);
    if (/;base64(;|$)/i.test(meta)) return { value: payload, isText: false, ext };
    let text = payload;
    try { text = decodeURIComponent(payload); } catch (e) {}
    return { value: text, isText: true, ext };
  }

  function rewriteMediaLinks(md, mediaPathByUrl) {
    let out = md;
    const urls = [...mediaPathByUrl.keys()].sort((a, b) => b.length - a.length);
    for (const url of urls) {
      const rel = mediaPathByUrl.get(url);
      if (url && url !== rel) out = out.split(url).join(rel);
    }
    return out;
  }

  function buildMediaIndex(ctx, entries, lessonDir) {
    ctx.mediaIndex = new Map();
    const used = new Set();
    for (const m of ctx.media) {
      let name = mediaNameFor(m.url, m.kind, 0);
      if (used.has(name)) name = hashStr(m.url) + name;
      used.add(name);
      ctx.mediaIndex.set(m.url, lessonDir + "/media/" + name);
    }
  }

  function b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // Zip in this (page) context. Primary download is an <a download> click; the
  // background blob:/data: path is only a fallback if the anchor path throws.
  async function packageAndSave(entries, filename) {
    const files = {};
    for (const f of entries) {
      const p = (f.path || "").replace(/^\/+/, "");
      if (!p) continue;
      files[p] = f.data ? b64ToU8(f.data) : new TextEncoder().encode(f.text || "");
    }
    const zipped = fflate.zipSync(files, { level: 6 });

    try {
      const blob = new Blob([zipped], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
      // The download owns the blob reference now; page teardown cleans it up.
      return { ok: true, via: "anchor" };
    } catch (e) {
      log("anchor download failed: " + (e.message || e));
    }

    let b64 = "";
    try {
      const candidate = u8ToB64(zipped);
      if (candidate.length < 48e6) b64 = candidate;
    } catch (e) { log("zip base64 encode failed: " + (e.message || e)); }

    let blobUrl = null;
    try {
      const blob = new Blob([zipped], { type: "application/zip" });
      blobUrl = URL.createObjectURL(blob);
    } catch (e) { log("blob create failed: " + (e.message || e)); }

    if (!blobUrl && !b64) return { ok: false, error: "zip fallback unavailable (too large and no blob URL)" };

    const res = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "saveZip", filename, blobUrl, b64, fileCount: Object.keys(files).length }, resolve);
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
    // keep the fallback blob alive a little while for the download to grab it
    setTimeout(() => { if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) {} } }, 60000);
    return res;
  }
  async function onSavePage() {
    try {
      log("Extracting current page...");
      await settleContent(12000);
      const c = await getActiveContent();
      const dirName = (c.pageTitle && c.pageTitle !== c.title ? c.pageTitle : c.title);
      const dir = sanitizeName(courseTitle(), 40) + "/pages/" + sanitizeName(dirName, 50);
      const entries = [];
      const mediaPathByUrl = new Map();
      const usedNames = new Set();
      for (const m of c.media) {
        if (m.url.startsWith("data:")) {
          const info = dataUriInfo(m.url);
          const name = uniqueMediaName("img-" + hashStr(m.url) + info.ext, m.url, usedNames);
          await saveFileEntry(entries, dir + "/media", name, info.value, info.isText);
          mediaPathByUrl.set(m.url, "media/" + name);
        } else {
          const name = uniqueMediaName(mediaNameFor(m.url, m.kind, 0), m.url, usedNames);
          const ok = await fetchAndAdd(entries, dir + "/media", m.url, name);
          if (ok) mediaPathByUrl.set(m.url, "media/" + name);
        }
      }
      const md = rewriteMediaLinks(c.md, mediaPathByUrl);
      entries.push({ path: dir + "/content.md", text: "# " + c.title + "\n\n" + md });
      entries.push({ path: dir + "/content.html", text: "<!doctype html><meta charset=utf-8><title>" + c.title + "</title>" + c.html });
      if (c.manifest) {
        const mf = await fetchManifestFiles(c.manifest.courseId, c.manifest.moduleId, c.manifest.lang);
        for (const [rel, text] of Object.entries(mf.files)) {
          await saveFileEntry(entries, dir + "/raw", rel.replace(/\//g, "__"), text, true);
        }
      }
      await captureViewedPdfs(entries, dir, new Set());
      const res = await packageAndSave(entries, dir + ".zip");
      if (res && res.ok) log("Saved " + dir + ".zip (" + entries.length + " files, root=" + (c.root.tagName + "#" + (c.root.id || "")) + ", md=" + md.length + ", via " + (res.via || "?") + ")");
      else log("Save failed: " + (res && res.error));
    } catch (e) {
      log("Save page failed: " + (e.message || e));
    } finally {
      // no persistent lock for single-page saves
    }
  }

  async function onDownloadCourse() {
    if (busy) { log("Already running"); return; }
    busy = true;
    const capturedPages = [];
    try {
      log("Scanning course outline...");
      const groups = parseOutline(document);
      if (!groups.length) {
        log("No course outline found. Try 'Save this page' instead.");
        return;
      }
      const courseDir = sanitizeName(courseTitle(), 40);
      const entries = [];
      const savedDirs = new Set();
      const viewedPdfSeen = new Set(); // dedupe viewed-PDF captures across the walk

      // iframe route info: courseId + lang + moduleNumber (courseId is constant per course)
      const baseRoute = (() => {
        const f = activeIframe();
        let u = f ? (f.src || "") : location.href;
        if (f) { try { u = f.contentWindow.location.href || f.src; } catch (e) {} }
        const h = u.match(/#\/courses\/([^/?#]+)\/([^/?#]+)\/id\/([^/?#]+)/);
        const lang = (u.match(/[?&]lang=([a-zA-Z0-9-]+)/) || [])[1] || "en-US";
        const mn = (u.match(/[?&]moduleNumber=(\d+)/) || [])[1] || null;
        return { courseId: h ? h[1] : null, moduleId: h ? h[2] : null, lang, moduleNumber: mn };
      })();

      const readSig = currentSig;

      // navigate the active iframe to a page of a given content module (hash routing)
      const gotoPage = (moduleId, pageId, moduleNumber) => {
        const f = activeIframe();
        if (!f || !baseRoute.courseId || !moduleId) return false;
        try {
          // the iframe's src attribute goes stale after in-iframe navigation; use the live document URL
          let href = null;
          try { href = f.contentWindow.location.href; } catch (e) {}
          const u = new URL(href || f.src);
          // keep the moduleNumber query param in sync: the app expands page titles/labels from it
          if (moduleNumber) u.searchParams.set("moduleNumber", moduleNumber);
          u.hash = "/courses/" + baseRoute.courseId + "/" + moduleId + "/id/" + pageId;
          f.contentWindow.location.replace(u.toString());
          return true;
        } catch (e) { return false; }
      };

      const iframeHasPageId = (pageId) => {
        if (!pageId) return false;
        const f = activeIframe();
        return !!(f && iframeHref(f).includes("/id/" + pageId));
      };

      const waitForPage = async (beforeSig, expectedPageId, timeoutMs) => {
        const deadline = Date.now() + (timeoutMs || 90000);
        let stable = 0, lastSig = null;
        while (Date.now() < deadline) {
          await sleep(1200);
          const s = readSig();
          if (s === beforeSig) {
            // "already there" is only safe when the live route proves it
            if (expectedPageId && iframeHasPageId(expectedPageId)) break;
            continue;
          } else {
            if (s === lastSig) stable++;
            else stable = 0;
            lastSig = s;
            if (stable >= 2) break;
          }
        }
      };

      // save whatever is currently displayed in the player
      const saveCurrent = async (moduleLabel, pageTitle) => {
        const c = await getActiveContent();
        const label = (c.pageTitle && c.pageTitle !== c.title ? c.pageTitle : expandTemplate(pageTitle || c.title, { moduleNumber: baseRoute.moduleNumber })) || c.title;
        const dir = courseDir + "/lessons/" + sanitizeName(moduleLabel, 40) + "/" + sanitizeName(label, 60);
        if (!savedDirs.has(dir)) {
          savedDirs.add(dir);
          const mediaPathByUrl = new Map();
          const usedNames = new Set();
          for (const m of c.media) {
            if (m.url.startsWith("data:")) {
              const info = dataUriInfo(m.url);
              const name = uniqueMediaName("img-" + hashStr(m.url) + info.ext, m.url, usedNames);
              await saveFileEntry(entries, dir + "/media", name, info.value, info.isText);
              mediaPathByUrl.set(m.url, "media/" + name);
            } else {
              const name = uniqueMediaName(mediaNameFor(m.url, m.kind, 0), m.url, usedNames);
              const ok = await fetchAndAdd(entries, dir + "/media", m.url, name);
              if (ok) mediaPathByUrl.set(m.url, "media/" + name);
            }
          }
          const md = rewriteMediaLinks(c.md, mediaPathByUrl);
          entries.push({ path: dir + "/content.md", text: "# " + label + "\n\n" + md });
          entries.push({ path: dir + "/content.html", text: "<!doctype html><meta charset=utf-8><title>" + label + "</title>" + c.html });
          await captureViewedPdfs(entries, dir, viewedPdfSeen);
        }
        capturedPages.push(label);
        return c;
      };

      // fetch raw JSON + all assets + resources for one content module
      const fetchModuleAssets = async (moduleId) => {
        const mf = await fetchManifestFiles(baseRoute.courseId, moduleId, baseRoute.lang);
        const mdir = courseDir + "/modules/" + moduleId.slice(0, 8);
        for (const [rel, text] of Object.entries(mf.files)) {
          await saveFileEntry(entries, mdir + "/raw", rel.replace(/\//g, "__"), text, true);
        }
        let ai = 0;
        const assetNames = new Set();
        for (const aurl of mf.assets) {
          const name = uniqueMediaName(mediaNameFor(aurl, "asset", ai++), aurl, assetNames);
          await fetchAndAdd(entries, mdir + "/assets", aurl, name);
        }
        const usedRes = new Set();
        for (const r of mf.resources) {
          await captureResource(entries, r, courseDir + "/resources", usedRes);
        }
        log("module " + moduleId.slice(0, 8) + ": " + mf.assets.length + " assets, " + mf.resources.length + " resources");
      };

      // ---- walk sections in outline order ----
      const total = groups.reduce((n, g) => n + g.subs.length, 0);
      const waitForIframe = async (ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const f = activeIframe();
          if (f) return f;
          await sleep(500);
        }
        return null;
      };
      const visitedModules = new Set();
      let idx = 0;
      for (const g of groups) {
        for (const sub of g.subs) {
          idx++;
          try {
            // the section button's aria-controls maps to its blocks region: "submodule-<contentModuleId>"
            const ac = sub.btnEl ? sub.btnEl.getAttribute("aria-controls") : null;
            const moduleId = ac && /^submodule-/.test(ac) ? ac.replace(/^submodule-/, "") : null;
            if (moduleId && visitedModules.has(moduleId)) {
              log(idx + "/" + total + " " + sub.title + " (already captured)");
              continue;
            }
            if (moduleId) {
              // Cinnamon section: mount the player on this content module. Use the module
              // header button (not just the page button): the app rewrites the player URL
              // with this module's moduleNumber + launch key, which the page title/labels
              // expand from. Without it the app keeps the previous module's number.
              const modBtn = (g.modEl && (g.modEl.querySelector("button") || g.modEl)) || sub.btnEl;
              if (modBtn) modBtn.click();
              const f = await waitForIframe(15000);
              if (!f) {
                log(idx + "/" + total + " " + sub.title + " (player iframe missing)");
                continue;
              }
              if (!visitedModules.has(moduleId)) {
                const base = "https://www.netacad.com/authoring-resources/courses/" + baseRoute.courseId + "/" + moduleId + "/" + baseRoute.lang + "/";
                let pages = [];
                const r = await fetchText(base + "contentObjects.json");
                if (r.ok) {
                  const objs = JSON.parse(r.text);
                  if (Array.isArray(objs)) {
                    pages = objs.filter((o) => o && o._type === "page" && o._id)
                      .map((o) => ({ id: o._id, title: o.title || "" }));
                  }
                }
                if (pages.length) {
                  // this module's number, for correct title/label expansion
                  const modNum = (String(g.module).match(/Module\s*(\d+)/i) || [])[1] || baseRoute.moduleNumber;
                  for (const pg of pages) {
                    const beforeSig = readSig();
                    if (!gotoPage(moduleId, pg.id, modNum)) {
                      log(idx + "/" + total + " " + (pg.title || pg.id) + " (navigation unavailable)");
                      continue;
                    }
                    await waitForPage(beforeSig, pg.id);
                    const label = expandTemplate(pg.title, { moduleNumber: modNum });
                    const c = await saveCurrent(g.module, label);
                    log(idx + "/" + total + " " + label + " [root=" + (c.root.tagName + "#" + (c.root.id || "")) + ", md=" + c.md.length + "]");
                  }
                } else {
                  const beforeSig = readSig();
                  await waitForPage(beforeSig, null, 15000);
                  await saveCurrent(g.module, sub.title);
                  log(idx + "/" + total + " " + sub.title);
                }
                await fetchModuleAssets(moduleId);
                visitedModules.add(moduleId);
              }
            } else {
              // native single-page section (survey / exam): the button navigates
              const beforeSig = readSig();
              if (sub.btnEl) sub.btnEl.click();
              await waitForPage(beforeSig, null, 15000);
              await saveCurrent(g.module, sub.title);
              log(idx + "/" + total + " " + sub.title);
            }
          } catch (e) {
            log("section failed: " + e.message);
          }
        }
      }

      // README + manifest
      const readme =
        "# " + (document.title || courseDir) + "\n\n" +
        "Source: " + location.href + "\n" +
        "Extracted: " + new Date().toISOString() + "\n" +
        "Pages: " + capturedPages.length + "\n\n" +
        "Layout:\n" +
        "- lessons/<module>/<page>/content.md | content.html | media/*\n" +
        "- modules/<id>/raw/*.json (course data) | modules/<id>/assets/* (all lab/doc assets incl. .pka)\n" +
        "- resources/* (course resource documents)\n";
      entries.push({ path: courseDir + "/README.md", text: readme });
      entries.push({ path: courseDir + "/manifest.json", text: JSON.stringify({
        course: courseDir, source: location.href, date: new Date().toISOString(),
        pages: capturedPages,
      }, null, 2) });

      log("Packaging " + entries.length + " files...");
      const res = await packageAndSave(entries, courseDir + ".zip");
      if (res && res.ok) log("DONE: " + courseDir + ".zip (" + entries.length + " files, via " + (res.via || "?") + "). Check your Downloads folder.");
      else log("ZIP failed: " + (res && res.error));
    } catch (e) {
      log("Course download failed: " + (e.message || e));
    } finally {
      busy = false;
    }
  }
  let busy = false;

  // blob-download capture: when background sees a downloadStarted with a blob: url,
  // find the blob in this frame and ship its bytes
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "downloadStarted" && msg.url && msg.url.startsWith("blob:")) {
      const blob = objectUrlToBlob.get(msg.url);
      if (!blob) return;
      (async () => {
        try {
          const b64 = await blobToB64(blob);
          const fname = (msg.filename || "download") + "-captured";
          const res = await new Promise((resolve) =>
            chrome.runtime.sendMessage({ type: "downloadUrl", url: msg.url, filename: fname }, resolve));
          log("captured blob download: " + fname + " (" + blob.size + " bytes)");
        } catch (e) { log("blob capture failed: " + e.message); }
      })();
    }
  });

  // action button toggles the panel
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ngb-toggle") {
      if (IS_TOP) {
        if (document.getElementById("__ngbPanelHost")) document.getElementById("__ngbPanelHost").remove();
        else buildUI();
      }
    }
  });

  // ------------------------------------------------- 11. init
  function init() {
    try { document.documentElement.setAttribute("data-ngb-cs", CS_VERSION); } catch (e) {}
    window.addEventListener("unhandledrejection", (e) => {
      const r = e && e.reason;
      const s = (r && (r.stack || r.message)) || r || "unknown";
      try { log("UNHANDLED: " + String(s).slice(0, 700)); } catch (x) {}
    });
    installUnlock();
    installBlobHook();
    if (IS_TOP) buildUI();
    // keep unlock alive against re-renders
    // Console debug hook: window.postMessage({__ngb:"extractPdf", b64:"...", seq:N})
    // runs the same extractPdf path used for course PDFs and posts the result back.
    window.addEventListener("message", (e) => {
      const d = e && e.data;
      if (!d || d.__ngb !== "extractPdf" || typeof d.b64 !== "string") return;
      (async () => {
        const r = await extractPdfViaSW(d.b64, 90000);
        const out = { __ngb: "extractPdfResult", seq: d.seq, ok: r.ok, pages: r.pages, size: r.size, empty: r.empty, error: r.error, head: r.text ? String(r.text).slice(0, 120) : null };
        try { log("debug extractPdf: " + JSON.stringify(out)); } catch (x) {}
        window.postMessage(out, "*");
      })();
    });
    setInterval(() => { try { installUnlock(); } catch (e) {} }, 3000);
    NG("ready" + (IS_TOP ? " (top frame, UI on)" : " (iframe)"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
