/*
 * yapc's scan of one sequence, a window at a time, for WebAssembly with SIMD.
 *
 * Everything `analysis/run/peaks.ts` does to a window between reading it and
 * the next: the track's intervals cut into pieces (`runsOver`), the tracks'
 * mean (`pooledRuns`), its smoothed second derivative and flat mask
 * (`convolveSame`), where that is concave (`concaveMask`), each track's own
 * second derivative there, and the edges, summits and scores of the concave
 * regions (`ConcaveScan.feed`). It is the same arithmetic as those functions, in
 * their order, and gives the same numbers bit for bit — a test holds the two to
 * that on every case a window can be in — so it is a second home for that code
 * rather than another method: the TypeScript stays, as the reference and as what
 * runs on an engine without SIMD. It is here because the same loops in
 * JavaScript run at a third of the speed, and the convolution alone was
 * seven-tenths of a genome-wide call (§18.8).
 *
 * Built by `npm run wasm:yapc` (`scripts/build-yapc-wasm.mjs`) into
 * `yapc.generated.ts`, which is committed: the app needs no C toolchain, only
 * whoever changes this file does. A unit test checks the generated module was
 * built from this exact source.
 *
 * **One instance, one sequence.** The scan's state is this module's globals, so
 * each sequence is scanned by an instance of its own (`analysis/yapcKernel.ts`),
 * and two calls running at once in one worker never share one. The memory is
 * laid out here, from `__heap_base`, and grown as it is needed; what a window
 * needs is fixed by the window's size and taken once, and only two things grow
 * after that — a track's raw intervals, should a window hold more than it has
 * bases, and the values held for the open region, which a stretch of flat
 * signal megabases long makes large.
 *
 * **Exactly, and how.** Every double here is an IEEE operation the TypeScript
 * also does, in its order: `-ffp-contract=off`, and no relaxed SIMD, so nothing
 * is fused into a multiply-add that rounds once. The SIMD is across neighbouring
 * positions of the convolution — two outputs per `f64x2`, each lane doing what
 * the scalar loop does to one output — and never across the terms of one, whose
 * order is what fixes its last place. `Math.fround` is a conversion to `float`,
 * which rounds to nearest even as it does.
 */

#include <stdint.h>
#include <wasm_simd128.h>

#define MAX_TRACKS 8
#define PAGE 65536u

/* `find_concave_regions_chrom`'s `tol` (`CONCAVE_TOLERANCE`). */
#define TOLERANCE 1e-10

/* Status codes `scan_window` and `scan_finish` return below zero. */
#define NO_MEMORY -1
#define OUT_OF_ORDER -2
#define UNCOVERED -3

#define R __restrict__

extern unsigned char __heap_base;

/* ------------------------------------------------------------------------- */
/* Memory                                                                    */
/* ------------------------------------------------------------------------- */

/* The first free byte. Nothing is freed: what a window needs is taken once. */
static uint32_t top;

/* `bytes` more, 16-byte aligned, the memory grown to hold them; 0 where it cannot be. */
static void *grab(uint64_t bytes) {
  const uint64_t at = ((uint64_t)top + 15u) & ~(uint64_t)15u;
  const uint64_t end = at + bytes;
  if (end > 0xffff0000u) return 0;
  const uint64_t have = (uint64_t)__builtin_wasm_memory_size(0) * PAGE;
  if (end > have) {
    const uint64_t pages = (end - have + PAGE - 1) / PAGE;
    if (__builtin_wasm_memory_grow(0, (uint32_t)pages) == (uint32_t)-1) return 0;
  }
  top = (uint32_t)end;
  return (void *)(uintptr_t)at;
}

/* ------------------------------------------------------------------------- */
/* The state of one sequence's scan                                          */
/* ------------------------------------------------------------------------- */

static int32_t tracks, taps, centre, length, window, pieceCap;
/* The kernel, then its running total: `K[taps]`, `C[taps + 1]`. */
static double *K, *C;

