# NebulaDisk Cloud Drive · SiYuan Plugin

Bring your [NebulaDisk](https://github.com/) cloud drive into SiYuan. No more switching between
the browser and your notes: the sidebar *is* the file tree, one click previews or edits a file,
and you can **embed a whole folder or a single file directly into your notes**.

> This plugin only adds files. It **does not modify** SiYuan or NebulaDisk source code.

> Chinese documentation: [README.zh_CN.md](README.zh_CN.md) — it is more detailed and is the
> primary document. This file is a short English overview.

---

## Features

### ① Browse the drive from the sidebar

A **NebulaDisk** dock panel in SiYuan's left sidebar:

- Switch between all mounts configured in NebulaDisk
- Lazily-loaded tree — children are fetched only when expanded
- Name filter box
- Right-click menu: **new folder / rename / delete / download / copy path / copy direct link /
  insert into current doc / embed into doc**
- Expansion state is remembered across refreshes
- Read-only mounts are labelled up front

### ② Preview and edit online

Files are routed to the best engine automatically:

| Type | Handling |
|---|---|
| Images / video / audio | Rendered natively by the browser — zero conversion, video seeking works |
| Text / code / config | Native rendering with light highlighting; encoding auto-detected |
| Office (docx/xlsx/pptx…) | **OnlyOffice online editing** — edits are saved back to the drive |
| CAD (dwg/dxf) | cad-viewer |
| PDF / archives / others | kkFileView |

Whether an Office file opens in edit or read-only mode is decided by the **write permission of
the mount**, and the UI says so explicitly.

### "Open in browser" picks a *rendering* channel, not a byte channel

The preview toolbar (and the tree context menu) has an **Open in browser** button. It routes by
type so you always see the *content* instead of a download prompt:

| Type | What it opens | Why |
|---|---|---|
| PDF / image / video / audio / text | signed direct link | the browser renders these natively — fastest, zero conversion |
| Office / archive / other | kkFileView preview page | the browser has **no** Office renderer, so a direct link would download |
| CAD | cad-viewer deep link | same reason; handed to a dedicated 3D viewer |

> Sending everything to the direct link does not work: the browser only natively renders a few
> MIME types. For Office/CAD the server has always sent `Content-Disposition: inline` — the
> file still downloads, because there is no renderer to hand it to.

### ③ Seamless embedding into notes

Both forms use a **custom block**. There are two kinds of embed:

> ★ **The fence must be `;;;` (three semicolons) — NOT backticks** ★
> Inside SiYuan, ` ```nebuladisk ` produces a **plain code block** (`type=c`); the custom-block
> renderer is never invoked and the note just shows raw JSON. Use:
>
> ```text
> ;;;siyuan-nebuladisk/nebuladisk
> {"kind":"tree", ...}
> ;;;
> ```
>
> The fence must also start at **column 0** — any leading space or character breaks it
> (`[;;;siyuan-…` degrades to a normal paragraph). Easiest path: use one of the insert entry
> points below and the plugin writes the correct syntax for you.

**a) Directory embed (interactive browser)** — an interactive drive folder in the note body:

```text
;;;siyuan-nebuladisk/nebuladisk
{"kind":"tree","mount":"售前项目","path":"2026/某项目"}
;;;
```

Like any embed, this renders a one-line description plus a "点击预览 / Click to preview" button
until clicked; once loaded it becomes a drill-down list — folders expand level by level, and a
file opens in a tab.

**b) File embed** — a file's content inline in the note:

```text
;;;siyuan-nebuladisk/nebuladisk
{"kind":"file","mount":"项目设计","path":"图纸/A-01.dwg","name":"A-01.dwg"}
;;;
```

Insert it via the `/` slash menu, by **dragging a file/folder from the sidebar tree into the
note**, the file tree context menu, or the viewer toolbar. When dragging, the target block is
outlined and labelled so you can see exactly where the embed will land.

#### When do embedded blocks load? (performance strategy)

An embedded block hosts a real preview page (kkFileView / OnlyOffice) — these are heavy. A note
with a dozen embeds would bog down the machine if they all loaded at once, so loading is
**lazy, in three layers**:

| Layer | Rule | Effect |
|---|---|---|
| 1 | Nothing loads when the note opens — just a "点击预览 / Click to preview" button | **Zero** backend requests on note open |
| 2 | Loads only on click, and **you may keep as many expanded as you like — they don't interfere** | Memory scales with **how many you opened**, nothing else |
| 3 | "收起 / Collapse" destroys the iframe (not just hides it) and revokes the OnlyOffice blob | Immediate manual release |

So **the number of embeds does not affect how fast a note opens** — zero requests on open,
just placeholder buttons. Memory, however, depends on **how many you expanded**: nothing is
collapsed behind your back (that keeps document-and-spreadsheet side-by-side comparison
workable), so collapse each one when you're done with it.

---

## Installation

Copy the `siyuan-nebuladisk` folder into your SiYuan workspace:

```
<workspace>/data/plugins/siyuan-nebuladisk/
```

Restart SiYuan, then enable it under **Settings → Marketplace → Downloaded**.

For Docker-deployed SiYuan, the path inside the container is typically
`/vol1/1000/SiyuanDisk/data/plugins/`, then `docker restart <container>`.

---

## Networking: direct connection only

SiYuan (`:6806`) and NebulaDisk (`:8089`) are different origins. NebulaDisk serves the API with
permissive CORS (`allow_origins=["*"]`, `allow_credentials=False`) and hands out a **Bearer token**
at `POST /api/login`, so the plugin talks to it **directly**:

```
plugin (renderer) ──fetch──────────────────────────► NebulaDisk :8089
                   Authorization: Bearer <token>
```

No local forwarder, no port, no second process — nothing that can be down while the drive is up.

> **Removed in 2026-09-30**: an earlier version ran a tiny HTTP forwarder on `127.0.0.1:6810`
> (`src/proxy.js`) to work around the drive having no CORS headers. It kept the session cookie,
> enforced a path allow-list, and rewrote preview HTML asset URLs. It was removed because the
> direct channel is sufficient, and because its *startup status* had been (incorrectly) used as
> the "channel ready" signal — so embedded file blocks refused to render with
> "proxy not started" even when direct requests worked fine. See `git log` for `src/proxy.js`.

Cross-origin caveats that still apply:

- The session is a **Bearer token stored in `sessionStorage`**, not a cookie (the drive's cookie is
  `SameSite=lax` and is never sent cross-site anyway).
- Preview URLs are signature-based (`/api/raw/...?exp=…&sig=…`), so `<img>`/`<video>`/`<a download>`
  work without cookies, and support HTTP Range (seekable video).
- URLs returned by the drive may use a **container-internal hostname** (e.g. `nebula:8088`);
  `browserReachableUrl()` rewrites the host to the configured `serverUrl`.

---

## Limitations

| Item | Status | Why |
|---|---|---|
| Editing embedded content | Not supported | Embeds are read-only views; notes store only the pointer |
| Deep-linking to a folder in the drive UI | Partial | NebulaDisk's UI is an SPA with no folder-level deep link; the plugin draws its own folder browser instead |
| Mobile | Not adapted | No `addDock` on mobile |
| Offline | Not supported | Requires a live drive service |
| Reading the framed page's DOM | Impossible | Cross-origin |

---

## Development

> For **architecture decisions, root causes of every real bug, and environment traps**, see
> **[DEVELOPMENT.md](DEVELOPMENT.md)**. This file only covers usage.

```bash
node test/syntax.check.js   # syntax + import targets + export matching + manifest
node test/embed.test.js     # embed block parsing
node test/e2e.test.js       # end-to-end against a mock drive (direct channel)
node tools/run-all-tests.cjs  # everything (incl. reverse-injection tests)
npm test                    # the core three
```

The static check cross-references every `import { X } from "./y.js"` against what `y.js`
actually exports. This catches a class of bug that `node --check`, unit tests, and manual
clicking all miss: **errors that only surface on the call path**.

---

## License

Matches the NebulaDisk project.
