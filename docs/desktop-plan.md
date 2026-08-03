# Shipping the viewer as a desktop application — implementation plan

This is a plan, not a description: nothing below is implemented yet. It exists so the work can be
picked up in a fresh session without re-deciding anything, and so the decisions that were made by
*measurement* rather than by preference are not quietly reversed by someone who reads only the code.

The target is an installable desktop application built with **Electron**, wrapping the existing
bundle unchanged. Scope is the viewer alone — no Python, no bundled CLI. The first releases are
**unsigned**, with the signing hooks present but inert.

The binding constraint on all of it: **the GitHub Pages web build keeps working, byte-for-byte
equivalent in behaviour.** The desktop build is a second invocation of the same bundler over the
same source, never a change to the first. `.github/workflows/deploy.yml` is not edited at any point
in this plan, which is the concrete form that guarantee takes.

> **Note on `docs/desktop.md`.** Step 16 writes that file as the *user-facing* document — artifact
> names, the two OS warnings and their fixes, what the build deliberately does not do. This file is
> the implementation plan and can be deleted once the work has landed.

---

## How this plan was produced

Five readers mapped the codebase (bootstrap and loading, the I/O layer, UI hooks, build and release
machinery, house style) and returned 134 findings. Three independent designs were then drafted from
three different priorities — minimal diff, native feel, hardened security — and a judge pass picked a
winner, grafted the best parts of the other two, and checked the plausible-sounding claims against
the actual files, the actual `electron-builder@26.15.3` schema, and in several cases against a
running measurement.

**Design 1 (minimal diff) wins as the base.** It is the only one whose "the web build cannot
regress" claim is verifiable by reading the diff: `vite.config.ts` gains two `define` lines with
web-neutral values, and `vite.desktop.config.ts` spreads that object and overrides five keys. It
lands 2–3 files in `src/` against Design 2's ~12. Security hardening is grafted wholesale from
Design 3; one capability (preload + native menu + an About dialog that can name the build) is
grafted from Design 2, deliberately scheduled *after* the app is launchable so it cannot delay first
light.

---

## Two things were rejected, and why

**Rejected: routing local file bytes through a `metacool-file://` protocol handler.** This was
Design 2's headline feature, justified by a benchmark that did not reproduce. Design 2 claimed
0.58 ms per 64 KiB synchronous read; the judge measured **6.52 ms** warm, with a **~3 ms fixed
floor** still visible at 4 KiB, against **0.42 ms** for the existing `FileReaderSync`-over-Blob
path. That is ~15× slower on the byte path, and the fixed floor is an IPC round trip, not a transfer
cost — which is exactly what HDF5's many-small-reads metadata walk punishes. What the scheme
actually buys is *addressing* (Open Recent, file associations, reload-survives-a-drop), and
addressing needs the path only as a **string**. If those features are ever wanted, capture the path
for addressing and leave the bytes on the Blob.

**Rejected for v1: injecting `Access-Control-Allow-Origin` to "fix CORS".** Response headers cannot
make a server produce partial content, so `remote-no-ranges`, the presigned-URL HEAD-403 case and
DNS/TLS failures are all untouched by it. Meanwhile the worker's `?edges=` sidecar fetch takes an
arbitrary user-supplied URL and renders the result, so a blanket ACAO injection turns it into a
read-anything primitive. The genuine, *measured* desktop-only win is a **request** header instead —
see step 19. Write the release notes against the list of what is and is not fixed, never against
"CORS is gone".

---

## Facts established by measurement

Each of these was checked rather than assumed, and each one silently breaks something if reversed.

| Fact | Consequence |
|---|---|
| Sync XHR in a **renderer worker** is fine and has no deprecation path | The Chromium deprecation only ever covered sync XHR on the document thread during page dismissal. `RemoteRangeSource` needs no rewrite. |
| The hash router survives a custom scheme **only** with `standard: true` | Without it the origin is opaque and `ViewState.writeHash` throws `SecurityError` with no handler above it. |
| `'wasm-unsafe-eval'` in the CSP is load-bearing | Verified both ways: with it, wasm instantiates in document and worker; without it both fail with `CompileError`. |
| A CSP delivered as a **response header** reaches the module worker; a `<meta>` tag does not | And a meta tag cannot express `frame-ancestors` at all. |
| The CSP does **not** need `'unsafe-inline'` for styles | There is no `innerHTML`, no `<style>` creation and no `style=` in `src/`; `el()` assigns via CSSOM, which CSP does not govern. |
| `https://js2264.github.io/metacooler.js/demo/` answers **301** to `jserizay.com` with **no** `Access-Control-Allow-Origin` on the redirect | The fetch is blocked before the redirect is followed. Defaulting the demo base to `pkg.homepage` ships a picker where every example errors. |
| `mac.identity: '-'` is ad-hoc signing; `null` skips signing entirely | Apple Silicon refuses to execute an unsigned arm64 binary, so the `null` recipe builds, installs, and never launches. |
| `win.signExecutable: false` is the right key | `signAndEditExecutable: false` also disables resedit, losing the icon and version metadata. |
| `net.fetch` **throws** `ERR_FILE_NOT_FOUND` rather than returning `!ok` | A try/catch is needed either way, so `fs.readFile` — asar-safe, keeps every response header ours — is the better primitive. |
| `?edges=` **is** reachable in the desktop build | `location.search` survives `loadURL`. Design 1 was wrong that it was unreachable. |
| A dedicated worker has no `window` under any configuration | So `isNodeRuntime()` is decided in the reader worker entirely by whether `process` exists — verified absent under `sandbox:true` + `nodeIntegrationInWorker:false`. |

