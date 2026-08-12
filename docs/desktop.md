# The desktop application

The viewer, packaged as an installable application for macOS and Linux.

> **Windows builds are temporarily suspended.** The Windows leg of the release workflow is disabled,
> so recent releases carry no `.exe`. The rows and the SmartScreen instructions below are kept
> because the target still builds — `npx electron-builder --win` works from a clone — and because
> they come back with the leg. On Windows in the meantime, use the standalone HTML page attached to
> each release, or the website; both are the same viewer.

**It is a delivery channel, not a second feature set.** It is the same bundle the website serves,
running the same reader over the same files, and it opens exactly what the web app opens — no more.
If you can reach <https://js2264.github.io/metacooler.js/>, you do not need this: the web app is
complete on its own and requires no installation. This exists for machines that cannot reach it, or
for people who would rather have an icon than a bookmark.

---

## What to download

Artifacts are attached to each [release](https://github.com/js2264/metacooler.js/releases), named
`metacooler-viewer-<version>-<os>-<arch>.<ext>`. They are built by CI from the release's own tag
when the release is created, so what you download is what that tag builds — not something uploaded
by hand from somebody's laptop.

| Platform | File | Notes |
|---|---|---|
| macOS, Apple Silicon | `…-mac-arm64.dmg` | or the `.zip`, if you would rather not mount a disk image |
| macOS, Intel | `…-mac-x64.dmg` | |
| Windows | `…-win-x64.exe` | **not currently built** — see the note at the top |
| Linux | `…-linux-x64.AppImage` | one file, `chmod +x` it and run it |
| Linux (Debian, Ubuntu) | `…-linux-x64.deb` | |

There is **no auto-update**. A new version is a new download, and the app will never contact a
server to ask whether it is current — which is the same constraint the web app is built under (spec
§1, C1).

---

## The two warnings, and how to get past them

**These builds are unsigned.** Each platform says so, once, the first time you open the app.
Neither message means the app is broken or that anything is wrong with the file you downloaded: a
code signature says *who published a build*, not *whether it works*. Signing requires a paid
developer account with Apple and a certificate authority for Windows, and neither is in place.

### macOS

> **"metacooler-viewer" cannot be opened because the developer cannot be verified.**

Either:

- **right-click** (or Control-click) the app in Applications and choose **Open**, then **Open**
  again in the dialog that follows. Double-clicking will not offer this; the right-click menu is
  what does. You only have to do it once.
- or, in a terminal:

  ```bash
  xattr -d com.apple.quarantine /Applications/metacooler-viewer.app
  ```

### Windows

> **Windows protected your PC** — Microsoft Defender SmartScreen prevented an unrecognised app from
> starting.

Click **More info**, then **Run anyway**.

---

## Remote files

Remote files work exactly as they do on the website — a `HEAD`, then bounded range `GET`s — with one
difference worth knowing about before you point the app at your own bucket.

**The app sends `Origin: app://viewer`.** A host whose CORS configuration allows the Pages site *by
hostname* will therefore refuse the desktop app while the website keeps working, and the error will
be a CORS failure that mentions an origin you have never configured. The fix is the one
[docs/hosting.md](hosting.md) already recommends: `Access-Control-Allow-Origin: *`, which works for
both. If you must keep an allow-list, add `app://viewer` to it.

Nothing else about remote reading changes. The requirements in `docs/hosting.md` — `Accept-Ranges:
bytes`, `GET` and `HEAD` allowed, the `Range` request header allowed, `Content-Length` and
`Content-Range` exposed — are the same requirements, and a host that fails one of them fails it in
both targets.

### The one thing it does fix: hosts that compress

A host that serves `.metacool` files with `Content-Encoding: gzip` cannot be read by the web app at
all. The viewer refuses such a file on purpose — byte ranges would address the compressed stream
rather than the file — and the web app has no way out, because `Accept-Encoding` is a *forbidden
header name*: no page may set it, with `fetch` or with `XMLHttpRequest`. **GitHub Pages is such a
host.**

The desktop build asks for `Accept-Encoding: identity` from outside the page, where that restriction
does not apply, so the same file on the same host opens here and is refused on the website.

This is a host-compatibility difference and not a second feature set: the file formats, the views
and the operations are identical in both targets. It is worth stating precisely, though, because it
is the one case where "it works in the app but not in the browser" is the expected answer rather
than a bug.

### What it does *not* fix

It would be easy to read "desktop app" as "no more remote-file problems". It is not, and the list is
worth being precise about, because the alternative is not believing the error messages:

- **A host that does not serve ranges** still cannot be read. No client-side setting can make a
  server produce partial content.
- **A presigned URL that answers `403` to `HEAD`** still fails. Presigned URLs are signed for one
  method; the reader needs two.
- **DNS and TLS failures** are unchanged.
- **A CORS policy that names hostnames** is, as above, *more* likely to bite here, not less.
- **Ranged reads were never slowed by compression in either target.** Chromium already asks for
  `identity` on any request carrying a `Range` header, so there was nothing there to fix.

---

## Local files

Identical to the web app, and identically private. A file you open is read in place, a few kilobytes
at a time, by code running on your own computer. It is not uploaded, not copied, and not indexed;
there is no server to send it to. Quit the app and nothing remains.

The application never writes to a file you open. Exports — PNG and PDF — are new files, saved where
you choose.

---

## What it deliberately does not do

Each of these is a decision, with its reason:

- **No auto-update.** An update service is a server, and there is no server (spec §1, C1). It would
  also be the one component able to change what runs on your machine without you asking.
- **No file associations, no "Open Recent", no reopening the last file on launch.** All three need
  the app to remember a *path*, and the version that would have made them cheap — routing file
  bytes through the packaged app instead of reading the dropped file directly — measured ~15× slower
  per read, which is exactly what HDF5's many-small-reads metadata walk punishes. Reading a file the
  fast way was worth more than reopening it automatically.
- **No bundled Python, no bundled CLI.** The viewer reads files; it does not create them. Bundling
  `metacooler` would be shipping a second program with its own update story.
- **No `⌘R` / reload, and no page zoom.** Reload discards the open file, which cannot be re-read
  without you dropping it again, and it sits next to `⌘T`. Page zoom changes the canvas's CSS size,
  so the same "300 dpi" export would produce a different pixel count at 125 %.
- **No writing of any kind, in either target** (spec §13).

---

## Building it yourself

```bash
npm ci
npm run dist:desktop
```

Installers land in `release/`. `npm run start:desktop` builds and launches without packaging, which
is the faster loop while working on it.

The desktop build is a **second invocation of the same bundler over the same source**
(`vite.desktop.config.ts` spreads `vite.config.ts` and overrides five keys), never a change to the
first — so the web build cannot regress because of something done for the desktop one. See
[docs/deploy.md](deploy.md#the-base-path-is-decided-at-build-time) for how the two differ, and
[SPECS §15](../SPECS.md#15-desktop-target) for what the packaged app is allowed to do.
