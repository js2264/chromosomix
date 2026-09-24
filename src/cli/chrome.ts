/**
 * Find a Chromium on this machine, start it headless, and open a page in it.
 *
 * `metacooler-plot` (§27) needs a browser because the pictures it saves are the
 * app's own, and the app draws on a canvas, with fonts, a GPU context for the
 * 3D model and a chart library for the figures. It needs *a* browser rather
 * than a particular one, so it looks where browsers are: a path it is told,
 * two environment variables, the names on `PATH`, the places each platform
 * installs Chrome, Chromium, Edge and Brave, and the caches Playwright and
 * Puppeteer download theirs into. Nothing is downloaded here — a command that
 * fetched a hundred megabytes on its first run would be doing something nobody
 * asked it to.
 *
 * Any Chromium from the last few years will do: the page needs module workers,
 * `--headless=new` and `--remote-debugging-pipe`, and all three are old.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import { CdpConnection, CdpPage } from './cdp'

/** The environment variables a browser path is read from, most specific first. */
export const BROWSER_ENV = ['METACOOLER_BROWSER', 'CHROME_PATH'] as const

/** Executable names looked for on `PATH`, in order of preference. */
const PATH_NAMES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'microsoft-edge-stable',
  'microsoft-edge',
  'brave-browser',
  'chrome',
]

/** Where the three platforms install the browsers that will do. */
function installedPaths(os: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (os === 'darwin') {
    const apps = ['/Applications', join(homedir(), 'Applications')]
    const bundles = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ]
    return apps.flatMap((dir) => bundles.map((bundle) => join(dir, bundle)))
  }
  if (os === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(
      (root): root is string => typeof root === 'string' && root !== '',
    )
    const exes = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ]
    return roots.flatMap((root) => exes.map((exe) => join(root, exe)))
  }
  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
    '/opt/google/chrome/chrome',
  ]
}

/**
 * The browsers Playwright and Puppeteer downloaded, newest revision first.
 *
 * Playwright keeps `chromium-<revision>/chrome-<platform>/…` under
 * `PLAYWRIGHT_BROWSERS_PATH` or its per-user cache; Puppeteer keeps
 * `chrome/<platform>-<version>/chrome-<platform>/…` under its own. The layouts
 * are theirs and have changed before, so every spelling either has used is
 * tried, and a directory that is not one of them is simply passed over.
 */
function cachedPaths(os: NodeJS.Platform, env: NodeJS.ProcessEnv, list: (dir: string) => string[]): string[] {
  const home = homedir()
  const playwrightRoots = [
    env['PLAYWRIGHT_BROWSERS_PATH'],
    os === 'darwin'
      ? join(home, 'Library', 'Caches', 'ms-playwright')
      : os === 'win32'
        ? join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'ms-playwright')
        : join(env['XDG_CACHE_HOME'] ?? join(home, '.cache'), 'ms-playwright'),
  ].filter((root): root is string => typeof root === 'string' && root !== '' && root !== '0')
  const inside =
    os === 'darwin'
      ? [
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
          'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
          'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ]
      : os === 'win32'
        ? ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']
        : ['chrome-linux/chrome', 'chrome-linux64/chrome']
  const out: string[] = []
  for (const root of playwrightRoots) {
    out.push(join(root, 'chromium'))
    for (const dir of revisions(list, root, /^chromium-(\d+)$/)) {
      for (const tail of inside) out.push(join(root, dir, tail))
    }
  }
  const puppeteer = join(env['PUPPETEER_CACHE_DIR'] ?? join(home, '.cache', 'puppeteer'), 'chrome')
  for (const dir of revisions(list, puppeteer, /^[a-z0-9]+-(\d+)/)) {
    for (const tail of inside) out.push(join(puppeteer, dir, tail))
  }
  return out
}

/** The subdirectories of `root` whose names match, highest number first. */
function revisions(list: (dir: string) => string[], root: string, pattern: RegExp): string[] {
  return list(root)
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))
    .map((entry) => entry.name)
}

/** Whether a path is a file that exists, which is all `spawn` needs to be told. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** A directory's entries, or none for one that is not there. */
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * The two questions the search asks of a disk. A parameter so that the order
 * of the search can be tested on a machine that has a browser installed, which
 * would otherwise answer every question before the one being tested.
 */