Pin the Electron version only. Do not restate its Node or Chromium micro-versions anywhere; they
move within a major. Read them at runtime from `process.versions`.

---

## Phase A — reach a launchable, installable app

### 1. Amend `SPECS.md` and `CHANGELOG.md` first

One `docs(spec):` commit, before any code, so new files have a section to cite.

`SPECS.md:3-4` opening line becomes: *"A viewer for `.metacool` files, in a browser and as an
optional desktop application. No backend, no preprocessing, no additions to the metacooler API.
Nothing has to be installed to use it: the web app is complete on its own, and the desktop build is
the same bundle packaged for machines that cannot reach it — it adds a distribution channel, never a
requirement."* Title unchanged.

§1 table, two cells only: C1's consequence gains `, no update service`; C5's becomes *"Public files
are objects on a bucket; private files never leave the machine. The desktop build changes only where
the *app* comes from, never where the data comes from."*

§13 gains: *"; write access of any kind, in either target; an auto-update service; and a desktop
build that can open anything the web build cannot — the package is a delivery mechanism, not a
second feature set."*

Add §15 "Desktop target" (~30 lines): the frozen origin `app://viewer` and that five preferences are
keyed on it; renderer served by a privileged standard/secure scheme, never `file://`;
`contextIsolation`/`sandbox` on and both `nodeIntegration` flags off, naming the `isNodeRuntime()`
dependency; CSP as a response header; no service worker; no path→bytes route in v1.

`CHANGELOG.md` gains one `### Added` bullet under `[Unreleased]` in house form, naming the four
artifacts and stating plainly that first releases are unsigned. Amend the existing 0.2.0 PWA
bullet's "browsers offer to install it as a desktop app" to "as a standalone window", so the
changelog does not appear to ship the same feature twice.

**Verify:** `grep -n 'spec §15\|## 15' SPECS.md` finds the section; the `[Unreleased]` bullet sits
under `### Added`.

### 2. Regenerate `package-lock.json` alone

`npm install --package-lock-only`, as its own `build:` commit. The lock root currently says `0.1.0`
against `package.json`'s `0.2.0` and records no `overrides` object even though `package.json` sets
`rollup → @rollup/wasm-node`. Fixing it now keeps the sync repair reviewable instead of buried in
the desktop dependency diff, and stops the first real `npm version` producing a confusing 0.1.0→0.3.0
jump.

**Verify:** the lock's `version` is `0.2.0`, `packages[''].overrides` is defined, `npm ci --dry-run`
succeeds.

### 3. Two build-time constants in `vite.config.ts`

In the existing `define` block, after `__APP_COMMIT_DATE__`, add exactly two entries:
`__APP_TARGET__: JSON.stringify('web')` and `__DEMO_BASE__: JSON.stringify('')`. Nothing else in
this file changes — `base`, `plugins`, `publicDir`, `build.outDir`, `build.sourcemap` and the
`serviceWorker()` call stay byte-identical. Comment in house voice: these are the values that make
the two guards reading them fold away, so esbuild's constant folding leaves no trace of the desktop
target in the deployed bundle.

**Verify:** `git diff --stat vite.config.ts` shows a 2-line addition and no other hunk;
`dist/index.html` still references `/assets/`.

### 4. Centralise the target flag in `src/version.ts`

Add `declare const __APP_TARGET__: string` and
`export const TARGET: 'web' | 'desktop' = typeof __APP_TARGET__ === 'string' && __APP_TARGET__ === 'desktop' ? 'desktop' : 'web'`
— guarded with `typeof` exactly as the three constants above it, because vitest never applies the
app's `define` block and `typeof` on an undeclared name is legal.

