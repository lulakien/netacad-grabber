# NetAcad Course Grabber

**Current build:** `1.0.9` · Manifest V3 · Chrome/Edge 111+ · desktop only.

**At a glance**

- One ZIP per course: ordered Markdown, lesson media, Packet Tracer labs, PDFs
  as text, Resources-tab files, and the course's raw authoring JSON.
- Reads the logged-in course that is open in front of you; no hardcoded course.
- **Use only on content you are entitled to access.** This is a personal-study
  export tool, not a paywall bypass. Nothing is uploaded.
- Verified against 14 free Skills-for-All courses; the remaining free catalog
  courses and paid/instructor-led courses depend on the same player and still
  need manual verification. See [Status](#status-and-coverage).

It writes one ZIP into your Downloads folder. Lesson pages become Markdown;
images, Packet Tracer labs and Resources-tab files stay as files; PDFs get text
extracted; the course's own authoring JSON is included for re-hosting or
diffing. Brightcove video streams are recorded as their `video-id` and poster,
not as protected binaries. Built for the Skills-for-All player at
`www.netacad.com`.

---

## How to use

### Get it

- **Easiest:** download `netacad-grabber.zip` from
  [GitHub Releases](https://github.com/lulakien/netacad-grabber/releases),
  unzip it, and load the folder as an unpacked extension.
- **For contributing:** `git clone
  https://github.com/lulakien/netacad-grabber.git`.

### Install (load unpacked)

1. Put this folder somewhere permanent on your computer.
2. Open `chrome://extensions` (Brave: `brave://extensions`, Edge:
   `edge://extensions`).
3. Turn on **Developer mode** (top-right).
4. **Load unpacked** → select the `netacad-grabber` folder.
5. Reload the NetAcad page you are working on. A small panel appears in the
   bottom-right corner.

> To update the files later: press the ↻ icon on the extension card in
> `chrome://extensions`, then refresh the NetAcad page.

Requirements: you are **logged in** to NetAcad in that browser, and the course
is open in the **curriculum view** (outline on the left, player in the middle).

### The panel

| Button | What it does |
|---|---|
| **Copy text** | Copies the current lesson's full text (Markdown) to the clipboard. |
| **Save this page** | Saves the current page (Markdown + HTML + media + raw JSON) as a small ZIP. |
| **Download full course** | Walks the whole course — every module, lesson and lab page — and saves everything as one ZIP. |
| **×** | Closes the panel (click the extension icon to reopen). |

The status/log line under the buttons shows what is happening, including
per-page diagnostics (`[root=DIV#Wrapper, md=NNNN]`) and any fetch failures.
A full walk of a small course takes a few minutes; the ZIP lands in your
**Downloads** folder as `<Course Title>.zip`.

### What's inside the ZIP

```
Course Title/
├── README.md                 # source URL, date, captured-page list
├── manifest.json             # machine-readable summary
├── lessons/
│   └── <Module>/<Lesson>/
│       ├── content.md        # lesson text (Markdown, media links made local)
│       ├── content.html      # light-DOM markup (see notes)
│       ├── media/            # images / videos / embeds used by the page
│       └── pdf/              # text extracted from PDFs rendered on the page
├── modules/
│   └── <module-id>/
│       ├── raw/              # the course's own JSON: course, blocks, articles,
│       │                     # contentObjects, components, assets (+ config if
│       │                     # your session can read it)
│       └── assets/           # every file the course lists as an asset,
│                             # incl. all Packet Tracer .pka lab files
└── resources/                # course-level resource documents
    ├── <Resource>.md         # PDFs as extracted text (or metadata stub when
    │                         # the file itself is unreachable — see notes)
    └── <Lab>.html / <Lab>.pka # standalone Resources-tab downloads
```

- `.pka` files open in [Cisco Packet Tracer](https://www.netacad.com/packet-tracer) (7.3+).
- Everything stays local: the extension only talks to `netacad.com` and the
  CDNs NetAcad itself uses for media. Nothing is uploaded anywhere.

---

## How it works — the technique, in detail

### 1. The problem: a player built out of nested shadow roots

The NetAcad player does not put lesson content in the normal DOM. The
hierarchy (top page → player iframe) looks like this:

```
body
└─ APP-ROOT            (custom element)
   └─ [shadow root]
      └─ DIV#Wrapper
         └─ PAGE-VIEW  (custom element)
            └─ [shadow root]
               └─ div.page.contentobject
                  └─ div.page__inner
                     └─ div.article__container
                        └─ ARTICLE-VIEW
                           └─ [shadow root]
                              … (article blocks)
                                 └─ BLOCK-VIEW → [shadow root] → div.block
                                    └─ BASE-VIEW → [shadow root] → real content
```

Every level is a **custom element with its own closed-ish shadow root**.
Consequences:

- `document.querySelector("article")` sees nothing.
- "Save as HTML" / the browser's own DOM serialisation gives you an empty
  shell — the shadow trees are not part of the light-DOM save.
- Selecting text with the mouse often "works" visually, but the site's
  `selectstart`/`copy`/`contextmenu` listeners abort the copy, and many pages
  additionally set `user-select: none`.

**The fix is a shadow-aware walk.** `shadowText(el)` iterates `element.children`
*and* `element.shadowRoot.children` recursively (with a size cap), so text from
every nesting level is collected. `findContentRoot()` then scores every
candidate container in that walked tree (`#Wrapper`, `<main>`,
`[role=main]`, `PAGE-VIEW`, `BASE-VIEW`, …) and picks the one that is
largest-yet-relevant, which reliably lands on `DIV#Wrapper` — the top of the
lesson's own shadow tree. Everything downstream (Markdown, HTML, media
detection) runs on that root, so one walker handles every page type: text
lessons, video lessons, Packet Tracer lab pages, surveys, exam start pages.

### 2. Copy-unlock

`installUnlock()` runs periodically and:

- injects a `<style>` forcing `user-select: text !important` on everything;
- clears inline `oncopy`/`onselectstart`/… attributes the site sets directly.

The site's own `contextmenu` / `copy` / `selectstart` / `dragstart` listeners
are wrapped to no-ops by `mainworld.js`, which is declared with
`"world": "MAIN"` and runs at `document_start`. A normal content script lives
in an isolated world, so patching `EventTarget.prototype` there would not
touch the page's listeners.

Together with the shadow-aware extraction this makes both *manual* copying and
the extension's own capture work on pages that would otherwise be copy-locked.

### 3. Navigating the player: hash routing and the stale-`src` trap

The player is a single-page app. A lesson address is a **hash route** in the
iframe's URL:

```
https://www.netacad.com/authoring-resources/index.html?xAPILaunchKey=…
  &xAPILaunchService=https://www.netacad.com/adl/content/
  &lang=en-US&moduleNumber=2
  #/courses/<courseId>/<moduleId>/id/<pageId>
```

The extension walks the course by writing `location.replace(<url>)` into the
player's `contentWindow` (same-origin, so it has full access). Two subtleties:

- **The iframe `src` attribute goes stale** after in-iframe navigation. Always
  read `iframe.contentWindow.location.href` (the *live* document URL) and
  build the next URL from that — never from `iframe.src`.
- **`moduleNumber` is part of the query string**, and the app expands labels
  from it (`{{moduleNumber}}.2.1 …`). When moving to a page of module *N*, the
  new URL must carry `moduleNumber=N`, or the app renders the wrong labels
  (module-2 pages showing "1.x").
- **Module headers** (the big expandable buttons in the outline) are the
  reliable mount point: clicking the *module header* button mounts the module;
  page buttons are only valid for an already-mounted module. The walk mounts
  each module, then visits each of its pages.

### 4. Knowing when a page has "settled"

After each navigation the extension must wait until the *new* page has
actually rendered before capturing. It uses a **content signature**:

```
signature = hash(first 6000 chars of the shadow-walked text)
          + hash(last 2000 chars)
          + hash(live document URL)
```

polled every ~1.2 s. The page is considered settled when the signature is
**stable across two consecutive polls and different from the pre-navigation
signature** (or, if the target page is confirmed by its URL, identical to it —
i.e. "already there"). The URL in the signature matters: two long pages can
share a long common header, and capping text length alone makes their
signatures collide, which would make the wait logic think the page never
changed.

### 5. Harvesting the authoring manifests

Besides what is rendered, the course publishes its own source data under a
public JSON path:

```
https://www.netacad.com/authoring-resources/courses/<courseId>/<moduleId>/<lang>/
├── course.json         # title, menu, _resources (documents/links/media)
├── assets.json         # list of asset paths (images, .pka files, videos)
├── contentObjects.json # pages
├── blocks.json / articles.json / components.json
└── config.json         # cookie-gated (only fetched when the session allows)
```

The extension downloads all of these for every module into `modules/<id>/raw/`
(this is the authoritative course data — useful for re-hosting or diffing),
and expands `assets.json` + `_resources` into concrete fetches. `_resources`
entries carry `title` / `description` / `_type`, which is how a resource like
a lab worksheet becomes a properly named file in the ZIP.

### 6. PDFs: copying what's on screen

PDFs need a different route because of two Chrome facts:

- **Chrome's built-in PDF viewer exposes no DOM text layer.** The viewer UI is
  out-of-process; a same-origin `iframe[src=…pdf].contentDocument` is
  essentially empty (verified: `body` has no children, no `.textLayer`).
  There is nothing to "copy from screen" via the DOM.
- The site's CDN **refuses raw `.pdf` objects** in the course asset prefix
  with a canned 403 (other extensions in the same folder are public), so even
  fetching the bytes can fail for some courses.

So the extension gets PDF *information* by **parsing the document itself**:

1. Wherever a PDF is reachable (a course resource the session can fetch, or a
   PDF rendered inside the player), the bytes are fetched **in the page
   context** (session cookies included).
2. The bytes travel to the service worker as base64 (size-capped to stay under
   Chrome's 64 MiB message limit).
3. The SW runs **pdf.js 3.11.174** (the last UMD release) and extracts
   `getTextContent()` for every page.
4. The text is written to `<name>.md` with a metadata header (title,
   description, source URL, page count). Scanned PDFs with no text layer keep
   their raw file alongside a note; PDFs that return 403 become a metadata
   stub so the resource is never silently lost.

**pdf.js inside an MV3 service worker** has one non-obvious requirement: a
service worker has **neither `Worker` nor `document`**, so pdf.js's normal
"spawn a worker, else `loadScript()` a fallback" cannot work. The fix (and
why the file layout is `pdf/pdf.worker.min.js` + `pdf/pdf.min.js`):
`importScripts()` the **worker first**, which registers
`globalThis.pdfjsWorker.WorkerMessageHandler`; pdf.js then detects it and runs
an in-thread "fake worker". `workerSrc` is set as belt-and-braces.

### 7. Packaging: ZIP in the page, download without a server

- **fflate** (in-page) zips the collected entries — no local server, no
  extension page round-trips for the data itself.
- The primary download path is a **temporary `<a download>` with a blob URL,
  clicked in the page** — no message-size limits at all. The service worker
  (`chrome.downloads.download` via a data: URL) is the fallback for the rare
  case where the page anchor is unavailable.
- The **Resources tab** is captured separately: its download buttons sign a
  CloudFront URL and click a hidden `<a download>`. `mainworld.js` intercepts
  that click, returns the signed URL to the content script, and the bytes are
  fetched through the service worker into `resources/`. This adds the
  standalone lab HTML and the resource-service PKA copies that are not in
  `assets.json`.
- The content script also watches `chrome.downloads.onCreated` broadcasts so
  a site-triggered blob download can be captured (`*-captured`) and so a
  resources-tab click still works if the main-world hook is unavailable.

### 8. What is deliberately out of scope

- **Assessments and question banks.** Sections whose title matches
  exam/quiz/test/assessment/survey are listed in the log and **not clicked**,
  so a walk cannot consume an attempt or open an exam. The locked final-exam
  page is not part of the content player.
- **Brightcove-hosted videos.** The free courses use Brightcove players whose
  media loads only after Play, behind a deactivated/protected player. The ZIP
  keeps the video title, poster image, Brightcove `video-id` reference, and the
  full `components.json` (account/player/video IDs), but not the video binary.
- **Live streams** without a direct file URL are kept as embed references.
- `.pka` files are captured; the Packet Tracer application itself is not.

---

## Output contract (for downstream agents)

The ZIP is ordered, not alphabetical:

- `course.md` is the printable whole-course Markdown. It has a YAML title/source
  header, one `##` per module and one `###` per page in course order. Image and
  PDF links are rewritten to ZIP-root-relative paths.
- `manifest.json` (`schema: "netacad-grabber/2"`) is the machine-readable index.
  `modules[]` and `modules[].pages[]` carry explicit `order` integers, the
  original page/module IDs where available, the sanitised folder names, and
  `markdown` / `html` / `media` / `pdfs` paths.
- Use `manifest` paths rather than sorting folders: names are sanitised, length-
  capped and may have collision suffixes.
- `lessons/<module>/<page>/content.md` is the per-lesson source;
  `modules/<id>/raw/` is the authoritative authoring JSON; `resources/` holds
  course-level files and extracted PDF text; `FAILURES.txt` lists anything the
  server refused.

A full-course PDF can be produced without guessing order:

```bash
unzip Course.zip -d course
pandoc "course/<Course Title>/course.md" \
  -o course.pdf \
  --resource-path="course/<Course Title>" \
  --pdf-engine=weasyprint
```

For a module-only PDF, concatenate the `markdown` paths of one
`manifest.modules[]` entry in `pages[].order`; for a single lesson, render that
page's `content.md` directly. `content.html` is only a light-DOM snapshot and
is not the print source.

## Status and coverage

Verified end-to-end against **14 free Skills-for-All courses** (Getting Started
with Packet Tracer, Ethical Hacker, Endpoint Security, Networking Basics,
Introduction to Modern AI, Data Science Essentials with Python, Data Analytics
Essentials, Introduction to Data Science, Find Insights with AI, Python
Essentials 1/2, JavaScript Essentials 1/2, C++ Essentials 1). For each ZIP,
page and asset counts were compared with the course's own `contentObjects.json`
and `assets.json`; all lesson text was checked for renderer noise.

Not yet covered:

- the remaining free catalog courses;
- paid/instructor-led courses — likely the same player, but unverified;
- DRM/SCORM/external-LMS content, which may not expose readable pages.

Server-side `403` resources are reported, not bypassed. There is no committed
automated test suite yet; the Playwright harnesses live outside this repo.

## Notes & limitations

- **`content.md` is the rendered full-text artifact.** `content.html` captures
  the light DOM only (shadow trees don't serialise through the browser's
  save-as-HTML), so it is a secondary artifact. A few components render a
  collapsed preview (the visible text ends in `…`); the untruncated authoring
  HTML for those is in `modules/*/raw/components.json` / `articles.json`.
  For reading or re-hosting, use `content.md` and the raw JSON.
- **Server-gated files:** some resources (e.g. certain PDFs) return HTTP 403
  to everyone — including the logged-in app's own UI, which simply doesn't
  list them. The extension records those as metadata stubs in `resources/`
  rather than dropping them; everything else is captured.
- **Partial runs are labeled.** Any page/asset/media/resource that could not
  be captured is listed in `FAILURES.txt` at the ZIP root and in
  `manifest.json` (`failures`), and the final log says `DONE (partial)`. A
  run with no captured lesson pages does not produce a ZIP.
- **Videos** are downloaded when the page references a file (`.mp4`/`.m3u8`).
  The current free courses use Brightcove; those are recorded as their
  `video-id` and poster in `content.md`, with the full player metadata in
  `components.json`, but the protected stream itself is not downloaded.
- **Resources tab:** standalone lab HTML and the resource-service `.pka` copies
  are fetched through their signed URLs and placed in `resources/`. The module
  `assets/` directory still contains the asset-service copies; both are kept
  because they can differ.
- **Nothing is uploaded anywhere**; the extension only talks to `netacad.com`
  (and the CDNs NetAcad uses for media).
- **Debug hook:** in the DevTools console of any NetAcad page,
  `window.postMessage({__ngb:"extractPdf", b64:"<base64 of a pdf>", seq:1})`
  runs the same PDF text-extraction path the course download uses and posts
  back `{__ngb:"extractPdfResult", seq:1, ok, pages, empty, error, head}` —
  handy for checking the PDF machinery without downloading a whole course.
- Update flow: change a file → ↻ reload the extension in `chrome://extensions`
  → refresh the NetAcad page. (Chrome caches load-unpacked content scripts in
  its code cache; the version stamp `data-ngb-cs` on `<html>` shows which
  build is actually running if a refresh ever looks stale.)

## Troubleshooting

- **No panel:** confirm Developer mode is on, reload the extension card, then
  hard-refresh the NetAcad page. Check `<html data-ngb-cs="1.0.9">` in DevTools.
- **“No course outline found”:** open the course's **Content / Curriculum**
  view and wait for the outline to render before clicking the button.
- **`DONE (partial)`:** open `FAILURES.txt`; usually a server-side `403` or an
  external link, not a missing local file.
- **ZIP not in Downloads:** the page-anchor path may be blocked by browser
  policy; check the panel log and the Downloads folder. ZIPs over ~36 MB only
  use the anchor path because of Chrome's message limit.
- **PDF text missing:** the PDF may be scanned or server-gated. Scanned files
  are kept raw next to the `.md`; gated files become stubs.
- **Chrome/Edge older than 111:** `world: "MAIN"` scripts are unsupported.
- **Course walk skips items:** assessments/quizzes/tests/surveys and hidden
  Packet Tracer launcher shells are intentionally skipped.

## Contributing

Issues and PRs are welcome. This project deliberately has **no build step**:
edit the plain content scripts/service worker, reload unpacked, and test on a
free course.

Please:

- keep it client-side and local — no uploads, analytics, or external servers;
- do not add authentication/licensing bypasses;
- update `CS_VERSION` and `manifest.json` when changing injected code;
- include a course name, panel log, and `FAILURES.txt` excerpt for bug reports;
- keep third-party licenses intact (`fflate`, `pdf.js`).

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the short checklist.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3; requires Chrome/Edge 111+ for `world: "MAIN"`). |
| `background.js` | Service worker: pdf.js text extraction, download triggering, asset fetching proxy, download-event broadcast. |
| `mainworld.js` | Page-world shim: copy-guard neutraliser, object-URL tracker, Resources-tab download interceptor. |
| `content.js` | All the page work: shadow-aware extraction, settle detection, course walk, Resources/PDF capture, ZIP packaging. |
| `zip/fflate.min.js` | [fflate](https://github.com/feross/fflate) — in-page ZIP compression. |
| `pdf/pdf.min.js`, `pdf/pdf.worker.min.js` | [pdf.js 3.11.174](https://github.com/mozilla/pdf.js) (last UMD release) — text extraction of PDFs, run as an in-thread fake worker in the service worker. |

## License

The original extension code is MIT-licensed; see [`LICENSE`](LICENSE).
`fflate` and `pdf.js` keep their own licenses. Cisco, NetAcad and Packet Tracer
are trademarks of Cisco Inc.; this project is not affiliated with Cisco.

## Credits & licenses

- [fflate](https://github.com/feross/fflate) — MIT
- [pdf.js](https://github.com/mozilla/pdf.js) — Apache-2.0 (Mozilla Foundation)
- Built for personal use with Cisco Networking Academy course material.
  Cisco, NetAcad and Packet Tracer are trademarks of Cisco Inc.