/* Each track's intervals as the window read them, values first for alignment. */
static double *rawValues[MAX_TRACKS];
static int32_t *rawStarts[MAX_TRACKS], *rawEnds[MAX_TRACKS];
static int32_t rawCount[MAX_TRACKS], rawCap[MAX_TRACKS];

/* Pieces: one set per track, and the pooled track's (`MAX_TRACKS`). */
static int32_t *pieceStarts[MAX_TRACKS + 1], *pieceEnds[MAX_TRACKS + 1];
static double *pieceValues[MAX_TRACKS + 1];
static int32_t pieceCount[MAX_TRACKS + 1];

/* Second derivatives over the window: the pooled track's, then each track's own. */
static double *pooled, *own[MAX_TRACKS];
static uint8_t *flat, *concave;

/* The regions closed by the last call, for the caller to take. */
static double *regionScores; /* track t's score of region i at [t * regionCap + i] */
static int32_t *regionStarts, *regionEnds, *regionModes;
static uint8_t *regionFlats;
static int32_t regionCap, regionCount;

/* `ConcaveScan`'s state. */
static int32_t position, open, previous, rose, openFlat, ties;
static double best;
static uint8_t absent[MAX_TRACKS];
/* The open region's values, position by position: each track's own second
 * derivative, then minus the pooled one in float32 — `tracks + 1` doubles each. */
static double *held;
static uint32_t heldLength, heldCap;

/* ------------------------------------------------------------------------- */
/* Pieces (`runsOver`) and their mean (`pooledRuns`)                         */
/* ------------------------------------------------------------------------- */

/* `sameValue`: the same number, or both missing. */
static inline int same_value(double a, double b) { return a == b || (a != a && b != b); }

/* `piece` of `runsOver`: abutting pieces of one value are one. */
static inline int32_t piece(int32_t *R s, int32_t *R e, double *R v, int32_t n, int32_t start, int32_t end,
                            double value) {
  if (n > 0 && e[n - 1] == start && same_value(v[n - 1], value)) {
    e[n - 1] = end;
    return n;
  }
  s[n] = start;
  e[n] = end;
  v[n] = value;
  return n + 1;
}

/* `runsOver`: the pieces of `[from, to)` the intervals describe, `NaN` where none does. */
static int32_t runs_over(int32_t t, int32_t from, int32_t to) {
  int32_t *R s = pieceStarts[t];
  int32_t *R e = pieceEnds[t];
  double *R v = pieceValues[t];
  const int32_t *R starts = rawStarts[t];
  const int32_t *R ends = rawEnds[t];
  const double *R values = rawValues[t];
  int32_t n = 0, at = from;
  for (int32_t i = 0; i < rawCount[t] && at < to; i++) {
    const int32_t start = starts[i] > at ? starts[i] : at;
    const int32_t end = ends[i] < to ? ends[i] : to;
    if (end <= start) continue;
    if (start > at) n = piece(s, e, v, n, at, start, __builtin_nan(""));
    n = piece(s, e, v, n, start, end, values[i]);
    at = end;
  }
  if (at < to) n = piece(s, e, v, n, at, to, __builtin_nan(""));
  return n;
}

/* `pooledRuns` for two tracks or more: their mean, added in order, as float32. */
static int32_t pooled_runs(int32_t from, int32_t to) {
  int32_t *R s = pieceStarts[MAX_TRACKS];
  int32_t *R e = pieceEnds[MAX_TRACKS];
  double *R v = pieceValues[MAX_TRACKS];
  int32_t cursor[MAX_TRACKS];
  for (int32_t t = 0; t < tracks; t++) cursor[t] = 0;
  int32_t n = 0, at = from;
  while (at < to) {
    int32_t next = to;
    double total = 0;
    for (int32_t t = 0; t < tracks; t++) {
      const int32_t *ends = pieceEnds[t];
      while (cursor[t] < pieceCount[t] && ends[cursor[t]] <= at) cursor[t]++;
      const int32_t r = cursor[t];
      if (r >= pieceCount[t] || pieceStarts[t][r] > at) return UNCOVERED;
      total += pieceValues[t][r];
      if (ends[r] < next) next = ends[r];
    }
    const double value = (double)(float)(total / (double)tracks);
    if (n > 0 && same_value(v[n - 1], value)) e[n - 1] = next;
    else {
      s[n] = at;
      e[n] = next;
      v[n] = value;
      n++;
    }
    at = next;
  }
  return n;
}