Change `PRODUCER` to append ` desktop` on that target, and `buildLine()` to carry `'desktop'` as a
fourth non-empty part. One place for the flag rather than a copy per consumer; it flows into every
exported PDF's `/Producer` via `src/ui/export.ts:194`, which is the first thing anyone checks when a
figure came out wrong.

**Verify:** under vitest (no define block) `TARGET` is `'web'` and `PRODUCER` does not contain
`desktop`.

### 5. Guard the service worker — guard one of three

In `src/pwa.ts`, import `TARGET` and add a second early return in `registerServiceWorker()`
immediately after the `PROD` check: `if (TARGET !== 'web') return`.

Comment in the file's established voice (the `updateViaCache` block is the model): a packaged build
*is* a production build, so `PROD` is not the guard people assume. Note that this is one of three
independent guards — the plugin is not added to the desktop build so `sw.js` is never emitted, and
the `app` scheme is registered without `allowServiceWorkers`, which Chromium refuses outright
(measured: *"The URL protocol of the current origin ('app://viewer') is not supported"*).

Do **not** blank `src/sw.js` — it would trip the exactly-once placeholder assertion at
`vite.config.ts:67-71` and fail the build.

**Verify:** the branch is eliminated from the web bundle — `grep -c "!== 'web'" dist/assets/index-*.js`
returns 0.

### 6. Make the demo catalogue base overridable

In `src/ui/examples.ts`, add `declare const __DEMO_BASE__: string` and
`const DEMO_BASE: string = typeof __DEMO_BASE__ === 'string' ? __DEMO_BASE__ : ''`, documented:
empty on the web (where `BASE_URL` against the page is right by construction) and absolute on
desktop (where the app's own origin serves no demos, and these URLs go through the *remote* reader,
which needs HEAD and ranged GETs a static handler does not answer).

One expression changes: `const base = DEMO_BASE !== '' ? DEMO_BASE : import.meta.env.BASE_URL`. The
existing `new URL(...)` already handles both, since an absolute base wins over the second argument.
Nothing downstream changes — `inferSource` still sees `http(s)://`, so a desktop view state naming a
demo re-opens exactly as a web one does.

**Verify:** the existing demo-examples test passes unchanged; web output is byte-identical because
`DEMO_BASE` folds to `''`.

### 7. `vite.desktop.config.ts` — the second invocation, spreading not editing

```
import base from './vite.config'
export default defineConfig({
  ...base,
  base: './',
  publicDir: false,
  plugins: [stripPwaTags()],
  define: { ...base.define,
    __APP_TARGET__: JSON.stringify('desktop'),
    __DEMO_BASE__: JSON.stringify(process.env.DEMO_BASE ?? 'https://jserizay.com/metacooler.js/') },
  build: { ...base.build, outDir: 'dist-electron/renderer', emptyOutDir: true, sourcemap: false },
})
```

The demo base is the **canonical final origin, not `pkg.homepage`** — see the measurement table.
`stripPwaTags()` is a ~10-line `apply:'build'` plugin whose `transformIndexHtml` removes the
`<link rel="manifest">` and `<meta name="theme-color">` lines.

Base `./` rather than `/`: both work when the handler is rooted at the renderer dir, but `./`
removes the coupling between bundler config and the handler's rooting decision, and it is greppable
as a build assertion.

Do **not** use `--mode desktop` — Vite derives `isProduction` from the mode, so it would flip
`import.meta.env.PROD` to false. Do **not** use `BASE_PATH=./ vite build` — that prefix is not
parsed by the Windows runner's default shell.

**Verify** (once step 9 lands): `dist-electron/renderer/index.html` contains `src="./assets/`, no
`rel="manifest"`, no `sw.js`, no `demo/`.

### 8. Extract the build-shape policy as a tested pure module

`scripts/desktop-shape.mjs` + hand-written `.d.mts` + `test/unit/desktop-shape.test.ts`, following
the `scripts/sw-manifest.mjs` / `test/unit/precache.test.ts` precedent exactly, including a module
doc that names each rule as a mistake somebody makes.

Export `DATA_EXTENSIONS` (`.metacool .mmetacool .cool .mcool .bw .bigWig .narrowPeak .gtf .pairs
.tsv`), `indexHtmlProblems(html)` (no `src="./assets/`; a root-absolute `src="/` or `href="/`; a
surviving `rel="manifest"`), `entryChunkProblems(source)` (a root-absolute
`new URL("/assets/reader.worker`), and `rendererFileProblems(names)` (`sw.js`,
`manifest.webmanifest`, anything under `demo/`, anything ending in a data extension).

The test lands in `test:nofixtures` automatically by exclusion, hence in `preversion`.

### 9. `build:desktop` and its shape check