export interface BrowserDisk {
  isFile(path: string): boolean
  list(dir: string): string[]
}

const DISK: BrowserDisk = { isFile, list: listDir }

/** The names on `PATH`, resolved to files. */
function onPath(env: NodeJS.ProcessEnv, os: NodeJS.Platform): string[] {
  const dirs = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== '')
  const suffixes = os === 'win32' ? ['.exe', ''] : ['']
  const out: string[] = []
  for (const name of PATH_NAMES) {
    for (const dir of dirs) {
      for (const suffix of suffixes) out.push(join(dir, `${name}${suffix}`))
    }
  }
  return out
}

/**
 * Where a browser is, or `null`.
 *
 * A path given with `--browser` is taken as the answer or refused — a reader
 * who named one has said which browser, and quietly using another would
 * produce pictures from a browser they did not choose.
 */
export function findBrowser(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  os: NodeJS.Platform = platform(),
  disk: BrowserDisk = DISK,
): { path: string } | { path: null; tried: string } {
  if (explicit !== undefined) {
    return disk.isFile(explicit) ? { path: explicit } : { path: null, tried: `--browser ${explicit}` }
  }
  for (const name of BROWSER_ENV) {
    const value = env[name]
    if (value !== undefined && value !== '' && disk.isFile(value)) return { path: value }
  }
  for (const candidate of [...onPath(env, os), ...installedPaths(os, env), ...cachedPaths(os, env, disk.list)]) {
    if (disk.isFile(candidate)) return { path: candidate }
  }
  return {
    path: null,
    tried:
      `${BROWSER_ENV.join(', ')}, ${PATH_NAMES.join(', ')} on PATH, the usual install locations ` +
      'and the Playwright and Puppeteer caches',
  }
}

export interface LaunchOptions {
  executable: string
  width: number
  height: number
  /** Show a window rather than run headless — for watching a run go wrong. */
  show: boolean
  /** Hand the browser's own chatter to this process's stderr. */
  verbose: boolean
}

/** A running browser, its connection, and the way to put it down. */
export class Browser {
  private closing = false
  private shutdown: Promise<void> | undefined
  /** The last lines the browser wrote to stderr, for a launch that fails. */
  private readonly chatter: string[] = []

