/*
 * The one hot loop of a correlation matrix, for WebAssembly with SIMD.
 *
 * Pearson's r between every pair of rows of an m × m square is m²/2 dot products
 * of m cells each — the only cubic step in the viewer (§18.6). Everything else
 * about the correlation is arithmetic on a few numbers per pair, and lives in
 * `analysis/pearsonRows.ts`; these two functions are the m³ part of it, and they
 * are here rather than in TypeScript because the same loop written in JS runs
 * at a sixth of the speed: JS has no vector arithmetic, and reading a
 * `Float32Array` costs a conversion per element.
 *
 * Built by `npm run wasm` (`scripts/build-gram-wasm.mjs`) into
 * `gram.generated.ts`, which is committed: the app needs no C toolchain, only
 * whoever changes this file does. A unit test checks the generated module was
 * built from this exact source.
 *
 * **What is computed.** Both functions add, for every row `a` in `[a0, a1)` and
 * every column-row `b` in `[max(a, b0), b1)` — the upper triangle, since the
 * matrix is symmetric — the sum over `k` in `[k0, k1)` of products of the two
 * rows' cells into `band`, a block of output rows whose first is `g0`:
 *
 *     band[(a - g0) * ldg + b] += Σₖ A[a * ld + k] · B[b * ld + k]
 *
 * The caller walks `k` and `b` in blocks sized so the rows being multiplied stay
 * in cache (§18.6's numbers are in `pearsonRows.ts`), and a band at a time so the
 * output is never held whole here. Rows are `ld` floats apart, `ld` a multiple of
 * four, and the padding is zeros.
 *
 * **Precision.** The operands are `float` and each block of `k` is summed in
 * four `float` lanes, then added to the `double` band — so a sum is exact to
 * about 1e-7 of the magnitudes it adds up, over any `m`. A correlation made of it
 * agrees with one computed wholly in `double` to about the sixth decimal, which
 * is past anything a picture or an eigenvector can show.
 *
 * **Built twice.** Once with SIMD alone, and once with *relaxed* SIMD, whose
 * multiply-add may be fused — one instruction where the other build has two, a
 * quarter faster measured, and rounded once rather than twice. An engine that
 * has relaxed SIMD runs that build; one that does not (Safari's, at the time of
 * writing) runs the other. They differ only in `madd` below, and in the last
 * bits of a sum.
 */

#include <wasm_simd128.h>

/* acc + x·y, fused where the engine fuses it. */
#ifdef __wasm_relaxed_simd__
#define madd(acc, x, y) wasm_f32x4_relaxed_madd((x), (y), (acc))
#else
#define madd(acc, x, y) wasm_f32x4_add((acc), wasm_f32x4_mul((x), (y)))
#endif

static inline double sum4(v128_t v) {
  return (double)wasm_f32x4_extract_lane(v, 0) + (double)wasm_f32x4_extract_lane(v, 1) +
         (double)wasm_f32x4_extract_lane(v, 2) + (double)wasm_f32x4_extract_lane(v, 3);
}

/*
 * The plain product: every cell a value, a missing one written as zero.
 *
 * Two rows of `A` against four of `B` at a time — eight sums in eight vector
 * registers, and six loads feeding them — which is as many as fit beside their
 * operands without spilling on a 16-register machine.
 */
