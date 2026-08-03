import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version?: string
}

/**
 * Ask git one question, or give up quietly.
 *
 * A build from a source tarball, or from a checkout with no history, has no
 * repository to ask — and a viewer that refused to build because it could not
 * name its own commit would be a worse trade than one whose about dialog says a
 * little less. `execFileSync` rather than a shell: no interpolation, nothing to
 * quote.
 */
function git(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

// GitHub Pages serves the app from a sub-path; override with BASE_PATH at build
// time. `h5wasm` ships a .wasm asset that must not be inlined or renamed, so it
// is excluded from dependency pre-bundling.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  // What the bundle says about itself (`src/version.ts`). The commit *date*
  // rather than the build date: rebuilding identical source must not produce a
  // bundle that claims to be newer than the one beside it.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
    __APP_COMMIT__: JSON.stringify(git(['rev-parse', '--short', 'HEAD'])),
    __APP_COMMIT_DATE__: JSON.stringify(git(['log', '-1', '--format=%cs'])),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  optimizeDeps: {
    exclude: ['h5wasm'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    fs: { allow: ['..'] },
  },
})