  private constructor(
    private readonly child: ChildProcess,
    readonly connection: CdpConnection,
    private readonly profile: string,
  ) {
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        this.chatter.push(line)
        if (this.chatter.length > 40) this.chatter.shift()
      }
    })
    child.on('exit', (code, signal) => {
      if (this.closing) return
      const why = signal !== null ? `was killed by ${signal}` : `exited with code ${code}`
      connection.fail(new Error(`the browser ${why}${this.tail()}`))
    })
  }

  /**
   * Start one, headless unless told otherwise, in a profile of its own that
   * is deleted when it closes — so nothing a reader keeps in their own browser
   * is read, and nothing this run does is left behind.
   */
  static async launch(options: LaunchOptions): Promise<Browser> {
    const profile = mkdtempSync(join(tmpdir(), 'metacooler-plot-'))
    const args = [
      options.show ? '' : '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      `--window-size=${options.width},${options.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      // Nothing leaves the machine but what the workspace names. A browser
      // started bare still checks in with its vendor — push messaging, field
      // trials, translation, phishing lists, certificate logs — which on a
      // locked-down network is a line of refused connections in the proxy's
      // log for every figure, and on any network is traffic nobody asked for.
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-component-extensions-with-background-pages',
      '--disable-client-side-phishing-detection',
      '--disable-domain-reliability',
      '--disable-field-trial-config',
      '--disable-features=Translate,MediaRouter,DialMediaRouteProvider,OptimizationHints,' +
        'CertificateTransparencyComponentUpdater,AutofillServerCommunication,HttpsUpgrades',
      '--metrics-recording-only',
      '--no-service-autorun',
      '--disable-search-engine-choice-screen',
      '--disable-breakpad',
      // A container's `/dev/shm` is 64 MB by default, and a page holding a
      // contact map outgrows it and crashes with nothing said; `/tmp` has room.
      '--disable-dev-shm-usage',
      // The same colours on every machine: a display's own profile has no say
      // in a figure somebody else will print.
      '--force-color-profile=srgb',
      // A page nobody is looking at still has to draw on time: these are the
      // three ways a browser slows one down, and each would stretch a wait.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--hide-scrollbars',
      '--mute-audio',
      '--password-store=basic',
      '--use-mock-keychain',
      // WebGL for the 3D model on a machine with no GPU — a server, a CI runner,
      // a container — through the software rasteriser, which is also what makes
      // two runs of one model the same picture.
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      ...(options.show ? [] : ['--use-angle=swiftshader']),
      // Chromium refuses to start its sandbox as root, and says so in a way
      // nobody reading a CI log would connect to this command.
      ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
      'about:blank',
    ].filter((arg) => arg !== '')
    const child = spawn(options.executable, args, {
      stdio: ['ignore', options.verbose ? 'inherit' : 'ignore', 'pipe', 'pipe', 'pipe'],
    })
    const input = child.stdio[3] as Writable | null
    const output = child.stdio[4] as Readable | null
    if (input === null || output === null) {
      child.kill()
      throw new Error('the browser was started without the two pipes the DevTools protocol needs')
    }
    const connection = new CdpConnection(input, output)
    const browser = new Browser(child, connection, profile)
    if (options.verbose) child.stderr?.pipe(process.stderr)
    const started = await Promise.race([
      connection.send('Browser.getVersion').then(() => null),
      new Promise<Error>((resolve) => {
        child.once('error', (error) => resolve(error))
        setTimeout(() => resolve(new Error('the browser did not answer within 60 s of starting')), 60_000).unref()
      }),
    ])
    if (started !== null) {
      await browser.close()
      throw new Error(`${options.executable} could not be started: ${started.message}${browser.tail()}`)
    }
    return browser
  }

  /**
   * A page in a browser context of its own, sized to the window a reader would
   * have and told which colour scheme the machine is in.
   *
   * A context per page, because what a tab remembers lives in the page's own
   * storage — `sessionStorage` above all, which a second page load in the same
   * tab would find exactly as the first left it — and a figure of one tab must
   * not be drawn with another tab's memory. `close` disposes of the context and
   * everything in it.
   */
  async openPage(options: {
    width: number
    height: number
    scheme: 'light' | 'dark'
  }): Promise<{ page: CdpPage; close(): Promise<void> }> {
    const { browserContextId } = await this.connection.send<{ browserContextId: string }>(
      'Target.createBrowserContext',
      { disposeOnDetach: true },
    )
    const { targetId } = await this.connection.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    })
    const { sessionId } = await this.connection.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    const page = new CdpPage(this.connection, sessionId)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    // The theme the command asked for is what the page's own toggle sets; the
    // machine's scheme is set to match, so nothing on the page is drawn for the
    // other one.
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: options.scheme }],
    })
    // A page that crashes answers nothing again; everything waiting on it is
    // told so at once rather than at its timeout.
    const stop = page.on('Inspector.targetCrashed', () => {
      this.connection.fail(new Error(`the page crashed${this.tail()}`))
    })
    return {
      page,
      close: async () => {
        stop()
        await this.connection
          .send('Target.disposeBrowserContext', { browserContextId })
          .catch(() => undefined)
      },
    }
  }

  /** Put it down, and take its profile with it. */
  close(): Promise<void> {
    // One shutdown however many ask for it — the run's own `finally` and a ^C
    // can both — and every one of them waits for the same exit.
    this.shutdown ??= this.stop()
    return this.shutdown
  }

  private async stop(): Promise<void> {
    this.closing = true
    const exited = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve()
      else this.child.once('exit', () => resolve())
    })
    if (this.connection.closed === null) {
      await Promise.race([
        this.connection.send('Browser.close').catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3_000).unref()),
      ])
    }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5_000)
    timer.unref()
    await exited
    clearTimeout(timer)
    // A browser can hold its profile for a moment after it has exited — on
    // Windows most of all — so the removal is retried rather than trusted.
    try {
      rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      /* a temporary directory the system will clear is not worth failing a run over */
    }
  }

  /** The browser's last words, where it said any. */
  private tail(): string {
    const lines = this.chatter.filter((line) => !/^\s*$/.test(line)).slice(-6)
    return lines.length === 0 ? '' : `\n    ${lines.join('\n    ')}`
  }
}