`scripts/check-desktop-build.mjs` walks `dist-electron/renderer`, applies the three predicates, and
exits 1 naming every problem. Add
`"build:desktop": "npm run typecheck && vite build --config vite.desktop.config.ts && node scripts/check-desktop-build.mjs"`.

Leave `"build"` exactly `"tsc --noEmit && vite build"` — that is the command line
`.github/workflows/deploy.yml:57` runs and it must not change. Add `vite.desktop.config.ts` to
`tsconfig.json`'s `include`; do **not** widen it to `electron/`. Add `dist-electron/`, `release/`,
`*.asar` to `.gitignore` — and **not** `build/`, which is electron-builder's `buildResources` input.

**Verify:** `npm run build:desktop` exits 0; `npm run build` still writes `dist/` with `/assets/`
and a `sw.js`; `git status` shows no untracked build output.

### 10. Add Electron and its own TypeScript project

devDependencies: `"electron": "43.2.0"` pinned exactly, `"electron-builder": "26.15.3"`. Narrow
`engines.node` to `">=22.12.0"` — Electron 43's own floor; the existing `^20.19.0` half cannot run
the toolchain. Set `"main": "dist-electron/main/main.cjs"`.

`tsconfig.electron.json`: `target ES2022`, `module`/`moduleResolution` `NodeNext`, `lib: ["ES2022"]`
— **no DOM**, because a main process that can see `window` is one where a renderer call typechecks
and throws — `types: ["node"]`, `strict`, `noUnusedLocals`, `noUnusedParameters`,
`outDir: "dist-electron/main"`, `rootDir: "electron"`, `include: ["electron"]`.

Extend `typecheck` to `"tsc --noEmit && tsc -p tsconfig.electron.json --noEmit"` so `preversion`
still means "the whole tree compiles". Adding Electron does not make the Pages or test jobs download
a binary: E43 has no install script and fetches lazily on first `require('electron')`.

### 11. `electron/main.cts` — scheme, handler, CSP, window, guards

CommonJS `.cts` under `module: NodeNext` emits `.cjs`, required because the package is
`type: module` and a sandboxed preload cannot be ESM; `.cts` also gives `__dirname`. Append
`&& tsc -p tsconfig.electron.json` to `build:desktop`.

**`electron/protocol.cts`** exports `APP_SCHEME='app'`, `APP_ORIGIN='app://viewer'`,
`APP_INDEX='app://viewer/index.html'` (origin frozen — comment that five preferences are keyed on
it), a pure exported `resolveInside(root, pathname)` predicate (decodeURIComponent in try/catch →
`join` → `normalize` → `relative`, rejecting `''`, `..`-prefixed and absolute), a `TYPES`
extension→MIME table, and the CSP constant:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
img-src 'self' data: blob:; font-src 'self';
connect-src 'self' https: http://localhost:* http://127.0.0.1:*;
worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'; manifest-src 'none'
```

`img-src` needs `data:` for index.html's data-URI favicon. Deliver the CSP as a **response header**.
Serve with `fs.readFile`, not `net.fetch`.

**`electron/main.cts`** calls
`protocol.registerSchemesAsPrivileged([{scheme:'app', privileges:{standard:true, secure:true, supportFetchAPI:true, stream:true, codeCache:true}}])`
at module top level, before `whenReady`. `allowServiceWorkers` deliberately absent (guard three of
three). Call `app.enableSandbox()`.

In `whenReady`: register the handler; deny all three permission handlers
(`setPermissionRequestHandler`, `setPermissionCheckHandler`, `setDevicePermissionHandler`); create
the window with `contextIsolation:true, nodeIntegration:false, nodeIntegrationInWorker:false,
sandbox:true, webviewTag:false, spellcheck:false, devTools:!app.isPackaged`, each with a comment
naming what the other value breaks. Never `webSecurity:false`. `loadURL(APP_INDEX)`.

On `app.on('web-contents-created')`: `setWindowOpenHandler` (https → `shell.openExternal`,
everything else denied), `will-navigate` (preventDefault anything not `APP_ORIGIN`), and
`will-attach-webview` preventDefault. `will-navigate` does not fire for pushState or hash changes,
so the router is untouched. Add `requestSingleInstanceLock`, `window-all-closed`, `activate`.

### 12. GATE — prove it works before writing any packaging config

Add `"start:desktop": "npm run build:desktop && electron ."`. Then, by hand, in this order — each is
a blocker that produces no error message if it fails:

1. The app renders the picker, not a blank window.
2. Dropping a local `.metacool` opens it. This one action proves the module graph, the module
   worker, the dynamic h5wasm chunk import and wasm-under-CSP simultaneously.
3. A demo opens from the dropdown — proves the absolute `__DEMO_BASE__` and that the
   `Origin: app://viewer` change costs nothing.
