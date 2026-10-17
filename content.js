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
  const CS_VERSION = "1.0.9";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------- utils
  function sanitizeName(s, maxLen) {
    maxLen = maxLen || 60;
    const out = String(s || "")
      .replace(/[\u2010-\u2015\u2212]/g, "-") // typographic dashes
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\u2026/g, "...")
      .replace(/\u00a0/g, " ")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/-+/g, "-")
      .trim()
      .slice(0, maxLen)
      .replace(/[ .-]+$/g, "");
    return out || "untitled";
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
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

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // NetAcad repeats page/block status in aria-only labels ("Incomplete").
  // Skip those subtrees so lesson text is not polluted with screen-reader chrome.
  const SKIP_CLASS_RE = /(^|[\s_-])(accessibility[\w-]*|sr-only|visually-hidden|screen-reader[\w-]*|js-heading|js-heading-inner|aria-label)([\s_-]|$)/i;
  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === "__ngbPanelHost") return true;
    if (el.hasAttribute("hidden")) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    const cls = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
    if (SKIP_CLASS_RE.test(cls)) return true;
    // video.js chrome (transcript controls, dropdowns, spinners) is not lesson
    // text; keep the poster image and any real <video> source.
    if (!/^(VIDEO|AUDIO|IMG|SOURCE)$/.test(el.tagName)) {
      if (/(^|[\s_-])vjs-/.test(cls) && !/(^|[\s_-])vjs-poster([\s_-]|$)/.test(cls)) return true;
      if (/(^|[\s_-])media-loader([\s_-]|$)/.test(cls)) return true;
    }
    // The page header is rendered again as the Markdown H1; keeping it in the
    // body duplicates the lesson title and its progress chrome.
    if (/(^|[\s_-])(page__header|page__header-wrapper)([\s_-]|$)/i.test(cls)) return true;
    const st = el.getAttribute("style") || "";
    return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(st);
  }

  function cleanInnerHtml(root) {
    if (!root) return "";
    try {
      const clone = root.cloneNode(true);
      const panel = clone.querySelector && clone.querySelector("#__ngbPanelHost");
      if (panel) panel.remove();
      return clone.innerHTML;
    } catch (e) {
      return root.innerHTML || "";
    }
  }

  function queryAllDeep(root, selector) {
    const out = [];
    if (!root) return out;
    for (const el of walkAll(root)) {
      try { if (el.matches && el.matches(selector)) out.push(el); } catch (e) {}
    }
    return out;
  }

  function elementText(el) {
    // innerText is layout-aware. textContent is only a fallback after removing
    // script/style payloads: a shadow-only body otherwise scores on its own
    // inline <script> source and outranks the real content container.
    try { const t = el.innerText; if (t && t.trim()) return t; } catch (e) {}
    let out = "";
    const stack = [el];
    while (stack.length && out.length < 20000) {
      const n = stack.pop();
      if (n.nodeType === 3) { out += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD)$/.test(n.tagName)) continue;
      for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]);
    }
    return out;
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
  function installUnlock(withOverlay) {
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

    // (b) the site's copy listeners are neutralised by mainworld.js, which
    // runs in the page's own world. Patching EventTarget here would only
    // affect this isolated world and would not touch the site's handlers.

    // (c) clear inline on<event> attributes the site may set. Content-script
    // IDL properties do not expose the page's inline handlers reliably, so
    // remove the attributes themselves.
    try {
      const attrs = ["oncontextmenu", "onselectstart", "ondragstart", "oncopy", "oncut", "onpaste"];
      const guarded = [];
      for (const el of walkAll(doc.documentElement)) {
        if (attrs.some((a) => el.hasAttribute(a))) guarded.push(el);
      }
      if (guarded.length) {
        // Remove in the page world first: removing the attribute only from
        // the isolated world can leave Chromium's compiled inline handler
        // attached. Fall back to isolated removal if mainworld is absent.
        window.postMessage({ __ngbMain: "clearInline" }, "*");
        setTimeout(() => {
          for (const el of guarded) {
            for (const attr of attrs) {
              if (el.hasAttribute(attr)) el.removeAttribute(attr);
            }
          }
        }, 250);
      }
    } catch (e) { /* best effort */ }

    // (d) capture pointer-event overlay divs: zero them out. This is a forced
    // layout pass, so only run it on the initial install, not every 3 s.
    if (withOverlay === false) return;
    try {
      for (const el of walkAll(doc.body)) {
        if (el.id === "__ngbPanelHost") continue;
        const cs = win.getComputedStyle(el);
        if (cs.position === "absolute" || cs.position === "fixed") {
          const r = el.getBoundingClientRect();
          const big = r.width > 200 && r.height > 200;
          const empty = !el.textContent.trim() && el.children.length === 0 && !el.querySelector("img,canvas,video");
          const cls = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
          const z = cs.zIndex;
          if (big && empty && cs.pointerEvents === "auto" && z !== "auto" && z !== "0" && (z !== "" || cls)) {
            // suspicious full-cover click shield; disable it
            el.style.pointerEvents = "none";
          }
        }
      }
    } catch (e) { /* best effort */ }
  }

  // Object URLs are created in the page's main world (mainworld.js tracks
  // them). Ask it for the bytes when chrome.downloads reports a blob download.
  const pageBlobWaiters = new Map(); // seq -> { resolve, timer }
  let pageBlobSeq = 0;
  let pageBridgeInstalled = false;

  function installPageBridge() {
    if (pageBridgeInstalled) return;
    pageBridgeInstalled = true;
    window.addEventListener("message", (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d) return;
      if (d.__ngbMain === "resourceDownload" && typeof d.url === "string") {
        pushResourceDownload(d);
        return;
      }
      if (d.__ngbMain !== "blobData" || typeof d.seq !== "number") return;
      const w = pageBlobWaiters.get(d.seq);
      if (!w) return;
      pageBlobWaiters.delete(d.seq);
      clearTimeout(w.timer);
      w.resolve(d);
    });
  }

  function getPageBlob(url, timeoutMs) {
    return new Promise((resolve) => {
      const seq = ++pageBlobSeq;
      const timer = setTimeout(() => {
        pageBlobWaiters.delete(seq);
        resolve({ ok: false, error: "timeout" });
      }, timeoutMs || 15000);
      pageBlobWaiters.set(seq, { resolve, timer });
      try {
        window.postMessage({ __ngbMain: "getBlob", url, seq }, "*");
      } catch (e) {
        clearTimeout(timer);
        pageBlobWaiters.delete(seq);
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  // Signed Resources-tab downloads: mainworld.js intercepts the hidden
  // <a download> before it starts and posts the URL here.
  const resourceDownloadQueue = [];
  const resourceDownloadWaiters = [];
  const resourceDownloadSeen = new Set();
  function pushResourceDownload(d) {
    if (!d || !d.url || resourceDownloadSeen.has(d.url)) return;
    resourceDownloadSeen.add(d.url);
    const w = resourceDownloadWaiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(d);
    } else {
      resourceDownloadQueue.push(d);
    }
  }
  function nextResourceDownload(timeoutMs) {
    if (resourceDownloadQueue.length) return Promise.resolve(resourceDownloadQueue.shift());
    return new Promise((resolve) => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => {
        const i = resourceDownloadWaiters.indexOf(w);
        if (i >= 0) resourceDownloadWaiters.splice(i, 1);
        resolve(null);
      }, timeoutMs || 15000);
      resourceDownloadWaiters.push(w);
    });
  }

  // ------------------------------------------------- 2. content root
  const PENALTY_RE = /nav|sidebar|outline|drawer|menu|header|footer|popup|banner|cookie|tooltip|progress|survey|chat|webex/i;

  function findContentRoot(doc) {
    const view = doc.defaultView;
    const candidates = [];
    const consider = (el) => {
      if (!el || el.nodeType !== 1) return;
      if (/^(SCRIPT|STYLE|NOSCRIPT|LINK|META|TITLE|HEAD)$/.test(el.tagName)) return;
      if (shouldSkipElement(el)) return;
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
      let pos = "static";
      try { pos = view ? view.getComputedStyle(el).position : "static"; } catch (e) {}
      if (!el.offsetParent && el.tagName !== "BODY" && pos !== "fixed") continue;
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

  const BLOCK_TAGS = /^(P|H[1-6]|UL|OL|LI|DL|DT|DD|TABLE|THEAD|TBODY|TFOOT|TR|BLOCKQUOTE|PRE|HR|DIV|SECTION|ARTICLE|FIGURE|FIGCAPTION|HEADER|FOOTER|MAIN|ASIDE|NAV|DETAILS|SUMMARY|FORM|FIELDSET|ADDRESS)$/;

  function mediaSrcOf(node) {
    const sources = [];
    if (node.currentSrc) sources.push(node.currentSrc);
    if (node.src) sources.push(node.src);
    for (const s of node.querySelectorAll ? node.querySelectorAll("source") : []) {
      if (s.src) sources.push(s.src);
    }
    return sources;
  }

  function imgMd(node, ctx) {
    const src = node.currentSrc || node.src;
    if (!src) return "";
    ctx.imgs.push(src);
    const rel = ctx.mediaIndex.get(src);
    const alt = escMd(String(node.alt || "image")).replace(/[()]/g, "\\$&");
    return "![" + alt + "](" + (rel || src) + ")";
  }

  // Markdown for one element in an inline context. inlineMd() itself only
  // walks children, so top-level inline elements (e.g. a bare <a> or <code>)
  // still render correctly when blockMd() encounters them.
  function inlineElementMd(node, ctx) {
    if (shouldSkipElement(node)) return "";
    const tag = node.tagName;
    if (tag === "BR") return "\n";
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/.test(tag)) return "";
    if (tag === "IFRAME") {
      const src = node.src || "";
      if (src && !ctx.iframeSkipped.has(src)) {
        ctx.iframeLinks.push(src);
        ctx.iframeSkipped.add(src);
        return "[embed: " + src + "]";
      }
      return "";
    }
    if (tag === "OBJECT" || tag === "EMBED") {
      const src = node.data || node.src || "";
      if (src) ctx.iframeLinks.push(src);
      return src ? "[embed: " + src + "]" : "";
    }
    if (tag === "IMG") return imgMd(node, ctx);
    if (tag === "A") {
      const t = inlineMd(node, ctx).trim();
      const href = node.href || "";
      if (href) ctx.links.push(href);
      return href ? "[" + t + "](" + href + ")" : t;
    }
    if (/^(STRONG|B)$/.test(tag)) { const t = inlineMd(node, ctx).trim(); return t ? "**" + t + "**" : ""; }
    if (/^(EM|I)$/.test(tag)) { const t = inlineMd(node, ctx).trim(); return t ? "*" + t + "*" : ""; }
    if (/^(DEL|S|STRIKE)$/.test(tag)) { const t = inlineMd(node, ctx).trim(); return t ? "~~" + t + "~~" : ""; }
    if (tag === "CODE") { const t = node.textContent; return t ? "`" + t.replace(/`/g, "\\`") + "`" : ""; }
    if (tag === "VIDEO" || tag === "AUDIO") {
      const src = (mediaSrcOf(node)[0] || "");
      if (src) ctx.media.push({ url: src, kind: tag === "VIDEO" ? "video" : "audio" });
      return src ? "[" + tag.toLowerCase() + ": " + src + "]" : "";
    }
    return inlineMd(node, ctx);
  }

  function isChromeText(text) {
    return /^(scroll to begin|show transcript|follow along using the transcript\.?)$/i.test(String(text || "").trim());
  }

  function inlineMd(node, ctx) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (!isChromeText(child.nodeValue)) out += escMd(child.nodeValue.replace(/\s+/g, " "));
      } else if (child.nodeType === 1) {
        out += inlineElementMd(child, ctx);
      }
    }
    return out;
  }

  function listMd(listEl, ctx, depth) {
    const lines = [];
    const start = parseInt(listEl.getAttribute("start") || "1", 10);
    let n = Number.isFinite(start) ? start - 1 : 0;
    const ordered = listEl.tagName === "OL";
    for (const li of listEl.children) {
      if (li.tagName !== "LI") continue;
      n++;
      const parts = [];
      const subs = [];
      for (const child of li.childNodes) {
        if (child.nodeType === 3) parts.push(escMd(child.nodeValue.replace(/\s+/g, " ")));
        else if (child.nodeType === 1) {
          if (child.tagName === "UL" || child.tagName === "OL") subs.push(child);
          else parts.push(inlineElementMd(child, ctx));
        }
      }
      const text = parts.join("").replace(/[ \t]+/g, " ").trim();
      lines.push("  ".repeat(depth) + (ordered ? n + ". " : "- ") + text);
      for (const sub of subs) lines.push(...listMd(sub, ctx, depth + 1));
    }
    return lines;
  }

  function blockChildrenMd(node, ctx, depth) {
    const lines = [];
    let inlineBuf = "";
    const flush = () => {
      const t = inlineBuf.replace(/[ \t]+/g, " ").trim();
      if (t) lines.push(t, "");
      inlineBuf = "";
    };
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (!isChromeText(child.nodeValue)) inlineBuf += escMd(child.nodeValue.replace(/\s+/g, " "));
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/.test(child.tagName)) continue;
      if (BLOCK_TAGS.test(child.tagName) || child.shadowRoot) {
        flush();
        lines.push(...blockMd(child, ctx, depth + 1));
      } else {
        inlineBuf += inlineElementMd(child, ctx);
      }
    }
    flush();
    if (node.shadowRoot) {
      for (const child of node.shadowRoot.children) lines.push(...blockMd(child, ctx, depth + 1));
    }
    return lines;
  }

  function tableMd(node, ctx) {
    const lines = [];
    const rows = [...node.querySelectorAll("tr")];
    if (!rows.length) return lines;
    const mdRows = rows.map((tr) => {
      const cells = [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH");
      return "|" + cells.map((cell) =>
        " " + inlineMd(cell, ctx).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() + " "
      ).join("|") + "|";
    });
    const cols = Math.max(1, [...rows[0].children].filter((c) => c.tagName === "TD" || c.tagName === "TH").length);
    lines.push(mdRows[0], "|" + " --- |".repeat(cols), ...mdRows.slice(1), "");
    return lines;
  }

  function blockMd(node, ctx, depth) {
    // returns array of markdown lines
    const lines = [];
    const tag = node.tagName;
    // non-content nodes: skip (e.g. the <style id="customCSS"> blobs in shadow roots)
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/.test(tag)) return lines;
    if (shouldSkipElement(node)) return lines;
    const videoIds = node.getAttribute && node.getAttribute("data-videoids");
    if (videoIds) lines.push("[video-id: " + videoIds + "]", "");

    if (/^H[1-6]$/.test(tag)) {
      const t = inlineMd(node, ctx).replace(/\s+/g, " ").trim();
      if (t) lines.push("#".repeat(+tag[1]) + " " + t, "");
      return lines;
    }
    if (tag === "HR") { lines.push("---", ""); return lines; }
    if (tag === "PRE") {
      const t = node.textContent.replace(/\s+$/g, "");
      const longest = (t.match(/`+/g) || []).reduce((m, s) => Math.max(m, s.length), 2);
      const fence = "`".repeat(Math.max(3, longest + 1));
      lines.push(fence, t, fence, "");
      return lines;
    }
    if (tag === "BLOCKQUOTE") {
      const txt = blockChildrenMd(node, ctx, depth).join("\n");
      lines.push(txt.split("\n").map((l) => (l ? "> " + l : ">")).join("\n"), "");
      return lines;
    }
    if (tag === "UL" || tag === "OL") {
      lines.push(...listMd(node, ctx, 0), "");
      return lines;
    }
    if (tag === "TABLE") {
      lines.push(...tableMd(node, ctx));
      return lines;
    }
    if (tag === "P") {
      const t = inlineMd(node, ctx).replace(/[ \t]+/g, " ").trim();
      if (t) lines.push(t, "");
      return lines;
    }
    if (tag === "IMG") {
      const md = imgMd(node, ctx).trim();
      if (md) lines.push(md, "");
      return lines;
    }
    if (tag === "VIDEO" || tag === "AUDIO") {
      const md = inlineElementMd(node, ctx).trim();
      if (md) lines.push(md, "");
      return lines;
    }
    if (BLOCK_TAGS.test(tag) || node.shadowRoot) {
      lines.push(...blockChildrenMd(node, ctx, depth));
      return lines;
    }
    const t = inlineElementMd(node, ctx).replace(/\s+/g, " ").trim();
    if (t) lines.push(t, "");
    return lines;
  }

  function docToMarkdown(root) {
    const ctx = { imgs: [], media: [], links: [], iframeLinks: [], iframeSkipped: new Set(), mediaIndex: new Map() };
    const lines = blockChildrenMd(root, ctx, 0);
    let md = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    return { md, ctx };
  }

  // ------------------------------------------------- 4. media collect
  const MEDIA_EXT_RE = /\.(mp4|webm|mov|avi|mkv|m4v|m3u8|mpd|mp3|wav|m4a|ogg|flac|pdf|pptx?|docx?|xlsx?|csv|zip|rar|7z|pka|pkt|json|xml|png|jpe?g|gif|webp|avif|svg|bmp|ico|vtt|srt)(?:[?#]|$)/i;
  const KNOWN_EXT = /^(mp4|webm|mov|avi|mkv|m4v|m3u8|mpd|mp3|wav|m4a|ogg|flac|pdf|ppt|pptx|doc|docx|xls|xlsx|csv|zip|rar|7z|pka|pkt|json|xml|png|jpg|jpeg|gif|webp|avif|svg|bmp|ico|vtt|srt)$/i;

  function extFromUrl(url, ct) {
    const m = String(url || "").match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
    if (m && KNOWN_EXT.test(m[1])) return "." + m[1].toLowerCase();
    if (ct) {
      const type = String(ct).split(";")[0].trim().toLowerCase();
      const map = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/svg+xml": ".svg", "image/webp": ".webp",
        "image/gif": ".gif", "image/avif": ".avif", "video/mp4": ".mp4", "video/webm": ".webm",
        "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".ogg",
        "application/pdf": ".pdf", "application/zip": ".zip", "application/json": ".json",
        "application/vnd.apple.mpegurl": ".m3u8", "application/x-mpegurl": ".m3u8",
        "text/plain": ".txt", "text/csv": ".csv", "text/markdown": ".md", "text/html": ".html",
        "application/octet-stream": ".bin",
      };
      if (map[type]) return map[type];
      if (/pdf/i.test(type)) return ".pdf";
    }
    return ".bin";
  }

  function resolveMediaUrl(url, base) {
    if (!url) return "";
    if (/^(data|blob|https?):/i.test(url)) return url;
    try { return new URL(url, base || location.href).href; } catch (e) { return ""; }
  }

  function collectMedia(root, ctx) {
    const found = new Map(); // url -> entry
    const base = (root && root.ownerDocument && root.ownerDocument.baseURI) || location.href;
    const add = (url, kind, name) => {
      if (!url) return;
      if (/^(javascript|mailto|tel):/i.test(url)) return;
      if (url.startsWith("blob:")) return; // not fetchable after the page unloads
      if (url.startsWith("data:")) {
        // keep data uris under their content hash
        const h = hashStr(url.slice(0, 4000));
        const key = "data:" + h;
        if (!found.has(key)) found.set(key, { url, kind: kind || "file", name: name || h + extFromUrl("", url.slice(5, url.indexOf(";"))) });
        return;
      }
      const key = url;
      if (!found.has(key)) found.set(key, { url, kind: kind || "file", name: name || null });
    };
    const addSrcset = (srcset, kind) => {
      for (const part of String(srcset || "").split(",")) {
        const url = part.trim().split(/\s+/)[0];
        if (url) add(resolveMediaUrl(url, root && root.ownerDocument && root.ownerDocument.baseURI), kind);
      }
    };

    for (const el of walkAll(root)) {
      const tag = el.tagName;
      if (tag === "IMG") {
        add(el.currentSrc || el.src, "image");
        addSrcset(el.getAttribute("srcset"), "image");
      } else if (tag === "VIDEO" || tag === "AUDIO") {
        add(el.currentSrc || el.src, tag === "VIDEO" ? "video" : "audio");
        add(resolveMediaUrl(el.getAttribute("poster"), base), "image");
        for (const s of el.querySelectorAll("source")) {
          add(s.src, tag === "VIDEO" ? "video" : "audio");
          addSrcset(s.getAttribute("srcset"), tag === "VIDEO" ? "video" : "audio");
        }
      } else if (tag === "TRACK") {
        add(el.src, "file");
      } else if (tag === "A") {
        const href = el.href;
        if (href && MEDIA_EXT_RE.test(href)) add(href, "doc");
      } else if (tag === "OBJECT" || tag === "EMBED") {
        add(resolveMediaUrl(el.data || el.src, base), "file");
      } else if (el.children.length <= 2) {
        try {
          const view = el.ownerDocument && el.ownerDocument.defaultView;
          const bg = view ? view.getComputedStyle(el).backgroundImage : "";
          if (bg && bg !== "none") {
            const m = bg.match(/url\((['"]?)(.*?)\1\)/);
            const u = m && m[2] ? resolveMediaUrl(m[2], el.ownerDocument.baseURI) : "";
            if (u && !u.startsWith("data:image/svg")) add(u, "image");
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
    // From this frame, the active player first, then any other iframe.
    const urls = [];
    const active = activeIframe();
    if (active) urls.push(iframeHref(active));
    urls.push(location.href);
    for (const f of queryAllDeep(document.documentElement, "iframe")) {
      // the iframe src attribute goes stale after in-iframe navigation; prefer the live document URL
      let u = f.src || "";
      try { u = f.contentWindow.location.href || u; } catch (e) {}
      if (!urls.includes(u)) urls.push(u);
    }
    for (const u of urls) {
      // direct-path form: .../authoring-resources/courses/<cid>/<mid>/<lang>/...
      const m = u.match(AUTHORING_RE);
      if (m) return { courseId: m[1], moduleId: m[2], lang: m[3], moduleNumber: null };
      // app form: .../authoring-resources/index.html?...&lang=XX&moduleNumber=N#/courses/<cid>/<mid>/id/<pid>
      if (/authoring-resources\/index\.html/.test(u)) {
        const h = u.match(/#\/courses\/([^/?#]+)\/([^/?#]+)(?:\/id\/([^/?#]+))?/);
        const lang = (u.match(/[?&]lang=([a-zA-Z0-9-]+)/) || [])[1] || "en-US";
        const mn = (u.match(/[?&]moduleNumber=(\d+)/) || [])[1] || null;
        if (h) return { courseId: h[1], moduleId: h[2], pageId: h[3] || null, lang, moduleNumber: mn };
      }
    }
    return null;
  }

  async function fetchText(url) {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 60000) : null;
    try {
      const r = await fetch(url, { credentials: "include", signal: ctrl ? ctrl.signal : undefined });
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, text: await r.text() };
    } catch (e) {
      return { ok: false, status: "error", error: String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  function absoluteAuthoringUrl(base, link) {
    if (!link) return "";
    try { return new URL(String(link), base).href; } catch (e) { return String(link); }
  }

  function assetPathOf(entry) {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") return entry.path || entry.url || entry._path || entry.src || "";
    return "";
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

    // assets: the platform has published both a bare array and wrapper
    // objects over time; accept all of them.
    if (out.files[lang + "/assets.json"]) {
      try {
        const parsed = JSON.parse(out.files[lang + "/assets.json"]);
        const list = Array.isArray(parsed) ? parsed
          : (parsed && (parsed.assets || parsed._assets || parsed.items || parsed._items)) || [];
        if (Array.isArray(list)) {
          const seen = new Set();
          for (const entry of list) {
            const rel = assetPathOf(entry);
            if (!rel) continue;
            const url = absoluteAuthoringUrl(base, rel);
            if (!url || seen.has(url)) continue;
            seen.add(url);
            out.assets.push(url);
          }
        }
      } catch (e) {}
    }
    // resources declared in course.json — keep title/description/type so PDFs
    // can be text-extracted and unreachable ones can leave a metadata stub
    if (out.files[lang + "/course.json"]) {
      try {
        const c = JSON.parse(out.files[lang + "/course.json"]);
        const res = c._resources || c.resources || {};
        const items = Array.isArray(res) ? res
          : (res._resourcesItems || res.items || res._items || []);
        if (Array.isArray(items)) {
          for (const it of items) {
            if (!it) continue;
            const link = it._link || it.link || it._media || it.url || "";
            if (!link) continue;
            const leaf = String(link).split("/").pop() || "resource";
            let title = it.title || leaf;
            try { title = decodeURIComponent(title); } catch (e) {}
            out.resources.push({
              url: absoluteAuthoringUrl(base, link),
              title,
              description: it.description || "",
              type: it._type || it.type || "file",
            });
          }
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
  // Fetch bytes through the service worker first: it has host permissions and
  // is not subject to the page's CORS policy. Same-origin page fetch is a
  // fallback for a worker that failed for an unrelated reason.
  async function fetchResourceBytes(url) {
    const r = await bgFetch(url);
    if (r && r.ok && typeof r.data === "string") {
      return { ok: true, status: r.status || 200, type: r.type || "", size: r.size || 0, b64: r.data };
    }
    if (r && (r.error === "too large" || r.error === "timeout")) {
      return { ok: false, status: r.status || "error", error: r.error, size: r.size || 0 };
    }
    try {
      const fr = await fetch(url, { credentials: "include" });
      if (!fr.ok) return { ok: false, status: fr.status, type: fr.headers.get("content-type") || "" };
      const len = parseInt(fr.headers.get("content-length") || "0", 10);
      if (len > MAX_PDF_BYTES) return { ok: false, status: 200, error: "too large" };
      const buf = await fr.arrayBuffer();
      if (buf.byteLength > MAX_PDF_BYTES) return { ok: false, status: 200, error: "too large" };
      return { ok: true, status: 200, type: fr.headers.get("content-type") || "", size: buf.byteLength, b64: u8ToB64(new Uint8Array(buf)) };
    } catch (e) {
      return { ok: false, status: "error", error: String((e && e.message) || e) };
    }
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

  function withExt(name, ext) {
    if (!ext) return name;
    const escaped = ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped + "$", "i").test(name) ? name : name + ext;
  }

  function uniqueResourceName(title, url, used) {
    const base = sanitizeName(title || "resource", 80);
    let name = base;
    if (used.has(name)) name = sanitizeName(base.slice(0, 60) + "-" + hashStr(url).slice(0, 6), 80);
    let i = 2;
    while (used.has(name)) {
      name = sanitizeName(base.slice(0, 60) + "-" + hashStr(url).slice(0, 6) + "-" + i++, 80);
    }
    used.add(name);
    return name;
  }

  // Capture one declared resource:
  //  - PDF reachable with the current session -> extract its text (pdf.js)
  //  - other reachable files -> raw bytes
  //  - unreachable (403/...) -> metadata stub so the resource is never lost
  async function captureResource(entries, r, dir, used, failures) {
    const title = String(r.title || "resource");
    const name = uniqueResourceName(title, r.url, used);
    const res = await fetchResourceBytes(r.url);
    const ct = res.type || "";
    const isPdf = isPdfUrl(r.url) || /pdf/i.test(ct);
    const mdPath = dir + "/" + name + ".md";

    if (res.ok && res.b64 && isPdf) {
      const ex = await extractPdfViaSW(res.b64);
      if (ex && ex.ok && !ex.empty) {
        if (!entries.some((e) => e.path === mdPath)) {
          entries.push({
            path: mdPath,
            text: pdfMetaMd(r, "**Extracted**: " + ex.pages + " page(s), " + ex.text.length + " chars of text via pdf.js (the document's content, not the raw file)") + ex.text,
          });
        }
        log("pdf " + title + ": " + ex.pages + "p, " + ex.text.length + " chars");
        return mdPath;
      }
      // PDF but no text layer (scanned) or parse failure -> keep raw bytes + note
      await saveFileEntry(entries, dir, withExt(name, ".pdf"), res.b64, false);
      if (!entries.some((e) => e.path === mdPath)) {
        entries.push({ path: mdPath, text: pdfMetaMd(r, (ex && ex.ok) ? "No extractable text layer (scanned/image PDF); raw file saved alongside" : "Extraction failed: " + (ex && ex.error) + "; raw file saved alongside") });
      }
      log("pdf " + title + ": no text (" + ((ex && ex.error) || "scanned") + "), raw saved");
      return mdPath;
    }
    if (res.ok && res.b64) {
      const rawName = withExt(name, isPdf ? ".pdf" : extFromUrl(r.url, ct));
      await saveFileEntry(entries, dir, rawName, res.b64, false);
      return null;
    }
    const why = res.error === "too large"
      ? "File reachable but over the copy limit; see source URL"
      : "**Status**: HTTP " + res.status + (res.error ? " (" + res.error + ")" : "") + " — not fetchable with the current session, no content captured";
    if (!entries.some((e) => e.path === mdPath)) {
      entries.push({ path: mdPath, text: pdfMetaMd(r, why) });
    }
    if (failures) failures.push("resource: " + title + " (" + (res.error === "too large" ? "too large" : "HTTP " + res.status) + ", stub only)");
    log("resource " + title + ": " + (res.error === "too large" ? "too large" : "HTTP " + res.status) + " -> stub");
    return mdPath;
  }

  // Capture PDFs currently rendered inside the player (the on-screen route):
  // Chrome's native PDF viewer exposes no DOM text layer, so we fetch the same
  // document the viewer is showing and parse it.
  async function captureViewedPdfs(entries, dir, seen, failures) {
    const f = activeIframe();
    if (!f) return;
    let doc = null;
    try { doc = f.contentDocument; } catch (e) { return; }
    if (!doc) return;
    const vids = [];
    for (const el of walkAll(doc.documentElement)) {
      if (el.tagName === "IFRAME" && isPdfUrl(el.src || "")) vids.push(el);
      else if ((el.tagName === "EMBED" || el.tagName === "OBJECT") && /pdf/i.test(el.getAttribute("type") || "")) vids.push(el);
    }
    for (const v of vids) {
      const src = v.src || v.data || "";
      if (!src || seen.has(src)) continue;
      seen.add(src);
      let nm = mediaNameFor(src, "pdf", 0);
      if (!/\.pdf$/i.test(nm)) nm = nm.replace(/\.[a-z0-9]{1,5}$/i, "") + ".pdf";
      const mdPath = dir + "/pdf/" + nm + ".md";
      try {
        const res = await fetchResourceBytes(src);
        if (!res.ok) {
          log("viewed pdf " + src + " -> " + (res.error || "HTTP " + res.status));
          if (!entries.some((e) => e.path === mdPath)) {
            entries.push({ path: mdPath, text: "## PDF: " + nm + "\n\nSource: " + src + "\n\nNot fetchable: " + (res.error || "HTTP " + res.status) + "\n" });
          }
          if (failures) failures.push("viewed pdf: " + src + " (" + (res.error || "HTTP " + res.status) + ")");
          continue;
        }
        const ex = await extractPdfViaSW(res.b64);
        if (ex && ex.ok && !ex.empty) {
          if (!entries.some((e) => e.path === mdPath)) entries.push({ path: mdPath, text: "## PDF: " + nm + "\n\n" + ex.text });
          log("viewed pdf " + nm + ": " + ex.pages + "p, " + ex.text.length + " chars");
        } else {
          await saveFileEntry(entries, dir + "/pdf", nm, res.b64, false);
          if (!entries.some((e) => e.path === mdPath)) {
            entries.push({ path: mdPath, text: "## PDF: " + nm + "\n\nSource: " + src + "\n\nNo extractable text layer" + ((ex && ex.error) ? ": " + ex.error : "") + "; raw file saved alongside\n" });
          }
          log("viewed pdf " + src + ": no text layer" + (ex && ex.error ? " (" + ex.error + ")" : ""));
        }
      } catch (e) {
        log("viewed pdf failed: " + ((e && e.message) || e));
        if (failures) failures.push("viewed pdf: " + src + " (" + ((e && e.message) || e) + ")");
      }
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

  // iframe bridge: parent (top frame) asks, this frame answers
  function contentDocOf(iframe) {
    try {
      const d = iframe.contentDocument;
      if (d && d.body) return d;
    } catch (e) {}
    return null;
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

  // returns [{ module, modEl, moduleNumber, subs: [{ title, btnEl, containerEl }] }]
  function parseOutline(doc) {
    const groups = [];
    const allMods = queryAllDeep(doc.documentElement, "[class*=nodeContainer]");
    // A module may contain progress steps that also use nodeContainer; keep
    // only containers that are not nested inside another module container.
    const mods = allMods.filter((m) => !allMods.some((o) => o !== m && o.contains(m)));
    for (const mod of mods) {
      const header = queryAllDeep(mod, "[class*=nodeInfoContainerWrapper]")[0];
      if (!header) continue;
      const moduleTitle = cleanOutlineText(shadowText(header));
      const moduleNumber = (moduleTitle.match(/Module\s*(\d+)/i) || [])[1] || null;
      const allSubs = queryAllDeep(mod, "[class*=subModuleContainer]");
      const subs = [];
      for (const c of allSubs) {
        if (allSubs.some((o) => o !== c && o.contains(c))) continue;
        const btn = queryAllDeep(c, "button[class*=subModuleBtn]")[0] || queryAllDeep(c, "button")[0] || c;
        const title = cleanOutlineText(btn.getAttribute("aria-label") || shadowText(btn));
        subs.push({ title, btnEl: btn, containerEl: c });
      }
      groups.push({ module: moduleTitle, modEl: header, moduleNumber, subs });
    }
    return groups;
  }

  function moduleButton(group) {
    let modEl = group && group.modEl;
    if (group && (!modEl || !modEl.isConnected)) {
      const fresh = parseOutline(document);
      const fg = fresh.find((x) => x.module === group.module) || fresh[0];
      if (fg) modEl = fg.modEl;
    }
    const buttons = modEl ? queryAllDeep(modEl, "button") : [];
    return buttons.find((b) => /module/i.test(typeof b.className === "string" ? b.className : "")) ||
      buttons.find((b) => b.hasAttribute("aria-expanded")) ||
      buttons[0] ||
      modEl ||
      null;
  }

  function subButton(group, sub) {
    if (sub && sub.btnEl && sub.btnEl.isConnected) return sub.btnEl;
    if (!group) return sub ? sub.btnEl : null;
    const fresh = parseOutline(document).find((x) => x.module === group.module);
    const fs = fresh && fresh.subs.find((s) => s.title === sub.title);
    return (fs && fs.btnEl) || (sub && sub.btnEl) || null;
  }

  function titleOf(obj, lang) {
    const t = obj && obj.title;
    if (typeof t === "string") return t;
    if (t && typeof t === "object") {
      return t[lang] || t["en-US"] || Object.values(t).find((v) => typeof v === "string") || "";
    }
    return "";
  }

  function contentObjectPages(objs, lang) {
    const list = Array.isArray(objs) ? objs
      : (objs && (objs.contentObjects || objs.items || objs._items || objs.pages)) || [];
    if (!Array.isArray(list)) return [];
    const pages = [];
    const seen = new Set();
    for (const o of list) {
      if (!o || !o._id || seen.has(o._id)) continue;
      const type = String(o._type || "").toLowerCase();
      if (type && type !== "page" && type !== "contentobject") continue;
      // Hidden content objects are Packet Tracer launcher shells (a loader
      // image and an unresolved title); the .pka files themselves are captured
      // from assets.json. Skip the shells so the ZIP has no empty lesson dirs.
      if (o._isHidden || o._hidden || o._visible === false) continue;
      seen.add(o._id);
      pages.push({ id: o._id, title: titleOf(o, lang) });
    }
    return pages;
  }



  // ------------------------------------------------- 9. UI
  let ui = null;

  function buildUI() {
    if (document.getElementById("__ngbPanelHost")) return;
    const doc = document;
    const host = doc.createElement("div");
    host.id = "__ngbPanelHost";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-label", "NetAcad Grabber");
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
      button(act) { return host.querySelector('button[data-ngb="' + act + '"]'); },
      setStatus(t) {
        this.status.textContent = t;
        this.logEl.textContent = NG.buffer.join("\n");
      },
      setBusy(on) {
        for (const act of ["copy", "page", "course"]) {
          const b = this.button(act);
          if (b) b.disabled = !!on;
        }
      },
    };
    ui.setBusy(busy);
    host.addEventListener("click", (e) => {
      const target = e.target && e.target.closest ? e.target : null;
      const b = target && target.closest("button[data-ngb]");
      if (!b) return;
      const act = b.getAttribute("data-ngb");
      if (act === "close") closeUI();
      else if (act === "copy") onCopyText();
      else if (act === "page") onSavePage();
      else if (act === "course") onDownloadCourse();
    });
    // re-sync status on interval (cheap)
    ui.timer = setInterval(() => { if (ui) ui.setStatus(NG.last || ""); }, 1500);
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
    for (const f of queryAllDeep(document.documentElement, "iframe")) {
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
    // The launch page title is often just "Course Launch"; the visible H1 has
    // the real course name.
    const el = queryAllDeep(document.documentElement, "h1[class*=courseTitle], [class*=courseNameContainer] h1, h1[class*=courseName]")[0];
    if (el) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t;
    }
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
          html: expandMd(cleanInnerHtml(root), manifest),
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
      html: expandMd(cleanInnerHtml(root), manifest),
      title: expandTemplate(document.title.replace(/\s*\|\s*.*$/, "").trim() || "page", manifest),
      pageTitle: "",
      media: collectMedia(root, ctx),
      manifest,
      iframe: null,
    };
  }

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {}
    // The clipboard API needs a focused document and often loses the user
    // activation while settleContent() runs. execCommand still works in a
    // content script with the clipboardWrite permission.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    (document.body || document.documentElement).appendChild(ta);
    let ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand("copy");
    } catch (e) {}
    ta.remove();
    return ok;
  }

  // ------------------------------------------------- 10. actions
  async function onCopyText() {
    try {
      await settleContent(12000);
      const c = await getActiveContent();
      if (!c.md.trim()) throw new Error("no lesson text found; open a page in the player first");
      const label = (c.pageTitle && c.pageTitle !== c.title ? c.pageTitle : c.title) || "page";
      const ok = await copyTextToClipboard("# " + label + "\n\n" + c.md);
      if (!ok) throw new Error("clipboard write was rejected; copy from the panel's log instead");
      log("Copied " + label + " (" + c.md.length + " chars) to clipboard");
    } catch (e) {
      log("Copy failed: " + ((e && e.message) || e));
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
    // fetchResourceBytes tries the service worker first and then the page
    // origin, so same-origin media still works if the worker fetch is blocked.
    const r = await fetchResourceBytes(url);
    if (r.ok && r.b64) {
      await saveFileEntry(entries, dir, name, r.b64, false);
      log("fetched " + name + " (" + r.size + " bytes)");
      return true;
    }
    log("FAILED " + name + " -> " + (r.status || r.error));
    return false;
  }

  function mediaNameFor(url, kind, i) {
    let base;
    if (url.startsWith("data:")) {
      base = "img-" + i + dataUriInfo(url).ext;
    } else {
      let p = "";
      try {
        const u = new URL(url, location.href);
        p = u.pathname.split("/").pop() || "";
        try { p = decodeURIComponent(p); } catch (e) {}
      } catch (e) { p = ""; }
      p = p.replace(/[?#].*$/, "");
      if (!/\.[a-z0-9]{2,5}$/i.test(p)) p = (p || "file") + extFromUrl(url, "");
      base = (p.length > 60 ? hashStr(url).slice(0, 8) + "-" + p.slice(-50) : p);
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
    const mime = (meta.split(";")[0].trim() || "application/octet-stream").toLowerCase();
    const ext = extFromUrl("", mime);
    if (/;base64(;|$)/i.test(meta)) return { value: payload.replace(/\s+/g, ""), isText: false, ext };
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

  function b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function zipPath(path) {
    const parts = String(path || "").replace(/\\/g, "/").split("/");
    const clean = [];
    for (const part of parts) {
      if (!part || part === "." || part === "..") continue;
      clean.push(part);
    }
    return clean.join("/");
  }

  // Zip in this (page) context. Primary download is an <a download> click; the
  // service worker data: path is only a fallback if the anchor path throws.
  async function packageAndSave(entries, filename) {
    const files = {};
    for (const f of entries) {
      const p = zipPath(f.path);
      if (!p) continue;
      let target = p;
      for (let n = 2; Object.prototype.hasOwnProperty.call(files, target); n++) {
        const dot = p.lastIndexOf(".");
        target = dot > 0 ? p.slice(0, dot) + "-" + n + p.slice(dot) : p + "-" + n;
      }
      files[target] = f.data ? b64ToU8(f.data) : new TextEncoder().encode(f.text || "");
    }
    const zipped = fflate.zipSync(files, { level: 6 });
    const safeName = sanitizeName(filename, 180);
    const withZip = /\.zip$/i.test(safeName) ? safeName : safeName + ".zip";

    try {
      const blob = new Blob([zipped], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = withZip;
      a.style.display = "none";
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
      return { ok: true, via: "anchor", filename: withZip };
    } catch (e) {
      log("anchor download failed: " + ((e && e.message) || e));
    }

    let b64 = "";
    try {
      const candidate = u8ToB64(zipped);
      if (candidate.length < 48e6) b64 = candidate;
    } catch (e) { log("zip base64 encode failed: " + ((e && e.message) || e)); }
    if (!b64) return { ok: false, error: "ZIP is too large for the fallback download; the anchor path failed" };

    const res = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "saveZip", filename: withZip, b64, fileCount: Object.keys(files).length }, resolve);
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
    return res;
  }
  async function onSavePage() {
    try {
      log("Extracting current page...");
      await settleContent(12000);
      const c = await getActiveContent();
      if (!c.md.trim() && !c.media.length) throw new Error("no lesson content found; open a page in the player first");
      const dirName = sanitizeName((c.pageTitle && c.pageTitle !== c.title ? c.pageTitle : c.title), 70);
      const courseDir = sanitizeName(courseTitle(), 80);
      const dir = courseDir + "/pages/" + dirName;
      const entries = [];
      const failures = [];
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
          else failures.push("media: " + m.url);
        }
      }
      const md = rewriteMediaLinks(c.md, mediaPathByUrl);
      const pageLabel = (c.pageTitle && c.pageTitle !== c.title ? c.pageTitle : c.title) || "page";
      entries.push({ path: dir + "/content.md", text: "# " + pageLabel + "\n\n" + md });
      entries.push({ path: dir + "/content.html", text: "<!doctype html><meta charset=utf-8><title>" + escapeHtml(pageLabel) + "</title>" + c.html });
      if (c.manifest && c.manifest.courseId && c.manifest.moduleId) {
        const mf = await fetchManifestFiles(c.manifest.courseId, c.manifest.moduleId, c.manifest.lang);
        for (const [rel, text] of Object.entries(mf.files)) {
          await saveFileEntry(entries, dir + "/raw", rel.replace(/\//g, "__"), text, true);
        }
      }
      await captureViewedPdfs(entries, dir, new Set(), failures);
      if (failures.length) entries.push({ path: dir + "/FAILURES.txt", text: failures.join("\n") + "\n" });
      const res = await packageAndSave(entries, courseDir + " - " + dirName + ".zip");
      if (res && res.ok) log((failures.length ? "Saved (partial) " : "Saved ") + (res.filename || "page.zip") + " (" + entries.length + " files, root=" + (c.root.tagName + "#" + (c.root.id || "")) + ", md=" + md.length + ", via " + (res.via || "?") + ")");
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
    if (ui) ui.setBusy(true);
    const capturedPages = [];
    try {
      log("Scanning course outline...");
      const groups = parseOutline(document);
      if (!groups.length) {
        log("No course outline found. Try 'Save this page' instead.");
        return;
      }
      const courseDir = sanitizeName(courseTitle(), 80);
      const entries = [];
      const failures = [];
      const capturedDirs = new Set();
      const viewedPdfSeen = new Set(); // dedupe viewed-PDF captures across the walk
      const resourceByUrl = new Map(); // URL -> path in the ZIP
      const resourceByKey = new Set(); // title + leaf, same resource in two modules
      const usedResourceNames = new Set();

      // iframe route info: courseId + lang + moduleNumber (courseId is constant per course)
      const detected = detectManifest() || {};
      let playerUrl = location.href;
      const f0 = activeIframe();
      if (f0) playerUrl = iframeHref(f0) || playerUrl;
      const hash = playerUrl.match(/#\/courses\/([^/?#]+)\/([^/?#]+)\/id\/([^/?#]+)/);
      const lang = (playerUrl.match(/[?&]lang=([a-zA-Z0-9-]+)/) || [])[1];
      const mn = (playerUrl.match(/[?&]moduleNumber=(\d+)/) || [])[1];
      const baseRoute = {
        courseId: detected.courseId || (hash && hash[1]) || null,
        moduleId: detected.moduleId || (hash && hash[2]) || null,
        lang: detected.lang || lang || "en-US",
        moduleNumber: detected.moduleNumber || mn || null,
      };
      const readSig = currentSig;
      // Content-only signature (no URL, no document title): the hash updates
      // before the SPA paints, so URL changes alone must not prove navigation.
      const readContentSig = () => {
        const f = activeIframe();
        const d = f ? contentDocOf(f) : null;
        if (!d) return "none";
        let root = null;
        for (const el of walkAll(d.documentElement)) {
          if (el.id === "Wrapper" || el.tagName === "PAGE-VIEW" || el.tagName === "ARTICLE-VIEW") { root = el; break; }
        }
        if (!root) return "none";
        const t = shadowTextParts(root, 6000, 2000);
        return hashStr(t.head + "\n" + t.tail) + ":" + t.total;
      };

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
        if (!f) return false;
        return new RegExp("/id/" + escapeRegExp(pageId) + "(?:[?#]|$)").test(iframeHref(f));
      };

      const normTitle = (s) => String(s || "")
        .toLowerCase()
        .replace(/\{\{[^}]*\}\}/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      const iframeTitleHas = (label) => {
        const want = normTitle(label);
        if (!want) return true;
        const f = activeIframe();
        const d = f ? contentDocOf(f) : null;
        return !!(d && normTitle(d.title).includes(want));
      };

      const waitForRoute = async (moduleId, timeoutMs) => {
        const deadline = Date.now() + (timeoutMs || 15000);
        const re = new RegExp("/(?:courses/[^/?#]+/)?" + escapeRegExp(moduleId) + "(?:/|[?#]|$)");
        while (Date.now() < deadline) {
          const f = activeIframe();
          if (f && re.test(iframeHref(f))) return true;
          await sleep(300);
        }
        return false;
      };

      // The player may not have mounted a page yet when the panel is opened.
      // Once a module header is clicked, the iframe URL carries the course id;
      // refresh the route without freezing the walker on the initial null.
      const refreshRoute = () => {
        const d = detectManifest() || {};
        if (d.courseId) baseRoute.courseId = d.courseId;
        if (d.lang) baseRoute.lang = d.lang;
        if (d.moduleNumber) baseRoute.moduleNumber = d.moduleNumber;
      };
      const waitForCourseRoute = async (timeoutMs) => {
        const deadline = Date.now() + (timeoutMs || 15000);
        while (Date.now() < deadline) {
          const f = activeIframe();
          if (f && /\/courses\/[^/?#]+\//.test(iframeHref(f))) return true;
          await sleep(300);
        }
        return false;
      };

      const waitForPage = async (beforeSig, expectedPageId, timeoutMs, expectedLabel, alreadyThere) => {
        const started = Date.now();
        const deadline = started + (timeoutMs || 90000);
        const beforeContent = readContentSig();
        let stable = 0, lastSig = null, contentChanged = false;
        while (Date.now() < deadline) {
          await sleep(1000);
          const s = readSig();
          if (readContentSig() !== beforeContent) contentChanged = true;
          if (s === lastSig) stable++;
          else { stable = 0; lastSig = s; }
          if (stable >= 2) {
            if (expectedPageId) {
              // The hash updates synchronously but the SPA paints later. A
              // route match alone is not enough: require either a real text
              // change or a matching rendered title, or the previous page
              // gets written under the new page's name.
              if (!iframeHasPageId(expectedPageId)) continue;
              if (contentChanged || !expectedLabel || iframeTitleHas(expectedLabel)) return true;
              // The target was already the live route before navigation and
              // the player gives no title match; give it a bounded settle.
              if (alreadyThere && Date.now() - started > 8000) return true;
              continue;
            }
            // No route target: a real content change is required.
            return contentChanged;
          }
        }
        return false;
      };

      const dirsByModule = new Map();
      const usedDirPaths = new Set();
      const lessonDirFor = (moduleLabel, label, key) => {
        const mod = sanitizeName(moduleLabel || "Module", 70);
        let map = dirsByModule.get(mod);
        if (!map) { map = new Map(); dirsByModule.set(mod, map); }
        if (map.has(key)) return map.get(key);
        let dir = mod + "/" + sanitizeName(label || "page", 70);
        if (usedDirPaths.has(dir)) {
          const suffix = "-" + hashStr(String(key)).slice(0, 6);
          dir = mod + "/" + sanitizeName((label || "page").slice(0, 70 - suffix.length) + suffix, 70);
          let i = 2;
          while (usedDirPaths.has(dir)) {
            dir = mod + "/" + sanitizeName((label || "page").slice(0, 60) + "-" + i++, 70);
          }
        }
        usedDirPaths.add(dir);
        map.set(key, dir);
        return dir;
      };

      // save whatever is currently displayed in the player
      const saveCurrent = async (moduleLabel, pageTitle, key, moduleNumber, expectedLabel) => {
        const c = await getActiveContent();
        let titleOk = true;
        if (expectedLabel) {
          const actual = normTitle(c.pageTitle || c.title);
          const want = normTitle(expectedLabel);
          titleOk = !!(actual && want && actual.includes(want));
          if (!titleOk) log("page title differs (wanted \"" + expectedLabel + "\", got \"" + (c.pageTitle || c.title) + "\"); using requested label");
        }
        const label = (!expectedLabel || titleOk)
          ? ((c.pageTitle && c.pageTitle !== c.title ? c.pageTitle : expandTemplate(pageTitle || c.title, { moduleNumber: moduleNumber || baseRoute.moduleNumber })) || c.title || "page")
          : expectedLabel;
        const dir = courseDir + "/lessons/" + lessonDirFor(moduleLabel, label, key || label);
        if (!capturedDirs.has(dir)) {
          capturedDirs.add(dir);
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
              else failures.push("media: " + m.url + " (" + label + ")");
            }
          }
          const md = rewriteMediaLinks(c.md, mediaPathByUrl);
          entries.push({ path: dir + "/content.md", text: "# " + label + "\n\n" + md });
          entries.push({ path: dir + "/content.html", text: "<!doctype html><meta charset=utf-8><title>" + escapeHtml(label) + "</title>" + c.html });
          await captureViewedPdfs(entries, dir, viewedPdfSeen, failures);
        }
        capturedPages.push(label);
        return c;
      };

      // fetch raw JSON + all assets + resources for one content module
      const fetchModuleAssets = async (moduleId) => {
        if (!baseRoute.courseId) return;
        const mf = await fetchManifestFiles(baseRoute.courseId, moduleId, baseRoute.lang);
        const mdir = courseDir + "/modules/" + sanitizeName(moduleId.slice(0, 8), 40);
        for (const [rel, text] of Object.entries(mf.files)) {
          await saveFileEntry(entries, mdir + "/raw", rel.replace(/[\\/]/g, "__"), text, true);
        }
        let ai = 0;
        const assetNames = new Set();
        for (const aurl of mf.assets) {
          const name = uniqueMediaName(mediaNameFor(aurl, "asset", ai++), aurl, assetNames);
          const ok = await fetchAndAdd(entries, mdir + "/assets", aurl, name);
          if (!ok) failures.push("asset: " + aurl + " (module " + moduleId.slice(0, 8) + ")");
        }
        let capturedResources = 0;
        for (const r of mf.resources) {
          const leaf = String(r.url || "").split("/").pop() || "";
          const key = String(r.title || "") + "|" + leaf;
          if (resourceByUrl.has(r.url) || resourceByKey.has(key)) continue;
          resourceByKey.add(key);
          const path = await captureResource(entries, r, courseDir + "/resources", usedResourceNames, failures);
          resourceByUrl.set(r.url, path);
          capturedResources++;
        }
        log("module " + moduleId.slice(0, 8) + ": " + mf.assets.length + " assets, " + capturedResources + " resources");
      };

      // The Resources tab is separate from the outline/page JSON. Its items
      // (standalone lab HTML + the resource-service PKA copies) are signed on
      // click; mainworld.js hands us the URL before the browser downloads it.
      const captureResourceTab = async () => {
        const navLinks = queryAllDeep(document.documentElement, "a.nav-link");
        const resLink = navLinks.find((a) => /^Resources$/i.test((a.textContent || "").trim()));
        if (!resLink) return;
        try {
          resLink.click();
          let buttons = [];
          for (let i = 0; i < 30; i++) {
            await sleep(300);
            buttons = queryAllDeep(document.documentElement, 'button[aria-label^="Download File "]');
            if (buttons.length) break;
          }
          if (!buttons.length) {
            log("Resources tab: no downloadable items");
            return;
          }
          window.postMessage({ __ngbMain: "resourceCapture", on: true }, "*");
          await sleep(300);
          const used = new Set();
          let saved = 0;
          for (const b of buttons) {
            const label = (b.getAttribute("aria-label") || "").replace(/^Download File\s*/i, "").trim() || "resource";
            resourceDownloadQueue.length = 0;
            const wait = nextResourceDownload(15000);
            b.click();
            const d = await wait;
            if (!d || !d.url) {
              log("Resources tab: no signed URL for " + label);
              failures.push("resource tab: " + label + " (no signed URL)");
              continue;
            }
            const r = await bgFetch(d.url);
            const base = sanitizeName(label.replace(/\s*\(pka\)\s*$/i, ""), 80);
            if (!r || !r.ok) {
              // The main-world hook suppressed the browser download, so do
              // not lose the file: ask Chrome to download the signed URL.
              let fext = extFromUrl(d.url, "");
              if (/\(pka\)\s*$/i.test(label) && fext !== ".pka") fext = ".pka";
              const fallbackName = withExt(base, fext || ".bin");
              const fb = await new Promise((resolve) => {
                try { chrome.runtime.sendMessage({ type: "downloadUrlDirect", url: d.url, filename: fallbackName }, resolve); }
                catch (e) { resolve({ ok: false, error: String(e) }); }
              });
              const why = (r && (r.status || r.error)) || "no response";
              if (fb && fb.ok) log("Resources tab: " + label + " -> fetch failed (" + why + "); saved via Downloads fallback");
              else {
                log("Resources tab: " + label + " -> " + why + " (fallback failed: " + ((fb && fb.error) || "?") + ")");
                failures.push("resource tab: " + label + " (" + why + ")");
              }
              continue;
            }
            let ext = extFromUrl(d.url, r.type);
            if (/\(pka\)\s*$/i.test(label) && ext !== ".pka") ext = ".pka";
            let fname = withExt(base, ext || ".bin");
            fname = uniqueMediaName(fname, d.url, used);
            await saveFileEntry(entries, courseDir + "/resources", fname, r.data, false);
            log("Resources tab: " + fname + " (" + r.size + " bytes)");
            saved++;
          }
          log("Resources tab: " + saved + "/" + buttons.length + " files");
        } catch (e) {
          log("Resources tab failed: " + ((e && e.message) || e));
        } finally {
          window.postMessage({ __ngbMain: "resourceCapture", on: false }, "*");
          const contentLink = queryAllDeep(document.documentElement, "a.nav-link")
            .find((a) => /^Content$/i.test((a.textContent || "").trim()));
          if (contentLink) contentLink.click();
          await sleep(1000);
        }
      };

      // ---- walk sections in outline order ----
      const total = groups.reduce((n, g) => n + g.subs.length, 0);
      if (!total) {
        log("Course outline has no sections (still collapsed or not rendered).");
        return;
      }
      const waitForIframe = async (ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const f = activeIframe();
          if (f) return f;
          await sleep(500);
        }
        return null;
      };
      const ASSESS_RE = /\b(exam|quiz|assessment|test|survey|knowledge check)\b/i;
      const visitedModules = new Set();
      let idx = 0;
      let noCourseLogged = false;
      for (const g of groups) {
        for (const sub of g.subs) {
          idx++;
          try {
            // the section button's aria-controls maps to its blocks region: "submodule-<contentModuleId>"
            const clickBtn = subButton(g, sub);
            const ac = clickBtn ? clickBtn.getAttribute("aria-controls") : null;
            const moduleId = ac && /^submodule-/.test(ac) ? ac.replace(/^submodule-/, "") : null;
            if (moduleId && visitedModules.has(moduleId)) {
              log(idx + "/" + total + " " + sub.title + " (already captured)");
              continue;
            }
            if (ASSESS_RE.test(sub.title + " " + g.module)) {
              log(idx + "/" + total + " " + sub.title + " (assessment/exam skipped)");
              continue;
            }
            if (moduleId) {
              // Cinnamon section: mount the player on this content module. Use the module
              // header button (not just the page button): the app rewrites the player URL
              // with this module's moduleNumber + launch key, which the page title/labels
              // expand from. Without it the app keeps the previous module's number.
              const modBtn = moduleButton(g) || clickBtn;
              const beforeMount = readSig();
              if (modBtn) modBtn.click();
              const f = await waitForIframe(15000);
              if (!f) {
                log(idx + "/" + total + " " + sub.title + " (player iframe missing)");
                continue;
              }
              const modNum = g.moduleNumber || baseRoute.moduleNumber;
              if (!baseRoute.courseId) {
                await waitForCourseRoute(15000);
                refreshRoute();
              }
              if (baseRoute.courseId) {
                if (!(await waitForRoute(moduleId, 15000))) {
                  log(idx + "/" + total + " " + sub.title + " (module route did not change; continuing)");
                }
                let pages = [];
                const base = "https://www.netacad.com/authoring-resources/courses/" + baseRoute.courseId + "/" + moduleId + "/" + baseRoute.lang + "/";
                const r = await fetchText(base + "contentObjects.json");
                if (r.ok) {
                  try { pages = contentObjectPages(JSON.parse(r.text), baseRoute.lang); } catch (e) { log("contentObjects.json parse failed: " + (e.message || e)); }
                } else {
                  log("contentObjects.json unavailable (" + r.status + "); capturing the mounted page only");
                }
                if (pages.length) {
                  for (const pg of pages) {
                    const pageLabel = expandTemplate(pg.title, { moduleNumber: modNum }) || pg.id;
                    if (ASSESS_RE.test(pageLabel)) {
                      log(idx + "/" + total + " " + pageLabel + " (assessment/exam skipped)");
                      continue;
                    }
                    const alreadyThere = iframeHasPageId(pg.id);
                    const beforeSig = readSig();
                    if (!gotoPage(moduleId, pg.id, modNum)) {
                      log(idx + "/" + total + " " + pageLabel + " (navigation unavailable)");
                      continue;
                    }
                    if (!(await waitForPage(beforeSig, pg.id, 90000, pageLabel, alreadyThere))) {
                      log(idx + "/" + total + " " + pageLabel + " (navigation timed out; skipped)");
                      failures.push("page: " + pageLabel + " (navigation timeout)");
                      continue;
                    }
                    const c = await saveCurrent(g.module, pageLabel, pg.id, modNum, pageLabel);
                    if (!c) {
                      failures.push("page: " + pageLabel + " (identity mismatch)");
                      continue;
                    }
                    log(idx + "/" + total + " " + pageLabel + " [root=" + (c.root.tagName + "#" + (c.root.id || "")) + ", md=" + c.md.length + "]");
                  }
                } else {
                  const mounted = await waitForPage(beforeMount, null, 20000);
                  if (!mounted) log(idx + "/" + total + " " + sub.title + " (no page list; captured the mounted view)");
                  await saveCurrent(g.module, sub.title, "module:" + moduleId, modNum);
                  log(idx + "/" + total + " " + sub.title);
                }
                await fetchModuleAssets(moduleId);
              } else {
                // No course id: mount the module and capture whatever the player shows.
                if (!noCourseLogged) {
                  log("Could not determine the course id from the player URL; only the visible page per section will be captured.");
                  noCourseLogged = true;
                }
                await waitForPage(beforeMount, null, 20000);
                await saveCurrent(g.module, sub.title, "module:" + moduleId, modNum);
                log(idx + "/" + total + " " + sub.title);
              }
              visitedModules.add(moduleId);
            } else {
              // Assessment/survey titles were already skipped above.
              const beforeSig = readSig();
              if (clickBtn) clickBtn.click();
              const changed = await waitForPage(beforeSig, null, 20000);
              if (!changed) log(idx + "/" + total + " " + sub.title + " (section did not change; capturing current view)");
              await saveCurrent(g.module, sub.title, "native:" + idx, baseRoute.moduleNumber);
              log(idx + "/" + total + " " + sub.title);
            }
          } catch (e) {
            log("section failed: " + ((e && e.message) || e));
          }
        }
      }

      if (!capturedPages.length) {
        log("No lesson pages captured; ZIP not created (see log for navigation failures).");
        return;
      }
      log("Capturing Resources tab...");
      await captureResourceTab();

      // README + manifest
      const readme =
        "# " + courseTitle() + "\n\n" +
        "Source: " + location.href + "\n" +
        "Extracted: " + new Date().toISOString() + "\n" +
        "Pages: " + capturedPages.length + "\n\n" +
        "Layout:\n" +
        "- lessons/<module>/<page>/content.md | content.html | media/*\n" +
        "- modules/<id>/raw/*.json (course data) | modules/<id>/assets/* (all lab/doc assets incl. .pka)\n" +
        "- resources/* (course resource documents)\n";
      if (failures.length) {
        entries.push({ path: courseDir + "/FAILURES.txt", text: failures.join("\n") + "\n" });
      }
      entries.push({ path: courseDir + "/README.md", text: readme });
      entries.push({ path: courseDir + "/manifest.json", text: JSON.stringify({
        course: courseDir, source: location.href, date: new Date().toISOString(),
        pages: capturedPages, failures,
      }, null, 2) });

      log("Packaging " + entries.length + " files...");
      const res = await packageAndSave(entries, courseDir + ".zip");
      if (res && res.ok) log((failures.length ? "DONE (partial)" : "DONE") + ": " + (res.filename || courseDir + ".zip") + " (" + entries.length + " files, via " + (res.via || "?") + "). Check your Downloads folder.");
      else log("ZIP failed: " + (res && res.error));
    } catch (e) {
      log("Course download failed: " + ((e && e.message) || e));
    } finally {
      busy = false;
      if (ui) ui.setBusy(false);
    }
  }
  let busy = false;

  // blob-download capture: when background sees a downloadStarted with a blob:
  // url, ask the main-world shim for the bytes and save them through the SW.
  const capturedBlobUrls = new Set();
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "downloadStarted" || !msg.url) return;
    if (!msg.url.startsWith("blob:")) {
      // Fallback if mainworld's anchor hook did not run (e.g. a non-anchor
      // download): the signed resource URL is still useful to the walker.
      if (/\/s\/[^/]+\/resources\//.test(msg.url)) {
        pushResourceDownload({ url: msg.url, filename: msg.filename || "" });
      }
      return;
    }
    if (capturedBlobUrls.has(msg.url)) return;
    capturedBlobUrls.add(msg.url);
    (async () => {
      try {
        const blob = await getPageBlob(msg.url, 15000);
        if (!blob || !blob.ok) return; // another frame owns the object URL
        const u8 = new Uint8Array(blob.data);
        if (u8.byteLength > 40e6) { log("blob download too large to capture: " + u8.byteLength + " bytes"); return; }
        const rawName = String(msg.filename || "").split(/[\\/]/).pop() || (msg.url.split("/").pop() || "download");
        const dot = rawName.lastIndexOf(".");
        const fname = dot > 0 ? rawName.slice(0, dot) + "-captured" + rawName.slice(dot) : rawName + "-captured";
        const res = await new Promise((resolve) => {
          try { chrome.runtime.sendMessage({ type: "saveAsset", filename: fname, mime: blob.type || msg.mime || "", b64: u8ToB64(u8) }, resolve); }
          catch (e) { resolve({ ok: false, error: String(e) }); }
        });
        if (res && res.ok) log("captured blob download: " + fname + " (" + u8.byteLength + " bytes)");
        else log("blob capture failed: " + ((res && res.error) || "no response"));
      } catch (e) { log("blob capture failed: " + ((e && e.message) || e)); }
    })();
  });

  function closeUI() {
    const host = document.getElementById("__ngbPanelHost");
    if (ui) clearInterval(ui.timer);
    if (host) host.remove();
    ui = null;
  }

  // action button toggles the panel
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ngb-toggle") {
      if (IS_TOP) {
        if (document.getElementById("__ngbPanelHost")) closeUI();
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
    installUnlock(true);
    installPageBridge();
    if (IS_TOP) buildUI();
    // keep unlock alive against re-renders
    // Console debug hook: window.postMessage({__ngb:"extractPdf", b64:"...", seq:N})
    // runs the same extractPdf path used for course PDFs and posts the result back.
    window.addEventListener("message", (e) => {
      if (e.source !== window) return;
      const d = e && e.data;
      if (!d || d.__ngb !== "extractPdf" || typeof d.b64 !== "string") return;
      (async () => {
        const r = await extractPdfViaSW(d.b64, 90000);
        const out = { __ngb: "extractPdfResult", seq: d.seq, ok: r.ok, pages: r.pages, size: r.size, empty: r.empty, error: r.error, head: r.text ? String(r.text).slice(0, 120) : null };
        try { log("debug extractPdf: " + JSON.stringify(out)); } catch (x) {}
        window.postMessage(out, "*");
      })();
    });
    setInterval(() => { try { installUnlock(false); } catch (e) {} }, 3000);
    NG("ready" + (IS_TOP ? " (top frame, UI on)" : " (iframe)"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