/* ------------------------------------------------------------------------- */
/* The convolution (`convolveSame`, `addTerms`)                              */
/* ------------------------------------------------------------------------- */

/* o[i] += v * (a[i] - b[i]) */
static inline void span_diff(double *R o, const double *R a, const double *R b, double v, int32_t n) {
  int32_t i = 0;
  const v128_t vv = wasm_f64x2_splat(v);
  for (; i + 4 <= n; i += 4) {
    const v128_t d0 = wasm_f64x2_sub(wasm_v128_load(a + i), wasm_v128_load(b + i));
    const v128_t d1 = wasm_f64x2_sub(wasm_v128_load(a + i + 2), wasm_v128_load(b + i + 2));
    wasm_v128_store(o + i, wasm_f64x2_add(wasm_v128_load(o + i), wasm_f64x2_mul(vv, d0)));
    wasm_v128_store(o + i + 2, wasm_f64x2_add(wasm_v128_load(o + i + 2), wasm_f64x2_mul(vv, d1)));
  }
  for (; i < n; i++) o[i] += v * (a[i] - b[i]);
}

/* o[i] += v * (a[i] - c) */
static inline void span_less(double *R o, const double *R a, double c, double v, int32_t n) {
  int32_t i = 0;
  const v128_t vv = wasm_f64x2_splat(v), cc = wasm_f64x2_splat(c);
  for (; i + 2 <= n; i += 2) {
    const v128_t d = wasm_f64x2_sub(wasm_v128_load(a + i), cc);
    wasm_v128_store(o + i, wasm_f64x2_add(wasm_v128_load(o + i), wasm_f64x2_mul(vv, d)));
  }
  for (; i < n; i++) o[i] += v * (a[i] - c);
}

/* o[i] += v * (c - b[i]) */
static inline void span_from(double *R o, double c, const double *R b, double v, int32_t n) {
  int32_t i = 0;
  const v128_t vv = wasm_f64x2_splat(v), cc = wasm_f64x2_splat(c);
  for (; i + 2 <= n; i += 2) {
    const v128_t d = wasm_f64x2_sub(cc, wasm_v128_load(b + i));
    wasm_v128_store(o + i, wasm_f64x2_add(wasm_v128_load(o + i), wasm_f64x2_mul(vv, d)));
  }
  for (; i < n; i++) o[i] += v * (c - b[i]);
}

/* o[i] += v * k[i] */
static inline void span_taps(double *R o, const double *R k, double v, int32_t n) {
  int32_t i = 0;
  const v128_t vv = wasm_f64x2_splat(v);
  for (; i + 2 <= n; i += 2) {
    wasm_v128_store(o + i, wasm_f64x2_add(wasm_v128_load(o + i), wasm_f64x2_mul(vv, wasm_v128_load(k + i))));
  }
  for (; i < n; i++) o[i] += v * k[i];
}

/* o[i] += term */
static inline void span_add(double *R o, double term, int32_t n) {
  int32_t i = 0;
  const v128_t tt = wasm_f64x2_splat(term);
  for (; i + 2 <= n; i += 2) wasm_v128_store(o + i, wasm_f64x2_add(wasm_v128_load(o + i), tt));
  for (; i < n; i++) o[i] += term;
}

/*
 * `addTerms`: every piece's term added to each position of `[p, q)` whose window
 * it meets, piece by piece, into `out` (position `from` at index 0). The four
 * stretches of anchors a piece reaches, and why the term in each is the one the
 * overlap always gave, are in `analysis/yapc.ts`.
 */