4. Navigate into a genome and press back — proves `standard:true` and the hash router.
5. Toggle the theme, quit, relaunch — proves the origin is stable and `localStorage` works, which
   `file://` would have failed silently.
6. `navigator.serviceWorker.getRegistrations()` returns `[]`.

Do not proceed to step 13 until all six pass. If (2) fails with a `not-hdf5` runtime-init error,
`nodeIntegrationInWorker` leaked on. If (1) is blank, read the console for a CSP directive name.

### 13. The electron-builder config

`electron-builder.config.cjs`, passed explicitly with `--config`. `read-config-file@6.4.0` loads
`.yml/.yaml/.json/.json5/.toml/.js/.cjs/.ts` and **not** `.mjs`, and `.js` would be ESM under
`type: module`. Getting this wrong fails silently: the config is not found, defaults apply, and the
default `directories.output` is `dist` — the directory Vite writes and Pages uploads.

- `appId: 'io.github.js2264.metacooler-viewer'`
- `productName: 'metacooler-viewer'` — not the manifest's parenthesised em-dashed PWA name, which
  would become the `.app` bundle name and every artifact filename
- `directories: {output:'release', buildResources:'build'}`, `asar:true`, `npmRebuild:false`,
  `publish:null`, `artifactName:'${name}-${version}-${os}-${arch}.${ext}'`
- `files: ['dist-electron/main/**/*','dist-electron/renderer/**/*','package.json','!node_modules/**/*','!**/*.map','!**/demo/**','!**/*.{metacool,mmetacool,cool,mcool,bw,bigWig,narrowPeak,gtf,pairs,tsv}']`
- `electronFuses: {runAsNode:false, enableNodeCliInspectArguments:false, enableNodeOptionsEnvironmentVariable:false, onlyLoadAppFromAsar:true, resetAdHocDarwinSignature:true}` —
  `runAsNode:false` is not theoretical (`ELECTRON_RUN_AS_NODE=1` was set in the environment this
  plan was written in and silently turned Electron into Node); `resetAdHocDarwinSignature` is
  mandatory because flipping a fuse rewrites the binary and invalidates the signature already applied
- `mac: {target:[{target:'dmg',arch:['arm64','x64']},{target:'zip',arch:['arm64','x64']}], icon:'build/icon.png', category:'public.app-category.education', identity:'-', hardenedRuntime:false, notarize:false}`
  — **`'-'`, never `null`**
- `win: {target:[{target:'nsis',arch:['x64']}], icon:'build/icon.png', signExecutable:false}`,
  `nsis: {oneClick:false, perMachine:false, allowToChangeInstallationDirectory:true}`
- `linux: {target:[{target:'AppImage',arch:['x64']},{target:'deb',arch:['x64']}], icon:'build/icon.png', category:'Science', maintainer:'…'}`
  — maintainer is required, or fpm rejects the `.deb` at pack time on the tag

Leave `signtoolOptions` and the mac Developer ID block commented out as inert hooks. Add
`build/entitlements.mac.plist` (`allow-jit`, `disable-library-validation`), referenced only from the
commented block. Extend `scripts/make-app-icons.mjs` to also emit `build/icon.png` at 1024 —
generated, not committed as an opaque blob, which is the argument that file already makes.

**Verify:** `npx electron-builder --linux --dir --config electron-builder.config.cjs` completes and
`release/linux-unpacked/resources/app.asar` is ~6 MB, not ~60 MB — which proves
`!node_modules/**/*` is right.

### 14. Verify the packed asar, not the glob list

Add `@electron/asar` as an explicit devDependency rather than reaching into electron-builder's tree.
`scripts/check-package.mjs` globs `release/**/app.asar`, calls `listPackage`, and fails on: any
data-extension entry or `sw.js`/`manifest.webmanifest`/`*.map`; either of
`/dist-electron/main/main.cjs` and `/dist-electron/renderer/index.html` missing; and an asar over a
40 MB ceiling *or under a 3 MB floor* — the floor catches the day the main process gains a real
dependency and `!node_modules/**/*` silently starts shipping a broken app.

A glob list in a config is a claim; the asar is the answer.

Add `"dist:desktop": "npm run build:desktop && electron-builder --config electron-builder.config.cjs --publish never && node scripts/check-package.mjs"`.

### 15. Wire CI

`deploy.yml` is **not edited** — that is the concrete guarantee for the web target.

New `.github/workflows/release.yml`: `on: push: tags:['v*']` plus `workflow_dispatch`;
`permissions: contents: read` on the build job and `contents: write` only on the collector (never
`pages:` or `id-token:`); `concurrency: group: release-${{ github.ref }}` — **never** `group: pages`,
which a single `git push --follow-tags` would otherwise serialise against the site deploy.

