/**
 * Bundle the preload into one self-contained file.
 *
 * A **sandboxed** preload does not get Node's module resolver. Its `require`
 * reaches `electron` and a short list of built-ins and nothing else — a relative
 * `require('./contract.cjs')` fails outright. `tsc` cannot know that: it emits
 * correct CommonJS, with correct relative requires, that Electron then refuses
 * to load.
 *
 * The failure is worth describing because it does not look like a build
 * problem. The app starts, the window opens, the page renders, the menu is
 * there and every item is greyed-out-looking-but-clickable and does nothing; the
 * only evidence is one line on a console nobody has open:
 *
 *     Unable to load preload script: …/preload.cjs
 *     Error: module not found: ./contract.cjs
 *
 * Bundling rather than inlining the constants into `preload.cts`: the command
 * allowlist has to be one list. It is the thing the preload checks against and
 * the thing `menu.cts` is typed by, and two copies of an allowlist is how an id
 * gets added to one of them.
 *
 * `electron` stays external — it is provided by the runtime, not by npm — and
 * this deliberately overwrites the `preload.cjs` that `tsc` just emitted, so
 * the ordering in `build:desktop` is not incidental. `tsc` still runs first and
 * still typechecks this file; esbuild does not typecheck anything.
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)

await build({
  entryPoints: [fileURLToPath(new URL('electron/preload.cts', root))],
  outfile: fileURLToPath(new URL('dist-electron/main/preload.cjs', root)),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  // Keeps the comments explaining the two-member bridge in the file someone
  // will read when they are wondering what the page can reach.
  minify: false,
  legalComments: 'inline',
})

console.log('build-preload: bundled electron/preload.cts -> dist-electron/main/preload.cjs')
