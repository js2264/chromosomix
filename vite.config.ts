import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

// GitHub Pages serves the app from a sub-path; override with BASE_PATH at build
// time. `h5wasm` ships a .wasm asset that must not be inlined or renamed, so it
// is excluded from dependency pre-bundling.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
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