Matrix: `{mac, macos-15, --mac}`, `{win, windows-latest, --win}`, `{linux, ubuntu-latest, --linux}`.
One macOS leg builds both arches because there are no native modules (h5wasm is a single inlined-wasm
file). **`macos-13` no longer exists as a label and `macos-14` is deprecated** — a job naming either
queues forever rather than failing.

Steps: checkout; setup-node 24 with `cache: npm`; `actions/cache` for the per-OS Electron caches
(this job only); `npm ci`; `npm run build:desktop`;
`npx electron-builder <args> --config electron-builder.config.cjs --publish never` with
`CSC_IDENTITY_AUTO_DISCOVERY: false` so a runner keychain cannot silently supply a real Developer
ID; on mac only, `codesign -dv --verbose=4` failing the job on `code object is not signed at all`;
`node scripts/check-package.mjs`; `upload-artifact` named `metacooler-viewer-${{ matrix.id }}`
(v4+ refuses duplicate names in one run).

Collector job `needs: build`, downloads with `merge-multiple: true`, runs a GitHub Release action
with **`draft: true`** — Pages has already published the web build by the time the tag lands, so a
bad artifact costs nothing until a human publishes. Re-check every action's current major at wiring
time rather than copying pins forward.

`test.yml`'s existing `check` job gains one step, `npm run build:desktop` — no Electron binary
needed, so PR time is unchanged. `.gitattributes` gains `* text=auto eol=lf` above the existing
rule, before the first Windows job ever checks out.

**Verify:** push a throwaway tag `v0.0.0-rc1`, watch all three legs go green and a draft release
appear, then delete the tag and the draft. `git tag` is currently empty, so this trigger has never
fired.

### 16. Document the target and record the non-obvious choices

`docs/desktop.md` (user-facing): what it is — a delivery channel, not a second feature set; the
artifact names; **the two warnings verbatim** with exact fixes (macOS *"cannot be opened because the
developer cannot be verified"* → right-click Open, or
`xattr -d com.apple.quarantine /Applications/metacooler-viewer.app`; Windows *"Windows protected
your PC"* → More info → Run anyway), stating plainly that a signature says who published a build,
not whether it works; remote files (the app sends `Origin: app://viewer`, so a bucket whose
allow-list names the Pages site by hostname will refuse it while the website keeps working —
`Access-Control-Allow-Origin: *`, which `docs/hosting.md` already recommends, works in both;
cross-link rather than restate); what it deliberately does not do, each with its one-line reason;
and `npm ci && npm run dist:desktop`.

Add a `desktop` row to the base-path table in `docs/deploy.md` (`./`, written by
`vite.desktop.config.ts`, never by `BASE_PATH`) and a paragraph saying the tag `npm version` creates
is what builds the installers.

Add `comments` entries in `package.json`'s existing argued-prose voice for `main`, `electron` (exact
pin; latest-three support policy; a bump is a CHANGELOG `Changed` entry because it changes the
Chromium the user runs), `build:desktop` (a second invocation, never a change to the first),
`dist:desktop` (deliberately *not* in `preversion`, or `npm version` would pack a `.dmg` to bump a
patch number), `engines` (the floor is Electron's now, not Vite's), and extend `private` with "an
unsigned .dmg is not an npm publish".

---

## Phase B — polish, after the app is launchable

### 17. Preload, native menu, and an About dialog that can name the build

This is what stops the app being a browser in a frame; everything above ships without it.

`electron/contract.cts` holds channel names, `DesktopPlatform`, and a frozen `MENU_COMMAND_IDS`
tuple. `electron/preload.cts` exposes exactly two members via `contextBridge`: `platform` (from
`process.versions` plus `signed:false`) and `onCommand(handler)`, which validates the incoming id
against `MENU_COMMAND_IDS` before dispatching — a fixed list rather than a passthrough.

`electron/menu.cts` builds an explicit template: `role:'appMenu'` on darwin; File with `Open…` on
`CmdOrCtrl+O` (a real accelerator — it shadows nothing, because `matchesKeys` at
`src/ui/commands.ts:63` rejects a bare letter while ⌘/Ctrl is held); Go/View items mirroring registry
commands with **`registerAccelerator: false`** so the key is displayed but still delivered to the
page's own keydown handler at `src/main.ts:204` — otherwise the command registry silently becomes
two sources of truth and the shortcuts dialog documents less than the app responds to.

