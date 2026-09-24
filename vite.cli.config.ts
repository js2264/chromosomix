/**
 * The CLI build — a fourth invocation of the same bundler over the same source.
 *
 * The rule `vite.desktop.config.ts` states applies here unchanged: `build` is
 * the command line the deploy workflow runs and it must keep working byte for
 * byte, so this is a *second reading* of `src/` and never an edit to the first.
 * What comes out is one ESM file per command under `dist-cli/`, and what goes
 * into `metacooler-run` is the same `RUNNERS`, the same `MetaCooler` and the
 * same writers the tab uses.
 *
 * ## Two commands, and what the second one needs beside it
 *
 * `metacooler-plot` (§27) draws nothing itself: it serves the *viewer* to a
 * headless browser and saves the figures the app draws. So `npm run build:cli`
 * is this build and then the package build of the viewer (`vite.package.config.ts`,
 * into `dist/`) — the relative-base copy, which is the one that serves from any
 * path, and the one a published package already carries beside `dist-cli/`.
 * Code both commands import lands in `dist-cli/chunks/`, once.
 *
 * ## Why a bundle rather than running the TypeScript
 *
 * Node 22 strips types from a `.ts` file without a loader, which would have been
 * the shortest possible answer. It only handles **erasable** syntax, and this
 * repo uses parameter properties — `constructor(private readonly source:
 * ByteSource)` — in a dozen places, which are not. Rewriting a dozen
 * constructors to avoid a build step would be the tail wagging the dog.
 *
 * ## What stays external
 *
 * `h5wasm` and `@gmod/bbi` are marked external and resolved from `node_modules`
 * at run time, because both ship a `.wasm` or a native-adjacent asset that a
 * single-file bundle cannot carry. That is also why the CLI is run from a clone
 * rather than published as a standalone binary — the same decision, and the same
 * reason, as `package.json`'s `private`.
 */

import { builtinModules } from 'node:module'
import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'node:child_process'
import { chmodSync, readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version?: string
  homepage?: string
}
const VERSION = pkg.version ?? '0.0.0'

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // A source tarball has no git. The version alone is what the provenance line
    // then carries, which `analysis/worker` already handles by filtering empties.
    return ''
  }
}

/**
 * Set the executable bit Rollup never does — it writes a file, not a program.
 *
 * `bin`'s whole point is `npm link`/`npm install -g` handing back a
 * `metacooler-run` a shell can run directly, with no `.mjs` and no explicit
 * `node`. npm chmods the target the moment it creates that link, but every
 * `vite build` afterwards writes a fresh file at the same path with the
 * default `0644` and quietly takes the bit back — the symlink still resolves,
 * `node dist-cli/metacooler-run.mjs` still runs it by naming the interpreter,
 * and only the one form the whole feature is for starts failing with
 * "permission denied".
 */
function executable(): Plugin {
  let outDir = 'dist-cli'
  return {
    name: 'metacooler-cli-executable',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      for (const command of COMMANDS) chmodSync(joinPath(outDir, `${command}.mjs`), 0o755)
    },
  }
}

/** The commands this build writes, each an entry of its own. */
const COMMANDS = ['metacooler-run', 'metacooler-plot'] as const

export default defineConfig({
  plugins: [executable()],
  define: {
    __APP_VERSION__: JSON.stringify(VERSION),
    __APP_HOMEPAGE__: JSON.stringify(pkg.homepage ?? ''),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
    __APP_COMMIT_DATE__: JSON.stringify(''),
    __APP_TARGET__: JSON.stringify('cli'),
    __DEMO_BASE__: JSON.stringify(''),
    // A command-line program signs in to nothing.
    __GOOGLE_CLIENT_ID__: JSON.stringify(''),
    __GOOGLE_API_KEY__: JSON.stringify(''),
    __DROPBOX_APP_KEY__: JSON.stringify(''),
  },
  // Nothing in `public/` belongs beside a command-line program; without this
  // the icons and the web manifest are copied into `dist-cli/`.
  publicDir: false,
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist-cli',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      // One entry per command, named for it: `lib` mode takes one entry, and
      // its `fileName` is not consulted under `ssr: true` anyway — which named
      // the output after the source file, so the first command would have been
      // `dist-cli/main.js`.
      input: {
        'metacooler-run': new URL('./src/cli/main.ts', import.meta.url).pathname,
        'metacooler-plot': new URL('./src/cli/plot.ts', import.meta.url).pathname,
      },
      output: {
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
        // A command is run by its file, so the entries carry the interpreter
        // line; a chunk is only ever imported, and has no use for one.
        banner: (chunk) => (chunk.isEntry ? '#!/usr/bin/env node' : ''),
      },
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
        'h5wasm',
        'h5wasm/node',
        '@gmod/bbi',
        'generic-filehandle2',
      ],
    },
  },
})
