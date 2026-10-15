/**
 * The main process: a scheme, a window, and a long list of things denied.
 *
 * This file adds no capability to the viewer. The renderer it loads is the same
 * bundle the website serves, reading the same files the same way; everything
 * here exists to give that bundle an origin it can live at and to close the
 * doors that a browser tab has closed already. Read it as a list of refusals
 * rather than a list of features — where a browser would show a permission
 * prompt, this says no without asking, because there is no feature above it
 * that would know what to do with a yes.
 *
 * `.cts`, not `.ts`: the package is `type: module`, `module: NodeNext` compiles
 * a `.cts` to a `.cjs`, and Electron's entry point has to be CommonJS. It also
 * gives `__dirname`, which is how the renderer directory is found.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BrowserWindow, Menu, app, protocol, session, shell } from 'electron'

import { buildMenu } from './menu.cjs'
import { APP_INDEX, APP_ORIGIN, APP_SCHEME, CSP, contentType, resolveInside } from './protocol.cjs'

/**
 * Where the renderer build is, relative to this compiled file.
 *
 * `dist-electron/main/main.cjs` → `dist-electron/renderer`. Inside an asar this
 * is a path within the archive, which `fs.readFile` understands natively —
 * that is one of the two reasons the handler reads rather than calling
 * `net.fetch`. The other is that reading leaves every response header ours to
 * set, and the CSP is a response header.
 */
const RENDERER_ROOT = join(__dirname, '..', 'renderer')

/**
 * The window icon, which is a Linux-only concern and not a cosmetic one.
 *
 * macOS takes the icon from the bundle and Windows from the `.exe`; on both,
 * passing one here changes nothing. Linux is the exception: electron-builder
 * installs a hicolor ladder and a `.desktop` entry, and the *window* is still
 * drawn by the compositor from whatever the process itself declares — so
 * without this the app appears correctly in the launcher and generically in the
 * taskbar and the alt-tab switcher, which are where a user actually looks.
 *
 * Two paths because the file lives in two places. Packaged, it is an
 * `extraResources` entry beside the asar rather than inside it: `BrowserWindow`
 * hands the path to the platform, which is not going to read an archive.
 * Unpackaged, `__dirname` is `dist-electron/main`, so this reaches the
 * committed `build/icon.png` that electron-builder derives everything else
 * from — one drawing, both cases.
 *
 * A missing file is a warning on stderr and the default icon, not a crash, so
 * this cannot be the reason a launch fails.
 */
const WINDOW_ICON = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(__dirname, '..', '..', 'build', 'icon.png')

/**
 * Register the scheme before anything else can ask about it.
 *
 * This must run at module top level: `registerSchemesAsPrivileged` is only read
 * during Chromium's startup, and calling it inside `whenReady` is too late —
 * the scheme registers, the app loads, and every privilege below is silently
 * absent.
 *
 * Each privilege earns its place:
 *
 * - **`standard`** is the one that keeps the app alive. Without it the page's
 *   origin is opaque, `history.pushState` throws `SecurityError`, and
 *   `ViewState.writeHash` has no handler above it — so the first navigation
 *   into a genome kills the router, back/forward, and every deep link at once.
 *   `localStorage` goes with it, taking the theme and every remembered table.
 * - **`secure`** makes it a secure context, which is what `crypto.subtle`,
 *   module workers and wasm all require.
 * - **`supportFetchAPI`** so the renderer can `fetch` its own assets.
 * - **`stream`** for ranged and streamed responses.
 * - **`codeCache`** lets Chromium keep compiled JS between launches. The
 *   bundle includes a 4.8 MB h5wasm chunk; this is the difference between a
 *   cold start and a warm one.
 *
 * **`allowServiceWorkers` is deliberately absent**, and that absence is guard
 * three of three (see `src/pwa.ts`). A desktop build has no offline story to
 * tell — it is already on disk — and a worker here would buy nothing while
 * adding the one failure mode where an installed app serves a build the
 * installer replaced.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
])

/**
 * Sandbox every renderer, set before any of them exist.
 *
 * Belt to `sandbox: true`'s braces: that flag is per-window and someone will
 * add a second window one day. This is the process-wide default, so the new
 * window inherits it whether or not its author remembered.
 */
app.enableSandbox()

/**
 * Answer a request on `app://`.
 *
 * The failure modes are all silent, so each is handled rather than allowed to
 * throw: an exception raised in here does not surface anywhere a user or a
 * developer will look — the renderer simply never receives a response, and the
 * window sits blank or half-loaded forever.
 */
