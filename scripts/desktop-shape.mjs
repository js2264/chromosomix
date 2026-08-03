/**
 * What a desktop renderer build is allowed to look like.
 *
 * Shared by `scripts/check-desktop-build.mjs`, which walks the built directory,
 * and by `test/unit/desktop-shape.test.ts`, which is the only way to check the
 * rules without shipping a wrong one first. Every rule here is a mistake
 * somebody makes, and every one of them produces an application that builds,
 * packages, installs and then fails on a user's machine with nothing useful on
 * screen:
 *
 * 1. **The URLs must be relative.** A packaged renderer is served from
 *    `app://viewer/`, and a root-absolute `/assets/index-abc.js` resolves to
 *    `app://viewer/assets/…` only for as long as the handler is rooted exactly
 *    there. Worse, it is what a stray `BASE_PATH` in the environment produces,
 *    and the symptom is a blank window: the document loads, the module 404s,
 *    and nothing is written anywhere a user would look.
 * 2. **The manifest tag must be gone.** `publicDir: false` means
 *    `manifest.webmanifest` is never copied, so a surviving `<link
 *    rel="manifest">` points at a file that does not exist — a failed request on
 *    the console of an app whose claim is that it needs no network.
 * 3. **No service worker, and no manifest file.** Three independent guards keep
 *    a worker out of this build (see `src/pwa.ts`); this is where they are
 *    checked rather than trusted, because all three are edits somebody could
 *    reverse for a plausible-sounding reason.
 * 4. **No data.** The demo datasets and track resources under `public/demo/`
 *    are ~250 MB. They are what the viewer *opens*, not what it is, and this
 *    build reads them over the network exactly as it reads any other remote
 *    file. Swept in, they make every installer a quarter of a gigabyte larger
 *    and nothing reports a problem.
 *
 * Pure string and array predicates, no filesystem: the caller reads, this
 * decides. Each returns a list of human-readable problems, empty when there are
 * none — a boolean would tell the operator that something is wrong and not what.
 */

/**
 * File extensions that are data rather than application.
 *
 * The text formats are the ones to watch. A rule written around "binary is
 * data" takes a `.gtf`, a `.tsv` and a `.narrowPeak` straight into the package,
 * and those are exactly the track resources published beside the demo maps.
 */
export const DATA_EXTENSIONS = [
  '.metacool',
  '.mmetacool',
  '.cool',
  '.mcool',
  '.bw',
  '.bigWig',
  '.narrowPeak',
  '.gtf',
  '.pairs',
  '.tsv',
]

/** `true` when a file name ends in a data extension, case-insensitively. */
export function isDataFile(name) {
  const lower = name.toLowerCase()
  return DATA_EXTENSIONS.some((extension) => lower.endsWith(extension.toLowerCase()))
}

/**
 * What is wrong with the built `index.html`, if anything.
 *
 * The positive assertion comes first and is the important one: a build that
 * emitted no module script at all would pass every negative check here.
 */
export function indexHtmlProblems(html) {
  const problems = []
  if (!html.includes('src="./assets/')) {
    problems.push(
      'index.html has no relative module script (expected src="./assets/…"); ' +
        'base is not "./" — check vite.desktop.config.ts and BASE_PATH',
    )
  }
  for (const match of html.matchAll(/\s(?:src|href)="(\/[^/][^"]*)"/g)) {
    problems.push(
      `index.html references ${match[1]} from the root; ` +
        'a packaged renderer has no site root to resolve it against',
    )
  }
  if (/<link\s[^>]*rel="manifest"/i.test(html)) {
    problems.push('index.html still links a web manifest; stripPwaTags() did not run')
  }
  return problems
}

/**
 * What is wrong with the entry chunk, if anything.
 *
 * Vite emits worker URLs as `new URL('/assets/reader.worker-abc.js', …)` under
 * a root-absolute base. That one survives every check on `index.html` — the
 * document loads, the shell renders, the picker appears — and then the first
 * file opened hangs on "Opening…", because the worker never constructs and a
 * failed `new Worker` is not an exception anyone catches.
 */
export function entryChunkProblems(source) {
  const problems = []
  for (const match of source.matchAll(/new URL\(\s*["'](\/assets\/[^"']*)["']/g)) {
    problems.push(
      `an entry chunk builds a worker URL from the root: ${match[1]} — ` +
        'the worker will not construct and the app will hang on "Opening…"',
    )
  }
  return problems
}

/**
 * What is wrong with the bundled preload, if anything.
 *
 * A **sandboxed** preload has no module resolver: its `require` reaches
 * `electron` and a few Node built-ins, and a relative `require('./contract.cjs')`
 * fails. `tsc` emits exactly that and cannot know better, which is why
 * `build-preload.mjs` bundles the file — and why this checks that the bundling
 * actually happened.
 *
 * It has to be checked rather than trusted because the failure is invisible.
 * The app starts, the window opens, the page renders, the menu appears and
 * every item does nothing at all. One line on a console nobody has open is the
 * only evidence.
 *
 * Built-ins are allowed by name. Anything relative is not.
 */
export function preloadProblems(source) {
  const problems = []
  for (const match of source.matchAll(/require\(\s*["'](\.[^"']*)["']\s*\)/g)) {
    problems.push(
      `preload requires ${match[1]} relatively — a sandboxed preload has no module ` +
        'resolver, so it will fail to load and every menu item will silently do nothing',
    )
  }
  if (!source.includes('exposeInMainWorld')) {
    problems.push('preload does not call contextBridge.exposeInMainWorld — the bridge is not exposed')
  }
  return problems
}

/**
 * What is wrong with the *set* of files in the renderer directory.
 *
 * Takes names relative to the renderer root, with `/` separators, so the caller
 * owns the walk and this owns the policy.
 */
export function rendererFileProblems(names) {
  const problems = []
  for (const name of names) {
    const base = name.split('/').pop() ?? name
    if (base === 'sw.js') {
      problems.push(`${name}: a service worker was emitted for the desktop build`)
    } else if (base === 'manifest.webmanifest') {
      problems.push(`${name}: a web manifest was emitted for the desktop build`)
    } else if (name.split('/').includes('demo')) {
      problems.push(`${name}: the demo directory is data and must not be packaged`)
    } else if (isDataFile(base)) {
      problems.push(`${name}: a data file reached the renderer build`)
    }
  }
  return problems
}