Deliberately omit `reload`/`forceReload` (⌘R tears down the worker and the mounted `File`, which
cannot be re-read, and it sits beside ⌘T) and the three page-zoom roles (they change the canvas's CSS
size under `largestDpiThatFits`, `src/ui/export.ts:215`, so the same "300 dpi" click yields a
different pixel count at 125 %). Keep `toggleDevTools` only when `!app.isPackaged`.

`src/desktop.ts` is the single renderer module that touches `window.metacoolerDesktop`, exporting
`IS_DESKTOP` and `desktop(): DesktopBridge | null` — the two questions kept apart on purpose, so a
desktop build whose preload failed degrades to browser behaviour rather than throwing.

`src/main.ts` gains three small things: the `onCommand` dispatch beside the keydown listener; a
document-level `dragover`/`drop` preventDefault (a file dropped outside `.dropzone` otherwise
navigates the window to a binary blob with no back button — the main-process `will-navigate` guard is
the un-bypassable half, this is the graceful one); and `document.title = fileLabel(state.uri)` in
`render()`, which BrowserWindow mirrors for free.

`src/ui/dialogs.ts` takes an optional `AboutPlatform` argument — never an Electron import, since the
web build loads this module — printing `Electron X · Chromium Y · Node Z · platform arch` and, when
`signed` is false, one line naming the unsigned build. That line is the answer to the warning the
user just clicked through.

### 18. Target-neutral privacy copy, and the footer promise the UI already makes

Its own `feat(ui):` commit, because it changes on-screen text in the web build too.

Reword the privacy claim **once, for both targets** rather than branching — the module doc's own
standard is that the claim must be literally true of the code, and "leaves your browser" is false in
one target while "leaves this machine" is true in both. `FilePicker.ts:213-219` becomes *"Nothing you
open here leaves this machine. … by code running on your own computer. Quit and nothing remains."*
Same substitution in `dialogs.ts`. Leave a comment recording why the wording had to become
target-neutral. Branch **only** the header subtitle at `src/main.ts:181` on `IS_DESKTOP`, since "in
the browser" is the web app's hook.

Separately: `FilePicker.ts:223`'s dismiss tooltip promises *"The footer keeps the same statement"*
and `StatusBar`'s docstring at `:9-11` asserts the statement stays there permanently — and
`StatusBar.el` renders no such thing. **That is a false promise in the shipping web build today.**
Add the one-line `read in place · nothing is sent` span as the footer's first child.

### 19. The one genuine desktop-only capability: uncompressed transfers

Last, and only after everything above is stable.

`session.defaultSession.webRequest.onBeforeSendHeaders` forcing `Accept-Encoding: identity` on
http(s) requests. This is real and measured: against the live demo host, the same ranged GET returns
`content-encoding: gzip` with `content-range: bytes 0-1023/11066465` — the *compressed* size, the
poison `RemoteRangeSource.ts:131` refuses — when gzip is offered, and no `content-encoding` with the
true `bytes 0-1023/14497503` when identity is. `Accept-Encoding` is a Fetch forbidden header name so
no page can set it; the main process has no such list. It turns the published demos from
whole-object downloads into bounded range reads.

Before shipping it, verify empirically that Chromium honours the override on the worker's
**synchronous XHR** and not just on `fetch`. If the network service re-applies its own value nothing
breaks — the app falls back to today's behaviour with today's error text — but the claim must not be
documented until it is measured.

Do **not** add `onHeadersReceived` ACAO injection here. Update `docs/desktop.md` to enumerate exactly
which failures the desktop build fixes and which it does not.

---

## Pitfalls

Each of these produces no useful error message, which is why they are written down.