async function handleAppRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // Only this origin. The scheme has exactly one host by design, and a request
  // for `app://something-else/` is either a bug or an attempt to reach a second
  // storage bucket under a name that looks like ours.
  if (`${url.protocol}//${url.host}` !== APP_ORIGIN) {
    return new Response('Not found', { status: 404 })
  }

  // The root is the document. Only the root: a general "serve index.html for
  // any directory" rule is how a typo becomes a silently-served shell instead
  // of a 404, and this app has no path-based routes to need it — the router
  // lives entirely in the hash.
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname

  const file = resolveInside(RENDERER_ROOT, pathname)
  if (file === null) return new Response('Forbidden', { status: 403 })

  let body: Buffer
  try {
    body = await readFile(file)
  } catch {
    // Includes the directory case, which reads as EISDIR rather than ENOENT.
    return new Response('Not found', { status: 404 })
  }

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType(file),
      'content-security-policy': CSP,
      // Take the declared type literally. The table in `protocol.cts` is short,
      // so anything unrecognised is served as bytes, and sniffing a `.metacool`
      // into something executable is a category of surprise worth closing.
      'x-content-type-options': 'nosniff',
      // No `Cross-Origin-Embedder-Policy` here, deliberately. `require-corp`
      // looks like free hardening and is not: it also governs *cross*-origin
      // subresources, and every remote file this app opens is one — a bucket
      // that answers ranged GETs correctly but sends no `Cross-Origin-Resource-
      // Policy` header would start failing, at the byte layer, in a build where
      // the same URL works on the website. Not worth it for a page that already
      // embeds nothing and is framed by nothing (`frame-ancestors 'none'`).
    },
  })
}

/**
 * Whether a file-system permission is the app reading what the user chose.
 *
 * The page's own origin, and read access: a request from anywhere else -- a
 * page this window should never have navigated to -- or for writing is refused,
 * as every other permission is. `fileAccessType` absent is a request that has
 * not said, which is treated as the narrower of the two.
 */
function readsOwnFile(url: string, access: 'readable' | 'writable' | undefined): boolean {
  return url.startsWith(`${APP_ORIGIN}/`) && access !== 'writable'
}

/**
 * Ask remote hosts not to compress, which is the one thing this build can do
 * that a browser cannot.
 *
 * `Accept-Encoding` is a **forbidden header name** in Fetch, so no page can set
 * it — not with `fetch`, not with `XMLHttpRequest`. `RemoteRangeSource` says so
 * at its own line 128 and calls the caller's only recourse "stop using ranges".
 * The main process has no forbidden-header list, and that asymmetry is the
 * entire capability.
 *
 * **What it actually buys, measured rather than assumed.** Against a host that
 * gzips `application/octet-stream`, with the override off and on:
 *
 * | request                  | off                              | on         |
 * |--------------------------|----------------------------------|------------|
 * | `HEAD` — the open probe  | `gzip, deflate, br, zstd` → gzip | `identity` |
 * | `GET`, no range          | `gzip, …` → gzip                 | `identity` |
 * | `GET`, **with** `Range`  | **already `identity`**           | `identity` |
 *
 * The last row is the one that matters, and it is not what one would guess:
 * **Chromium already sends `identity` whenever a request carries a `Range`
 * header**, because it cannot inflate a partial response. So ranged reads were
 * never the problem in a browser engine, and an override sold on fixing them
 * would be a no-op documented as a feature.
 *
 * The `HEAD` is the problem. `RemoteRangeSource.open()` probes with one, it
 * carries no `Range`, so it is answered compressed — and the reader then refuses
 * to read the file in ranges, with `remote-compressed`, rather than trusting a
 * `content-length` that describes the gzip stream. That refusal is correct and
 * stays, and the website answers it by downloading the whole file instead, up
 * to 128 MiB encoded, refusing past that (`worker/sources.ts`). This simply
 * means the desktop build stops provoking it: the same file, on the same host,
 * is read here in ranges like any other. GitHub Pages is exactly such a host,
 * which is the case `RemoteRangeSource` documents as having no client-side fix
 * for ranges at all.
 *
 * Only http(s), and only the request headers: this states a preference on an
 * outgoing request and can change nothing else. In particular it is **not** an
 * `onHeadersReceived` hook injecting `Access-Control-Allow-Origin` — that is
 * rejected outright. Response headers cannot make a server produce partial
 * content, so it would fix none of the failures people expect it to; and the
 * worker's `?edges=` sidecar fetch takes an arbitrary user-supplied URL and
 * renders the result, which a blanket ACAO injection turns into a read-anything
 * primitive.
 *
 * If a network stack ever re-applies its own value, nothing breaks: the app
 * falls back to exactly today's behaviour with today's error text. Verified to
 * survive the reader's real path — a synchronous `XMLHttpRequest` inside a
 * same-origin module worker — and not only `fetch` from the document.
 */
