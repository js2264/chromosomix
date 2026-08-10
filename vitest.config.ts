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
  },
})
