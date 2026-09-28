/*
 * Boost-HiC's one cubic loop — Floyd–Warshall — for WebAssembly with SIMD.
 *
 * Oversampling a map (§6.5) replaces every distance between two bins of a
 * sequence by the shortest path between them (`metacooler/boost.ts`): for each
 * bin `k`, every row `i` takes `min(d[i][j], d[i][k] + d[k][j])` across `j`. That
 * is n³ additions and comparisons — four seconds of JavaScript for yeast's
 * chromosome IV at 1 kb, and every one of them the same two instructions on two
 * rows read in order, which is the loop a vector unit is for.
 *
 * Built by `npm run wasm:floyd` (`scripts/build-floyd-wasm.mjs`) into
 * `floyd.generated.ts`, which is committed: the app needs no C toolchain, only
 * whoever changes this file does. A unit test checks the generated module was
 * built from this exact source.
 *
 * **The same numbers as the JavaScript loop, bit for bit.** One addition per
 * cell, no fused multiply-add, and `pmin` — `b < a ? b : a`, lane by lane —
 * which is the JavaScript `if (path < cell) cell = path` exactly, ties included.
 * So the two workers, the command line and the golden against Boost-HiC's
 * Python agree whichever of the two ran.
 *
 * **In place.** At step `k` neither row `k` nor column `k` can shorten, because
 * `d[k][k]` is positive; so reading row `k` while other rows are written is
 * reading its final value, as the step-by-step copy numpy makes would.
 */

#include <wasm_simd128.h>

/*
 * Steps `k0` to `k1` of Floyd–Warshall on the `n × n` row-major matrix of
 * doubles at `d`. Called a slice of `k` at a time so the caller can report
 * progress between slices.
 */
__attribute__((export_name("floyd")))
void floyd(double *d, int n, int k0, int k1) {
  for (int k = k0; k < k1; k++) {
    const double *row_k = d + (long)k * n;
    for (int i = 0; i < n; i++) {
      double *row_i = d + (long)i * n;
      const double via_k = row_i[k];
      /* No edge to `k` at all: nothing through it can be shorter. */
      if (via_k == __builtin_inf()) continue;
      const v128_t via = wasm_f64x2_splat(via_k);
      int j = 0;
      for (; j + 8 <= n; j += 8) {
        v128_t p0 = wasm_f64x2_add(via, wasm_v128_load(row_k + j));
        v128_t p1 = wasm_f64x2_add(via, wasm_v128_load(row_k + j + 2));
        v128_t p2 = wasm_f64x2_add(via, wasm_v128_load(row_k + j + 4));
        v128_t p3 = wasm_f64x2_add(via, wasm_v128_load(row_k + j + 6));
        wasm_v128_store(row_i + j, wasm_f64x2_pmin(wasm_v128_load(row_i + j), p0));
        wasm_v128_store(row_i + j + 2, wasm_f64x2_pmin(wasm_v128_load(row_i + j + 2), p1));
        wasm_v128_store(row_i + j + 4, wasm_f64x2_pmin(wasm_v128_load(row_i + j + 4), p2));
        wasm_v128_store(row_i + j + 6, wasm_f64x2_pmin(wasm_v128_load(row_i + j + 6), p3));
      }
      for (; j < n; j++) {
        const double path = via_k + row_k[j];
        if (path < row_i[j]) row_i[j] = path;
      }
    }
  }
}