function askForUncompressedTransfers(current: Electron.Session): void {
  current.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!details.url.startsWith('http://') && !details.url.startsWith('https://')) {
      callback({ requestHeaders: details.requestHeaders })
      return
    }
    callback({
      requestHeaders: { ...details.requestHeaders, 'Accept-Encoding': 'identity' },
    })
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    // The window exists before the document paints; showing it empty is a
    // white rectangle for as long as the bundle takes to parse.
    show: false,
    backgroundColor: '#ffffff',
    title: 'chromosomix',
    // Linux only; see WINDOW_ICON. `undefined` is what the option means by
    // "leave it to the platform", which is the right answer on the other two.
    icon: process.platform === 'linux' ? WINDOW_ICON : undefined,
    webPreferences: {
      // Two members wide, and CommonJS because a sandboxed preload cannot be
      // ESM. A window whose preload fails to load still works: `src/desktop.ts`
      // asks whether the bridge is there rather than assuming it, so the app
      // degrades to browser behaviour instead of throwing.
      preload: join(__dirname, 'preload.cjs'),
      // Isolates the page's JavaScript from any privileged code in the same
      // frame. Off, a preload's objects are reachable and mutable by the page,
      // which turns every one of them into an escape route.
      contextIsolation: true,
      // Off: with it on, the page gets `require` and the file system, and the
      // app's own privacy claim ("nothing you open here leaves this machine")
      // stops being a property of the code.
      nodeIntegration: false,
      // Off, and this one is not about security. `isNodeRuntime()` in the
      // reader worker decides which h5wasm filesystem path to take purely by
      // whether `process` exists. Leak Node into the worker and every file open
      // takes the wrong path and dies with a generic `not-hdf5` error hundreds
      // of frames from the cause -- while `mountTarget()` starts writing tens of
      // megabytes into TMPDIR on the way past.
      nodeIntegrationInWorker: false,
      // Renderer runs in an OS sandbox. Off, a renderer compromise is a
      // compromise of the user's account.
      sandbox: true,
      // `<webview>` is a second, differently-configured renderer that inherits
      // none of the above. Nothing in this app uses one.
      webviewTag: false,
      // Nothing here is a text field worth a dictionary, and it is a network
      // fetch on some platforms.
      spellcheck: false,
      // Available while developing, absent from what ships: a packaged app with
      // devtools is a debugging surface on a machine we do not control.
      devTools: !app.isPackaged,
      // `webSecurity` is never set. Turning it off disables the same-origin
      // policy and the CSP above along with it, which would make every refusal
      // in this file decorative.
    },
  })

  window.once('ready-to-show', () => window.show())
  void window.loadURL(APP_INDEX)
}

/**
 * One instance, so two launches share a window rather than a storage bucket.
 *
 * Two processes on one `localStorage` is not a crash; it is the last writer
 * winning, which presents as settings that revert for no reason.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing === undefined) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  /**
   * Applies to every renderer that will ever exist, including ones added later
   * by someone who did not read this file.
   */
  app.on('web-contents-created', (_event, contents) => {
    // A link that would open a new window opens in the user's browser instead,
    // and only if it is http(s). `window.open` in a desktop app is otherwise a
    // frameless, preference-free window with no address bar -- a page that can
    // look like anything, including like this app.
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    // The window itself never navigates away from its origin. This is the
    // un-bypassable half of the dropped-file guard: a file dropped outside the
    // dropzone would otherwise navigate the window to a binary blob, with no
    // address bar and no back button to return from.
    //
    // It does not fire for `pushState` or for hash changes, so the app's own
    // router is untouched by it.
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault()
    })

    contents.on('will-attach-webview', (event) => event.preventDefault())
  })

  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, handleAppRequest)

    // Everything a page can ask for, refused without asking the user. The
    // viewer needs none of it -- no camera, no microphone, no geolocation, no
    // notifications, no clipboard read, no USB, no serial -- and a prompt the
    // app has no reason to show is a prompt the user cannot evaluate.
    //
    // With one exception, and it is the app's own: **reading** a file or a
    // folder the user chose, from the app's own origin. The picker is the
    // user's answer -- they pointed at the folder -- and what this lets
    // through is the browser asking again, on the next launch, whether that
    // answer still stands: refused, a folder connected yesterday was dead
    // today, and a workspace naming its files could not find them (SPECS
    // §20.6). Never writing, and never for any other origin.
    //
    // All three, because they are asked in different circumstances and denying
    // one leaves the other two answering with their defaults.
    const current = session.defaultSession
    current.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(
        permission === 'fileSystem' &&
          readsOwnFile(contents.getURL(), 'fileAccessType' in details ? details.fileAccessType : undefined),
      )
    })
    current.setPermissionCheckHandler(
      (_contents, permission, origin, details) =>
        permission === 'fileSystem' && origin === APP_ORIGIN && details.fileAccessType !== 'writable',
    )
    current.setDevicePermissionHandler(() => false)

    askForUncompressedTransfers(current)

    // Application-wide, and before the first window: on macOS the menu bar
    // belongs to the app rather than to a window, so building it per-window
    // would leave the app with no menu whenever no window has focus.
    Menu.setApplicationMenu(buildMenu())

    createWindow()

    // macOS: the dock icon reopens a window after the last one is closed,
    // because on that platform the app is still running.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Everywhere except macOS, closing the last window quits -- which is the
  // platform convention, and on the others an app with no windows and no menu
  // bar is a process the user cannot see or stop.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