static void add_terms(int32_t set, int32_t p, int32_t q, double *R out, int32_t from) {
  const int32_t *R starts = pieceStarts[set];
  const int32_t *R ends = pieceEnds[set];
  const double *R level = pieceValues[set];
  const int32_t n = pieceCount[set];
  const int32_t first = p + centre + 1;
  const int32_t last = q + centre;
  const int32_t shift = -(centre + 1) - from;
  int32_t r = 0, hi = n;
  while (r < hi) {
    const int32_t mid = (int32_t)(((uint32_t)r + (uint32_t)hi) >> 1);
    if (ends[mid] > first - taps) hi = mid;
    else r = mid + 1;
  }
  const double C0 = C[0];
  const double sum = C[taps];
  for (; r < n; r++) {
    const int32_t S = starts[r];
    if (S + 1 > last) break;
    const int32_t E = ends[r];
    const double v = level[r];
    /* 1 · s = S, e = a. */
    int32_t a0 = S + 1 > first ? S + 1 : first;
    int32_t a1 = E - 1 < S + taps ? E - 1 : S + taps;
    if (a1 > last) a1 = last;
    if (a0 <= a1) {
      int32_t a = a0;
      if (a == S + 1) {
        out[shift + a] += v * K[0];
        a++;
      }
      if (a <= a1) span_less(out + shift + a, C + (a - S), C0, v, a1 - a + 1);
    }
    /* 2 · s = S, e = E. */
    a0 = E > first ? E : first;
    a1 = S + taps < last ? S + taps : last;
    if (a0 <= a1) {
      if (E - S == 1) span_taps(out + shift + a0, K + (a0 - 1 - S), v, a1 - a0 + 1);
      else span_diff(out + shift + a0, C + (a0 - S), C + (a0 - E), v, a1 - a0 + 1);
    }
    /* 3 · s = a − taps, e = a: one term throughout. */
    a0 = S + taps + 1 > first ? S + taps + 1 : first;
    a1 = E - 1 < last ? E - 1 : last;
    if (a0 <= a1) span_add(out + shift + a0, v * (sum - C0), a1 - a0 + 1);
    /* 4 · s = a − taps, e = E, one base wide at the last anchor. */
    a0 = E > S + taps + 1 ? E : S + taps + 1;
    if (a0 < first) a0 = first;
    const int32_t single = E + taps - 1;
    a1 = single < last ? single : last;
    if (a0 <= a1) {
      const int32_t end = a1 == single ? a1 - 1 : a1;
      if (end >= a0) span_from(out + shift + a0, sum, C + (a0 - E), v, end - a0 + 1);
      if (a1 == single) out[shift + single] += v * K[taps - 1];
    }
  }
}

/* `convolveSame` of a set of pieces over `[from, to)`, with its flat mask where asked
 * for, and only where `only` is 1 where it is given — `NaN` elsewhere. */
