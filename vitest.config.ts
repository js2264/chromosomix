import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    /**
     * `node` by default, and jsdom **per file**.
     *
     * Most of what is worth asserting here is arithmetic — a range query, an
     * axis, a bin conversion, the shape of a view state — and a DOM under those
     * is a second of startup per file bought for nothing. A file that needs one
     * asks for it in its own docblock:
     *
     * ```ts
     * // @vitest-environment jsdom
     * ```
     *
     * and calls `setUpDom()` from `test/support/dom.ts`, which is where the
     * canvas answer and the mounting helpers live.
     */
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    /**
     * Coverage, when a run asks for it (`--coverage`, or `npm run
     * test:coverage`), over **the whole app** rather than over whatever the
     * tests happened to import: every file under `src/` and the desktop main
     * process under `electron/` is counted, and one no test loads counts at
     * zero. A figure measured only over the files a suite touches is the
     * suite's opinion of itself.
     *
     * Left out are the `*.generated.ts` files, which are data — icons, logos
     * and WebAssembly as base64 — and would only dilute the figure with
     * statements nobody writes.
     *
     * The numbers are V8's, for the thread the test file runs in: code a test
     * runs in another thread or process — a Worker, a built bundle, a child
     * process — is not counted, however thoroughly it is exercised there.
     *
     * Written to `coverage/` unless `COVERAGE_DIR` names another directory,
     * which `scripts/coverage-summary.mjs` reads too. That is for a checkout in
     * a folder a sync client watches: V8 writes one file per test file into
     * `.tmp/` and reads it back at the end, and a client that renames them into
     * conflicted copies in between fails the report on the first one missing.
     */
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,js}', 'electron/**/*.cts'],
      // Named because vitest's own list has `.mts` but not `.cts`, and without
      // it the `include` above drops the main process without a word.
      extension: ['.ts', '.js', '.cts'],
      exclude: ['**/*.generated.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: process.env.COVERAGE_DIR || 'coverage',
      reportOnFailure: true,
    },
  },
})