__attribute__((export_name("gram")))
void gram(const float *A, const float *B, int ld, double *band, int ldg, int g0,
          int a0, int a1, int b0, int b1, int k0, int k1) {
  for (int a = a0; a < a1; a += 2) {
    int ar = (a + 1 < a1) ? a + 1 : a;
    const float *pa0 = A + (long)a * ld, *pa1 = A + (long)ar * ld;
    double *out0 = band + (long)(a - g0) * ldg, *out1 = band + (long)(ar - g0) * ldg;
    for (int b = (b0 > a ? b0 : a); b < b1; b += 4) {
      int b1r = (b + 1 < b1) ? b + 1 : b, b2r = (b + 2 < b1) ? b + 2 : b, b3r = (b + 3 < b1) ? b + 3 : b;
      const float *pb0 = B + (long)b * ld, *pb1 = B + (long)b1r * ld;
      const float *pb2 = B + (long)b2r * ld, *pb3 = B + (long)b3r * ld;
      v128_t c00 = wasm_f32x4_splat(0), c01 = c00, c02 = c00, c03 = c00;
      v128_t c10 = c00, c11 = c00, c12 = c00, c13 = c00;
      int k = k0;
      for (; k + 3 < k1; k += 4) {
        v128_t x0 = wasm_v128_load(pa0 + k), x1 = wasm_v128_load(pa1 + k);
        v128_t y0 = wasm_v128_load(pb0 + k), y1 = wasm_v128_load(pb1 + k);
        v128_t y2 = wasm_v128_load(pb2 + k), y3 = wasm_v128_load(pb3 + k);
        c00 = madd(c00, x0, y0);
        c01 = madd(c01, x0, y1);
        c02 = madd(c02, x0, y2);
        c03 = madd(c03, x0, y3);
        c10 = madd(c10, x1, y0);
        c11 = madd(c11, x1, y1);
        c12 = madd(c12, x1, y2);
        c13 = madd(c13, x1, y3);
      }
      double s00 = sum4(c00), s01 = sum4(c01), s02 = sum4(c02), s03 = sum4(c03);
      double s10 = sum4(c10), s11 = sum4(c11), s12 = sum4(c12), s13 = sum4(c13);
      for (; k < k1; k++) {
        double x0 = pa0[k], x1 = pa1[k];
        s00 += x0 * pb0[k]; s01 += x0 * pb1[k]; s02 += x0 * pb2[k]; s03 += x0 * pb3[k];
        s10 += x1 * pb0[k]; s11 += x1 * pb1[k]; s12 += x1 * pb2[k]; s13 += x1 * pb3[k];
      }
      out0[b] += s00;
      if (b1r != b) out0[b1r] += s01;
      if (b2r != b) out0[b2r] += s02;
      if (b3r != b) out0[b3r] += s03;
      if (ar != a) {
        out1[b] += s10;
        if (b1r != b) out1[b1r] += s11;
        if (b2r != b) out1[b2r] += s12;
        if (b3r != b) out1[b3r] += s13;
      }
    }
  }
}

/*
 * The masked product: a missing cell written as NaN, and all six sums a
 * pairwise-complete Pearson needs taken over the cells *both* rows have.
 *
 * For a square where most rows are missing whole stretches — a trans-only
 * compartment run, which masks every sequence's own block — the corrections the
 * plain product is followed by would cost as much as the product. Here the
 * six are summed in one pass instead, each lane's NaN test deciding what it
 * adds: the pair's products, how many cells they share, and each row's sum and
 * sum of squares over the cells the other row has. Six output bands, in the
 * order `p, n, sa, sb, qa, qb`, `size` doubles apart.
 *
 * One row against one: six accumulators and the operands of both rows are all
 * the registers there are.
 */
__attribute__((export_name("gram_masked")))
void gram_masked(const float *X, int ld, double *band, int ldg, int size, int g0,
                 int a0, int a1, int b0, int b1, int k0, int k1) {
  const v128_t one = wasm_f32x4_splat(1.0f);
  for (int a = a0; a < a1; a++) {
    const float *pa = X + (long)a * ld;
    double *out = band + (long)(a - g0) * ldg;
    for (int b = (b0 > a ? b0 : a); b < b1; b++) {
      const float *pb = X + (long)b * ld;
      v128_t p = wasm_f32x4_splat(0), n = p, sa = p, sb = p, qa = p, qb = p;
      int k = k0;
      for (; k + 3 < k1; k += 4) {
        v128_t va = wasm_v128_load(pa + k), vb = wasm_v128_load(pb + k);
        v128_t ma = wasm_f32x4_eq(va, va), mb = wasm_f32x4_eq(vb, vb);
        v128_t xa = wasm_v128_and(va, ma), xb = wasm_v128_and(vb, mb);
        v128_t both = wasm_v128_and(ma, mb);
        v128_t ya = wasm_v128_and(xa, mb), yb = wasm_v128_and(xb, ma);
        p = madd(p, xa, xb);
        n = wasm_f32x4_add(n, wasm_v128_and(one, both));
        sa = wasm_f32x4_add(sa, ya);
        sb = wasm_f32x4_add(sb, yb);
        qa = madd(qa, ya, ya);
        qb = madd(qb, yb, yb);
      }
      double sp = sum4(p), sn = sum4(n), ssa = sum4(sa), ssb = sum4(sb), sqa = sum4(qa), sqb = sum4(qb);
      for (; k < k1; k++) {
        float x = pa[k], y = pb[k];
        if (x != x || y != y) continue;
        sp += (double)x * y; sn += 1; ssa += x; ssb += y; sqa += (double)x * x; sqb += (double)y * y;
      }
      out[b] += sp;
      out[size + b] += sn;
      out[2 * size + b] += ssa;
      out[3 * size + b] += ssb;
      out[4 * size + b] += sqa;
      out[5 * size + b] += sqb;
    }
  }
}