static void convolve(int32_t set, int32_t from, int32_t to, double *R out, uint8_t *R flatOut,
                     const uint8_t *R only) {
  const int32_t length_ = to - from;
  for (int32_t k = 0; k < length_; k++) out[k] = 0;
  if (only == 0) add_terms(set, from, to, out, from);
  else {
    int32_t at = 0;
    while (at < length_) {
      int32_t start = at;
      while (start < length_ && only[start] != 1) out[start++] = __builtin_nan("");
      if (start == length_) break;
      int32_t end = start + 1;
      while (end < length_ && only[end] == 1) end++;
      add_terms(set, from + start, from + end, out, from);
      at = end;
    }
  }
  if (flatOut != 0) {
    for (int32_t k = 0; k < length_; k++) flatOut[k] = 0;
    const int32_t *starts = pieceStarts[set];
    const int32_t *ends = pieceEnds[set];
    for (int32_t r = 0; r < pieceCount[set]; r++) {
      int32_t a = starts[r] - centre + taps - 1;
      int32_t b = ends[r] - centre - 1;
      if (a < from) a = from;
      if (b > to - 1) b = to - 1;
      for (int32_t i = a; i <= b; i++) flatOut[i - from] = 1;
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Concave regions (`ConcaveScan`)                                           */
/* ------------------------------------------------------------------------- */

/* `numpySum`: numpy's pairwise sum, over every `stride`-th value. */
static double pairwise(const double *R a, uint32_t stride, uint32_t n) {
  if (n < 8) {
    double total = 0;
    for (uint32_t i = 0; i < n; i++) total += a[i * stride];
    return total;
  }
  if (n <= 128) {
    double r0 = a[0], r1 = a[stride], r2 = a[2 * stride], r3 = a[3 * stride];
    double r4 = a[4 * stride], r5 = a[5 * stride], r6 = a[6 * stride], r7 = a[7 * stride];
    uint32_t i = 8;
    for (; i < n - (n % 8); i += 8) {
      const double *at = a + i * stride;
      r0 += at[0];
      r1 += at[stride];
      r2 += at[2 * stride];
      r3 += at[3 * stride];
      r4 += at[4 * stride];
      r5 += at[5 * stride];
      r6 += at[6 * stride];
      r7 += at[7 * stride];
    }
    double total = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
    for (; i < n; i++) total += a[i * stride];
    return total;
  }
  uint32_t half = n / 2;
  half -= half % 8;
  return pairwise(a, stride, half) + pairwise(a + half * stride, stride, n - half);
}

static void begin(int32_t at) {
  open = at;
  best = -__builtin_inf();
  ties = 0;
  heldLength = 0;
  openFlat = 0;
}

/* Room for one more position's values, the held block grown in place where it is
 * the last thing taken, and moved where it is not. */
static int hold_room(void) {
  if (heldLength < heldCap) return 1;
  const uint32_t width = (uint32_t)tracks + 1u;
  const uint64_t bytes = (uint64_t)heldCap * width * 8u;
  if ((uint32_t)(uintptr_t)held + (uint32_t)bytes == top && ((uint32_t)bytes & 15u) == 0) {
    if (grab(bytes) == 0) return 0;
  } else {
    double *moved = grab(2u * bytes);
    if (moved == 0) return 0;
    for (uint64_t i = 0; i < (uint64_t)heldLength * width; i++) moved[i] = held[i];
    held = moved;
  }
  heldCap *= 2;
  return 1;
}

/* A region from `open` to `at`: its summit — the middle of the positions where
 * minus the pooled second derivative is at its most — and each track's score. */
static int close(int32_t at) {
  if (regionCount >= regionCap) return NO_MEMORY;
  const uint32_t width = (uint32_t)tracks + 1u;
  int32_t mode = open;
  if (ties > 0) {
    const int32_t wanted = ties >> 1;
    int32_t seen = 0;
    for (uint32_t i = 0; i < heldLength; i++) {
      if (held[i * width + (uint32_t)tracks] == best) {
        if (seen == wanted) {
          mode = open + (int32_t)i;
          break;
        }
        seen++;
      }
    }
  }
  const int32_t i = regionCount++;
  regionStarts[i] = open;
  regionEnds[i] = at;
  regionModes[i] = mode;
  regionFlats[i] = (uint8_t)openFlat;
  for (int32_t t = 0; t < tracks; t++) {
    regionScores[t * regionCap + i] =
        absent[t] ? -__builtin_inf() : -(pairwise(held + t, width, heldLength) / (double)heldLength);
  }
  open = -1;
  return 0;
}

/* `ConcaveScan.feed` over `[from, from + n)`. */
static int feed(int32_t from, int32_t n) {
  if (from != position) return OUT_OF_ORDER;
  const uint32_t width = (uint32_t)tracks + 1u;
  for (int32_t k = 0; k < n; k++) {
    const int32_t at = from + k;
    const double d2 = (double)(float)pooled[k];
    const int is = d2 < TOLERANCE;
    if (at == 0) {
      if (is) begin(0);
    } else if (is && !previous) {
      rose = 1;
      begin(at);
    } else if (!is && previous) {
      const int status = close(at);
      if (status < 0) return status;
    }
    if (is) {
      const double value = -d2;
      if (value > best) {
        best = value;
        ties = 1;
      } else if (value == best) {
        ties++;
      }
      if (!hold_room()) return NO_MEMORY;
      double *slot = held + (uint64_t)heldLength * width;
      for (int32_t t = 0; t < tracks; t++) slot[t] = own[t][k];
      slot[tracks] = value;
      heldLength++;
      if (flat[k] == 1) openFlat = 1;
    }
    previous = is;
  }
  position = from + n;
  return 0;
}

/* ------------------------------------------------------------------------- */
/* What the caller calls                                                     */
/* ------------------------------------------------------------------------- */

/* Set up the scan of one sequence: the memory a window of `window_` positions
 * needs, and room for the kernel — `scan_kernel` says where to write it. 0, or
 * NO_MEMORY. */
__attribute__((export_name("scan_open")))
int32_t scan_open(int32_t tracks_, int32_t taps_, int32_t centre_, int32_t length_, int32_t window_) {
  if (tracks_ < 1 || tracks_ > MAX_TRACKS) return NO_MEMORY;
  top = (uint32_t)(uintptr_t)&__heap_base;
  tracks = tracks_;
  taps = taps_;
  centre = centre_;
  length = length_;
  window = window_;
  /* A window and the kernel's reach each side: pieces are a base wide at least. */
  pieceCap = window + taps + 1;
  regionCap = window / 2 + 4;
  K = grab((uint64_t)(2 * taps + 1) * 8u);
  if (K == 0) return NO_MEMORY;
  C = K + taps;
  for (int32_t s = 0; s <= tracks; s++) {
    const int32_t at = s == tracks ? MAX_TRACKS : s;
    pieceValues[at] = grab((uint64_t)pieceCap * 8u);
    pieceStarts[at] = grab((uint64_t)pieceCap * 4u);
    pieceEnds[at] = grab((uint64_t)pieceCap * 4u);
    if (pieceValues[at] == 0 || pieceStarts[at] == 0 || pieceEnds[at] == 0) return NO_MEMORY;
  }
  pooled = grab((uint64_t)window * 8u);
  if (pooled == 0) return NO_MEMORY;
  for (int32_t t = 0; t < tracks; t++) {
    own[t] = tracks == 1 ? pooled : grab((uint64_t)window * 8u);
    /* As many intervals as bases, which disjoint ones cannot exceed. */
    rawValues[t] = grab((uint64_t)pieceCap * 16u);
    rawCap[t] = pieceCap;
    if (own[t] == 0 || rawValues[t] == 0) return NO_MEMORY;
  }
  flat = grab((uint64_t)window);
  concave = grab((uint64_t)window);
  regionScores = grab((uint64_t)regionCap * (uint64_t)tracks * 8u);
  regionStarts = grab((uint64_t)regionCap * 4u);
  regionEnds = grab((uint64_t)regionCap * 4u);
  regionModes = grab((uint64_t)regionCap * 4u);
  regionFlats = grab((uint64_t)regionCap);
  if (flat == 0 || concave == 0 || regionScores == 0 || regionStarts == 0 || regionEnds == 0 ||
      regionModes == 0 || regionFlats == 0) {
    return NO_MEMORY;
  }
  heldCap = 1u << 14;
  held = grab((uint64_t)heldCap * (uint64_t)(tracks + 1) * 8u);
  if (held == 0) return NO_MEMORY;
  heldLength = 0;
  position = 0;
  open = -1;
  previous = 0;
  rose = 0;
  openFlat = 0;
  ties = 0;
  best = -__builtin_inf();
  regionCount = 0;
  return 0;
}

/* Where the kernel goes: its `taps` values, then its `taps + 1` running totals. */
__attribute__((export_name("scan_kernel")))
double *scan_kernel(void) { return K; }

/* Room for `count` intervals of track `t`, and where they go: `count` values
 * (double), then `count` starts and `count` ends (int32). 0 where there is none. */
__attribute__((export_name("scan_input")))
double *scan_input(int32_t t, int32_t count) {
  if (t < 0 || t >= tracks || count < 0) return 0;
  if (count > rawCap[t]) {
    int32_t cap = rawCap[t];
    while (cap < count) cap *= 2;
    double *block = grab((uint64_t)cap * 16u);
    if (block == 0) return 0;
    rawValues[t] = block;
    rawCap[t] = cap;
  }
  rawCount[t] = count;
  rawStarts[t] = (int32_t *)(rawValues[t] + count);
  rawEnds[t] = rawStarts[t] + count;
  return rawValues[t];
}

/* One window, `[from, to)`, read over `[lo, hi)`: bit `t` of `absentTracks` set
 * for a track without this sequence, which reads as zeros. The regions it closed
 * are in `scan_regions`; their number, or a status below zero. */
__attribute__((export_name("scan_window")))
int32_t scan_window(int32_t from, int32_t to, int32_t lo, int32_t hi, int32_t absentTracks) {
  if (to - from > window || hi - lo + 1 > pieceCap) return NO_MEMORY;
  regionCount = 0;
  for (int32_t t = 0; t < tracks; t++) {
    absent[t] = (uint8_t)((absentTracks >> t) & 1);
    if (absent[t]) {
      /* `zeroRuns`. */
      pieceStarts[t][0] = lo;
      pieceEnds[t][0] = hi;
      pieceValues[t][0] = 0;
      pieceCount[t] = 1;
    } else {
      pieceCount[t] = runs_over(t, lo, hi);
    }
  }
  int32_t pooledSet = 0;
  if (tracks > 1) {
    const int32_t n = pooled_runs(lo, hi);
    if (n < 0) return n;
    pieceCount[MAX_TRACKS] = n;
    pooledSet = MAX_TRACKS;
  }
  convolve(pooledSet, from, to, pooled, flat, 0);
  if (tracks > 1) {
    for (int32_t k = 0; k < to - from; k++) concave[k] = (double)(float)pooled[k] < TOLERANCE;
    for (int32_t t = 0; t < tracks; t++) convolve(t, from, to, own[t], 0, concave);
  }
  const int status = feed(from, to - from);
  return status < 0 ? status : regionCount;
}

/* The end of the sequence: the region open there closed at its last base. The
 * number of regions that closes, in `scan_regions`, or a status below zero. */
__attribute__((export_name("scan_finish")))
int32_t scan_finish(void) {
  regionCount = 0;
  if (open >= 0) {
    const int status = close(length);
    if (status < 0) return status;
  }
  return regionCount;
}

/* Whether a rising edge was ever seen: without one, yapc reports no regions. */
__attribute__((export_name("scan_rose")))
int32_t scan_rose(void) { return rose; }

/* The regions the last call closed: track `t`'s score of region `i` at
 * `[t * scan_region_capacity() + i]`. */
__attribute__((export_name("scan_regions")))
double *scan_regions(void) { return regionScores; }

/* Their starts, ends, summits and flat flags, by region. */
__attribute__((export_name("scan_region_starts")))
int32_t *scan_region_starts(void) { return regionStarts; }

__attribute__((export_name("scan_region_ends")))
int32_t *scan_region_ends(void) { return regionEnds; }

__attribute__((export_name("scan_region_modes")))
int32_t *scan_region_modes(void) { return regionModes; }

__attribute__((export_name("scan_region_flats")))
uint8_t *scan_region_flats(void) { return regionFlats; }

__attribute__((export_name("scan_region_capacity")))
int32_t scan_region_capacity(void) { return regionCap; }

/* The last window's pooled second derivative and flat mask, and track `t`'s own
 * second derivative — `NaN` where the pooled one is not concave — for the tests
 * that hold them to the TypeScript's. */
__attribute__((export_name("scan_pooled")))
double *scan_pooled(void) { return pooled; }

__attribute__((export_name("scan_flat")))
uint8_t *scan_flat(void) { return flat; }

__attribute__((export_name("scan_own")))
double *scan_own(int32_t t) { return t >= 0 && t < tracks ? own[t] : 0; }