| Trap | Symptom | Avoidance |
|---|---|---|
| Routing local bytes through a `metacool-file://` handler | Works, but genome views are visibly slower than the browser build and worsen the more of the map you touch. Nothing errors. | Don't build it. 6.52 ms vs 0.42 ms per 64 KiB read, with a ~3 ms IPC floor at any size. Capture the path as a *string* for addressing; leave bytes on the Blob. |
| `mac.identity: null` for an "unsigned" build — the recipe every blog post quotes | CI green, `.dmg` builds and installs, then does not launch on any Apple Silicon Mac. The packaging job never notices. | `identity: '-'`. Assert with `codesign -dv --verbose=4` in CI, failing on `code object is not signed at all`. |
| Registering the scheme without `standard: true`, or reaching for `file://` | Looks fine, then `SecurityError` the first time you navigate into a genome — killing back/forward and every deep link at once. On `file://` quieter still: the module worker never constructs and the app hangs on "Opening…". | `registerSchemesAsPrivileged` with `standard/secure/supportFetchAPI/stream` before `whenReady`. Gate item (4). |
| Omitting `'wasm-unsafe-eval'`, or a `<meta>` CSP | Shell renders perfectly; every file open fails with `CompileError` from inside the reader worker — a long way from index.html, where you will be looking. | Both verified in both directions. Set the CSP as a header on every `app://` response. |
| Defaulting `__DEMO_BASE__` to `pkg.homepage` | Every entry in the picker's examples list errors — the first thing a new user with no data of their own clicks. | Pin `https://jserizay.com/metacooler.js/`. Add a CI curl assertion for 206 + ACAO + no redirect. |
| Enabling `nodeIntegrationInWorker`, or turning off `sandbox`, for some later feature | Every open dies with a generic `not-hdf5` error hundreds of frames from the cause, and `LocalFileSource.mountTarget()` quietly starts writing 14–46 MB temp files into TMPDIR. | Pin all four flags with a comment naming the `isNodeRuntime()` dependency, plus a text-assertion test so a later edit fails `preversion` rather than a user's first open. |
| Letting `directories.output` default, or writing the config as `.mjs` | A local `dist:desktop` after `build` puts a `.dmg` inside the directory published to the website — or wipes the site build. An `.mjs` config is silently not read, which looks exactly like "electron-builder ignored my settings". | `directories.output: 'release'`, config as `.cjs`, passed with `--config`. Ignore `dist-electron/`, `release/`, `*.asar` — never `build/`. |
| Trusting the `files` glob to keep the 239 MB demo directory out | Every installer ~250 MB too large, CI upload minutes longer per leg, nothing reports a problem. | Two independent guards: `publicDir: false` means the files are never copied in, and `check-package.mjs` reads the packed asar. Give the size check a lower bound too. |
| A menu item on `CmdOrCtrl+P`, or real accelerators mirroring in-page commands | The command palette stops opening, with no error — Electron handles accelerators before the page's keydown listener runs. A registered bare `G` also swallows every `g` typed into a filter box. | Reserve `CmdOrCtrl+P` for the palette, export on `CmdOrCtrl+Shift+E`, `registerAccelerator: false` on every mirroring item. |
| Injecting ACAO globally and claiming "the desktop build fixes CORS" | Three remote failures keep happening exactly as before and nobody believes the error messages; the `?edges=` fetch quietly becomes a read-anything primitive. | Ship the measured `Accept-Encoding: identity` rewrite; skip ACAO injection in v1. If ever wanted, scope it to a user-named origin allowlist behind a tested pure predicate. |
| Copying `concurrency: group: pages` into the release workflow, or putting `dist:desktop` in `preversion` | One `git push --follow-tags` serialises the artifact build against — or cancels — the site deployment. And `npm version patch` starts downloading Electron to bump a number. | `group: release-${{ github.ref }}`; `contents: write` on the collector only; keep `preversion` as `typecheck && test:nofixtures`. |
| Naming `macos-13` or `macos-14` in the matrix | The job never starts. A removed runner label queues indefinitely rather than failing, so the release just hangs and looks like GitHub being slow. | `macos-15` (or `macos-latest`), cross-building the x64 slice — there are no native modules, so nothing compiles. |

---

## Open questions

These do not block starting, but each one should be answered before the step it gates.

1. **Does Chromium honour an `onBeforeSendHeaders` override of `Accept-Encoding` on the reader
   worker's *synchronous* XHR, or only on `fetch`?** The server-side effect of `identity` was
   verified against the live host; the override surviving the network service on the sync-XHR path
   was not. Gates step 19 only. If it does not hold the app degrades silently to today's
   whole-object fallback — which is exactly the kind of silent degradation that wants a budget test
   rather than a comment.
2. **Is `webUtils.getPathForFile` reachable from a `sandbox: true` preload in Electron 43?** It
   decides whether the deferred path-*addressing* story (Open Recent, reload-survives-a-drop, file
   associations) is a preload change or needs the sandbox relaxed. Worth a five-minute probe before
   promising those features on any roadmap.
3. **Should the demo base be pinned in the config, or read from a new `package.json` field?** The
   canonical origin is a custom domain configured in repository settings, not anything in this tree
   — if it changes, the packaged app's example list breaks while the website's keeps working. A CI
   step that curls `${DEMO_BASE}demo/<file>` with a Range and asserts 206 + ACAO + no redirect before
   uploading artifacts would close it cheaply.
4. **`package.json` has no `author` email and the design sets `linux.maintainer` instead.** Confirm
   the address before the first `.deb` — it is baked into a public package and cannot be quietly
   changed later.
5. **Two renderer improvements are gated on `IS_DESKTOP` in step 17 purely to honour the
   byte-identical-behaviour constraint** — the document-level drag/drop guard and `document.title`.
   Both benefit the web build. Should they land unconditionally in their own `fix(ui):` commit
   instead? Leaving them desktop-only permanently is the wrong end state.
