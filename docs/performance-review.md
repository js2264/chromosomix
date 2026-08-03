# Performance review

A measured audit of every size guard, cap and hot loop in the viewer, against one
question: **does this refusal protect the hardware, or does it protect the
experience?** Where it is the second, the app is refusing pictures the machine
can draw.

Every number below is arithmetic over the code as written, or measured. Timings
come from one core of a 4-core x86-64 Linux box on Node 22.22 / V8 12.4 — the
same engine family a Chrome tab runs, single-threaded, which is what the
rasteriser is. Runtime facts about h5wasm were probed against the installed
`h5wasm@0.10.3`, not assumed.

---

## 1. Verdict

1. **The browser dense guard measures the browser, not the machine.**
   `navigator.deviceMemory` is Chromium-only — Firefox and Safari return
   `undefined`, so `deviceDenseBudgetBytes()` falls back to 4 GiB and budgets
   **1.43 GB** on a 4 GB Chromebook and on a 128 GB Mac Studio alike. On
   Chromium the property is capped at 8, so a 64 GB workstation also budgets
   **2.86 GB**.

2. **The dense block is not needed to draw the picture.** Every view is pooled
   to `RASTER_MAX_DIM = 4096` px per axis before it reaches a canvas. For a
   whole yeast genome at 500 bp that is a 4,054 × 4,054 raster — 66 MB — built
   from a 2,366 MB `Float32Array` whose only purpose is to be collapsed.
   Measured: accumulating the COO stream straight into the pooled raster costs
   **82 MB and 3.4 s**, against **2,370 MB and 6.8 s**, reading the same bytes.

3. **`OVERVIEW_MAX_UNITS = 2048` is not a hardware limit at genome level.** The
   accumulator it bounds is 34 MB at 2,048 and 154 MB at the reference file's
   4,395 genomes. It *is* load-bearing at contig level (154,468 contigs would be
   a 190 GB accumulator) — but truncation is the wrong answer there, because the
   picture is pooled to 4,096 rows regardless. What actually degrades at high N
   is not memory but the **per-frame divider stroking** (4,094 `stroke()` calls
   per frame at the cap) and the **cache-hostile mirror write** in the scan
   (measured 3.9 → 524 ns/pixel from N=256 to N=16,384).

4. **And the units it keeps are not the densest ones.** The selection statistic
   is `bin1_offset[hi] − bin1_offset[lo]`, which counts only pixels stored with
   the unit as `bin1`. Under `symmetric-upper` storage a unit late in bin order
   has nearly all of its inter-unit pixels stored against `bin2` and invisible
   to that difference, so the criterion systematically favours whatever comes
   first in the file. It is also a count, not a density — it is never divided by
   the unit's bin span, so it selects for length.

So: yes, the guards are stricter than the hardware requires; yes, 2048 can go
up. But the larger half of the answer is that the overview should **aggregate,
not truncate** — which drops nothing — and that the dense block should not be
materialised at all above the pooling threshold.

Two things run the other way and need *more* guarding than they have: the
**h5wasm 2 GiB wasm-heap ceiling** (§7), which is the app's one genuine hardware
wall and which no guard in the repo models; and `MIN_DENSE_BUDGET_BYTES`, which
grants a 256 MB device a 1 GB budget (§3).

---

## 2. The case in the brief: yeast micro-C, whole genome, 500 bp

### 2.1 The numbers

*S. cerevisiae* (sacCer3) is 12,157,105 bp across 17 sequences. At 500 bp,
summing `ceil(length / 500)` per sequence:

| | |
|---|---|
| bins | **24,322** |
| cells in the whole-genome block | 24,322² = **591,559,684** |
| dense values, `Float32` | **2,366 MB** |
| raster stride, `ceil(24322/4096)` | **6** |
| raster | 4,054 × 4,054 = 16.4 Mpx |
| pooled `Float32` + RGBA + canvas backing | 66 + 66 + 66 = **198 MB** |

### 2.2 What happens today

`WholeView.load()` → `matrix` → `readDenseMatrix` → two guards, in order.

**`checkDenseSize`** (`matrix.ts:66`) — Python's limit, 50,000² = 2.5e9 cells.
5.92e8 < 2.5e9, so it **passes**. Correct: this guard is a CLI-parity mirror and
has nothing to say here.

**`checkBrowserDenseSize`** (`matrix.ts:144`) — pessimistic first:

```
certain     = cells·4 + rasterPx·8 = 2.366e9 + 1.31e8       = 2.50 GB
pessimistic = certain + cells·4                             = 4.86 GB
```

against the budget:

| engine | `deviceMemory` | budget |
|---|---|---|
| Chrome, 16 GB laptop | 8 (capped) | 2.86 GB |
| Chrome, 64 GB workstation | 8 (**still** capped) | 2.86 GB |
| Firefox / Safari, any machine | `undefined` → 4 GiB fallback | **1.43 GB** |

4.86 GB exceeds every one, so the `nnz` rescue runs — `certain + nnz·20`:

| stored pixels | estimate | Chrome (2.86 GB) | Firefox/Safari (1.43 GB) |
|---|---|---|---|
| 1e7 (sparse) | 2.70 GB | allowed | **refused** |
| 5e7 | 3.50 GB | **refused** | **refused** |
| 1.5e8 (a deep micro-C) | 5.50 GB | **refused** | **refused** |

Note the third column. The `certain` term alone is 2.50 GB, so on Firefox and
Safari **no yeast whole-genome view at 500 bp can ever be allowed**, at any
sparsity, on any machine. The refusal is a property of the user agent.

### 2.3 What it would actually cost

Measured, replicating `poolDisplay`, `autoRangeOfDisplay` and `colorize`
verbatim on a synthetic contact map of the right shape:

| block | poolDisplay (log1p) | percentile | colorize | **first paint** |
|---|---|---|---|---|
| 4,600² (*E. coli* @ 1 kb) | 1,140 ms | 31 ms | 407 ms | 1.6 s |
| 12,100² (yeast @ 1 kb) | 2,208 ms | 134 ms | 392 ms | **2.7 s** |
| **24,322² (yeast @ 500 bp)** | **6,790 ms** | 159 ms | 443 ms | **7.4 s** |

The 12,100 row reproduces the 2,267 ms already recorded in `TODO.md` for the
same block — the check that this bench is measuring the real loop.

So the honest description of yeast @ 500 bp is **≈2.4 GB and about seven
seconds**, not "impossible". On a 16 GB machine that is a warning. On an 8 GB
machine it is genuinely marginal. On a 4 GB machine it should be refused. The
current guard cannot tell those apart, because its only signal reports `8` for
the first two and nothing at all whenever the user is not on Chrome.

### 2.4 The peak is larger than the estimate says

`estimateBlockBytes` charges **16 B per stored pixel** for the COO span, and
**8 B per raster pixel**. The code allocates more of both.

`readPixelSpan` (`matrix.ts:240`) reads the whole span with no chunking:

```ts
const bin1  = h.readNumeric('pixels/bin1_id', p0, p1)   // → Float64Array
const bin2  = h.readNumeric('pixels/bin2_id', p0, p1)   // → Float64Array
const count = h.readNumeric('pixels/count',   p0, p1)   // → Float64Array
return { bin1: Int32Array.from(bin1), bin2: Int32Array.from(bin2), count, ... }
```

Live simultaneously at the scatter:

```
bin1 f64 8 + bin2 f64 8 + count f64 8 + bin1 i32 4 + bin2 i32 4 = 32 B/pixel
```

and the raster term is `4` (pooled Float32) + `4` (RGBA) + `4` (canvas backing
store) = **12 B/px**, not 8.

At nnz = 5e7 the COO under-charge alone is **800 MB** against a 2.86 GB budget —
28 % of it. The estimate is wrong in the one direction a memory guard must not
be wrong.

**And it is charged against the wrong population entirely.** The estimate uses
`min(cells, nnz)`, but the read is the **whole row band** `[lo, hi)`, whose
stored-pixel count *P* is bounded by `nnz`, not by `cells`. A block on the
diagonal of a large file pulls in every pixel whose row bin falls in the band,
including all the ones whose column lies far outside the block. Worked example —
a 4,000-bin MAG in a file with `nnz = 1.2e9`, whose row band holds `P = 1e8`:

```
estimate : 4·C + 8·C + 20·min(C, nnz)  = 64 + 128 + 320 MB   =  512 MB   → passes
reality  : 4·C + 32·P (JS) + 8·P (wasm) = 64 MB + 3.20 GB + 0.80 GB = 4.06 GB
```

7.9× out, and the two are functions of different variables — so no constant
correction fixes it. `bin1_offset[lo]` and `bin1_offset[hi]` are two numbers and
the cheapest read in the file (`genomeDensity` already does exactly this), so
budgeting against the **real P** is both exact and cheaper than the
`datasetLength` call it would replace.

Three fixes, in order of value:

1. **Chunk the read**, as `scanPixels` already does. `scatterDense` is already
   per-pixel and additive, so it needs no change at all: iterate `p0..p1` in
   ~1e6-pixel windows and scatter each before reading the next. Peak drops from
   32·P to a constant ~32 MB, and the 2 GiB wasm ceiling (§7) leaves the picture.
2. **Narrow `bin1_id`/`bin2_id` straight from `BigInt64Array` to `Int32Array`.**
   Today they go int64 → `Float64Array` → `Int32Array`; the Float64 intermediate
   is 8 B/pixel that exists only to be discarded. Peak 32 B/pixel → 16.
3. **Stop `toNumberArray` copying a `Float64Array` into a fresh one.**
   `readNumericSlice` hands h5wasm's own `Float64Array` to `toNumberArray`
   (`typed.ts:111-117`), which allocates and `set`s it — a no-op copy worth
   8 B/pixel on every float-count file, and both arrays are live during it. One
   line: `if (raw instanceof Float64Array) return raw`.

---

## 3. Guard-by-guard: hardware, or comfort?

| guard | where | verdict |
|---|---|---|
| `DENSE_MATRIX_BIN_LIMIT` 50,000 | `constants.ts:16` | **Keep.** A CLI-parity contract, pinned verbatim by tests, and 7–15× looser than the browser guard so it almost never binds. Its message quotes 8 B/cell (numpy float64) where this app allocates 4 — deliberate, and tests pin the strings; leave it. |
| `checkBrowserDenseSize` budget | `matrix.ts:144` | **Comfort, mis-calibrated.** The best allow-and-warn candidate in the codebase. Largest square block admitted, pessimistically: **≈18,554 bins/axis on Chrome, ≈12,995 on Firefox** — from the same machine. |
| `MAX_TYPED_ARRAY_CELLS` 2³¹ | `constants.ts:49` | **False, and unreachable.** See below. |
| `MIN_DENSE_BUDGET_BYTES` 1e9 | `constants.ts:34` | **Inverts its own intent below 2 GiB.** See below. |
| `RASTER_MAX_DIM` 4096 | `heatmap.ts:61` | **Keep, do not raise.** 4096² = 2²⁴ px is *exactly* iOS Safari's canvas area cap on memory-constrained devices — 1.0× headroom there, 16× under Chrome's 2²⁸. It is also what makes the render-side memory O(1). |
| `OVERVIEW_MAX_UNITS` 2048 | `reader.worker.ts:52` | **One constant serving two different walls.** Necessary at contig level, ~5–8× too tight at genome level. See §4. |
| `REMOTE_SCAN_BYTE_LIMIT` 64 MB | `Overview.ts:41` | **A bandwidth choice wearing a memory label.** The scan streams at `SCAN_CHUNK`, so a 1 GB remote file costs the same 32 MB of RAM as a 10 MB one. The operation is already cancellable with a progress bar; the refusal text already states the cost honestly, which is exactly what a confirmation needs and an unconditional refusal wastes. |
| `MAX_WHOLE_OBJECT_BYTES` 128 MB | `sources.ts:125` | **Right idea, wrong path.** It caps the rare compressed-host fallback while the common local-drop path — the headline feature — is uncapped (§6.1). |
| `MAX_CATEGORICAL_TICKS` 50 | `constants.ts:76` | **Keep.** Legibility, CLI parity, zero cost. `LABEL_MIN_GAP` already refuses to overprint, so thinning above 50 rather than dropping would preserve orientation for free — but parity has independent value here. |

**`MAX_TYPED_ARRAY_CELLS` is documented as a hardware wall and is neither.**
The comment says "V8 will not allocate [a `Float32Array`] past about 2^31
elements however much memory is free. This is the wall no budget can argue
with." Measured on V8 12.4: `new Float32Array(2**31)` (8.6 GB) allocates, and so
does `2**31 + 1`; the implementation cap is `floor((2^53−1)/4)`, since V8
equalised TypedArray and ArrayBuffer maxima to 2⁵³−1 on 64-bit. Firefox caps
ArrayBuffer at 2³³ (8 GiB).

Worse, the constant can never *cause* a refusal: `estimateBlockBytes` charges at
least 4 B/cell, so `cells > 2³¹` implies `bytes > 8.6e9`, which is already past
the maximum possible budget of 2.86 GB. Its only runtime effect is to pick which
sentence the user reads — and it picks the one that says the machine is
incapable when the truth is that the *budget* was. `dense-guard.test.ts:135-137`
pins that wrong sentence for a 200,000 × 12,000 selection.

**`MIN_DENSE_BUDGET_BYTES = 1e9` inverts below 2 GiB.** The floor is
unconditional, so:

| `deviceMemory` | share | budget after floor | ratio |
|---|---|---|---|
| 2 | 716 MB | 1.00 GB | 1.4× |
| 1 | 358 MB | 1.00 GB | 2.8× |
| 0.5 | 179 MB | 1.00 GB | 5.6× |
| 0.25 | 89 MB | 1.00 GB | **11.2×** |

On a device that reports 256 MB of total RAM the guard authorises a block four
times the machine's entire memory. The comment's reasoning ("the floor matters
for the machines that report 2 GiB or less") holds at 2 and inverts below it.
`reported >= 2 ? Math.max(1e9, share) : share` restores the intent.

**One inconsistency in `checkBrowserDenseSize` itself.** The `nnz` rescue is
documented as being consulted "only to *rescue* a block the pessimistic estimate
would refuse, never to condemn one". The accept/refuse decision does hold that —
but the *message* does not, because 20 B/nnz exceeds 4 B/cell whenever
`nnz > cells/5`, so a refusal can quote a larger number than the estimate that
triggered it. `bytes = Math.min(bytes, withNnz)`.

**`SPECS.md` §9 is stale.** It still describes a `BROWSER_DENSE_CELL_LIMIT` of
1e8 cells and a 32,767-per-axis cap. Neither constant exists; both were replaced
by the estimate.

---

## 4. The 2048 overview cap

> "A 4395 × 4395 picture is neither renderable nor readable, so the 2048 contigs
> with the most non-zero pixels are shown."

### 4.1 Is it required?

Not at genome level, and the sentence overstates. A 4,395² block pools 2:1 to a
2,198 × 2,198 raster, which every browser draws without comment.

What scales with the number of units *N*:

| allocation | size | where |
|---|---|---|
| `acc` Float64 accumulator | 8N² | `reader.worker.ts:251` |
| `Float32Array.from(acc)` | 4N² **more** | `reader.worker.ts:281` |
| pooled display values | 4·min(N,4096)² | `heatmap.ts:127` |
| RGBA raster | 4·min(N,4096)² | `heatmap.ts:194` |
| offscreen canvas backing | ~4·min(N,4096)² | `heatmap.ts:1249` |

The worker peak is **12N²**, not the 8N² the comment budgets for: the
`Float32Array.from(acc)` result is live while the `Float64Array` accumulator
still is.

| N | worker peak (12N²) | render side (≤16·min(N,4096)²) | **total** |
|---|---|---|---|
| 2,048 (today's cap) | 50 MB | 67 MB | **~120 MB** |
| 4,096 | 201 MB | 268 MB | **~470 MB** |
| 4,395 (reference file's genomes) | 232 MB | 77 MB | **~310 MB** |
| 8,192 | 805 MB | 268 MB | **~1.1 GB** |
| 16,384 | 3.22 GB | 268 MB | **~3.5 GB** |
| 154,468 (reference file's contigs) | **285 GB** | 263 MB | impossible |

The cap becomes real at roughly 16 k units. 2048 is about 8× tighter than a
laptop needs, and the reference file's 4,395 genomes — the exact case the
message is written for — cost ~310 MB and render at stride 2.

**The per-pixel scan cost is O(1) in instructions but not in wall time.** The
mirror write `acc[b*n + a] += value` is a strided access into an accumulator
that outgrows every cache level as N rises. Measured over 20 M pixels with a
realistic 80 %-near-diagonal / 20 %-scattered mix:

| N | accumulator | ns/pixel |
|---|---|---|
| 256 | 0.5 MB | 3.9 |
| 2,048 | 33.6 MB | 13.1 |
| 4,096 | 134 MB | 24.8 |
| 8,192 | 537 MB | 112.5 |
| 16,384 | 2.15 GB | 523.8 |

134× from end to end, and already ~3.4× at the current cap. **Accumulating only
the upper triangle** (swap so `a ≤ b`, index `a*n + b − a*(a+1)/2`, expand once
at the narrowing) halves the memory *and* removes the strided write. It is the
single change that buys the most headroom per line, and unlike switching the
accumulator to `Float32` it costs no precision — a `Float32` accumulator would
silently truncate exactly the diagonal and the strongest off-diagonal cells the
picture is read for.

A budget-derived cap is then one line, reusing machinery that exists:
`cap = min(HARD_CAP, floor(sqrt(deviceDenseBudgetBytes() / 8)))` → 11,180 at a
1 GB budget, 18,915 at 2.86 GB. Every real metacool's genome axis passes
unrestricted.

### 4.2 The `maxUnits` override is already built and wired to nobody

```ts
| { id: number; kind: 'overview'; level?: 'genome' | 'contig'; maxUnits?: number }   // protocol.ts:311
const cap = request.maxUnits ?? OVERVIEW_MAX_UNITS                                    // reader.worker.ts:214
```

No caller in `src/` or `test/` ever sets it. The escape hatch for "2048 densest
of 4395" exists in the worker and is one number input in `Overview.ts`'s Scan
card away from being usable. Either wire it or delete it — the protocol should
not advertise a capability the app cannot reach.

### 4.3 The units it keeps are not the densest ones

```ts
const offsets = mc.handle.readNumeric('indexes/bin1_offset')
return (contig) => { const [lo, hi] = mc.contigExtent(contig); return offsets[hi] - offsets[lo] }
```
`reader.worker.ts:315-322`, and `MetaCooler.genomeDensity` computes the same
quantity for genomes. Two problems, and both bear directly on "show the real
data":

- **It is one-sided.** Under `symmetric-upper` storage a pixel between units *g*
  and *h* is stored once, against whichever bin index is smaller. So the
  difference above counts a unit's inter-unit contacts only with units that come
  *after* it. Expected coverage for the unit at position *g* of *G* is roughly
  `(G − g)/G`: the first unit scores ~100 % of its inter-unit pixels, the last
  scores ~0 % and is left with only its own intra-unit triangle. Since contigs
  are ordered by genome, this systematically favours the genomes that come first
  in the file.
- **It is a count, not a density.** It is never divided by `hi − lo`, so it also
  selects for length — which is what the genomes table's tooltip already warns
  about for the sortable column, but the *selection* silently inherits.

The minimum fix is one divide. The better one is to accumulate an exact per-unit
total during the scan the handler is about to run anyway (a `Float64Array(U)` —
1.23 MB at 154 k contigs) and select from the symmetric number. Better still,
under the aggregate-not-truncate design of §4.5, no selection happens at all.

Worth adding either way: a counter on the existing `if (a < 0) continue` at
`reader.worker.ts:260`, so the UI can report **what fraction of the signal the
picture excludes** rather than only how many units it dropped.

### 4.4 The truncation is also the expensive part

```ts
const density = level === 'genome' ? (unit) => mc.genomeDensity(unit) : contigDensityLookup(mc)
...
selected = [...displayed].sort((a, b) => density(b) - density(a))     // reader.worker.ts:239
```

At genome level `density` is `MetaCooler.genomeDensity`, which performs **two
separate one-element HDF5 reads** (`MetaCooler.ts:509-510`) — and it is called
from inside the comparator, so it runs once per *comparison*, not once per unit.
Measured V8 comparator counts:

| level | units | density() calls | needed | ratio |
|---|---|---|---|---|
| genome | 4,394 | 94,972 → **189,944 HDF5 reads** | 4,394 → 8,788 | 21.6× |
| contig | 154,000 | 4,905,716 | 154,000 | 31.9× |

At contig level the calls are cheap (`contigDensityLookup` pre-reads the index),
and the sort still measures **231 ms against 59 ms** with precomputed keys. At
genome level each call is two `malloc` / `get_dataset_data` / `free` round trips
into wasm, all **before `scanPixels` is entered**, while the UI shows
`starting…` (`Overview.ts:277`) and the progress bar sits at zero.

Two independent fixes, both small:

- precompute the key once — `const key = new Float64Array(unitCount); for (const
  u of displayed) key[u] = density(u)` — then sort indices against `key`;
- give the genome branch the treatment `contigDensityLookup` already uses: one
  read of `indexes/bin1_offset` (3.4 MB on the reference file) and O(1) lookups,
  against 190,000 individual chunk reads.

The same defect is on the landing view: `handleGenomes` (`reader.worker.ts:130`)
calls `genomeDensity` once per genome, so opening the reference file costs
**8,790** one-element reads before the table paints.

And the ternary at `reader.worker.ts:233` is eager, so `contigDensityLookup`
performs its full 3.4 MB `bin1_offset` read **even when no truncation will
happen** — every contig-level overview of a file with ≤ 2,048 contigs pays for a
closure that is never called. The two branches are asymmetric in laziness, which
is what hides it.

### 4.5 What to do instead of raising it

Raising the cap helps genome level and does nothing for contig level, where it
still throws away 152,420 of 154,468 contigs — the opposite of what that view is
for. And the resolution being asked of the accumulator above 4,096 is discarded
before it reaches the screen anyway.

**Aggregate instead of truncating.** Accumulate into an `M × M` grid with
`M = min(N, POOL_UNITS)`, mapping unit *i* to slot `floor(i·M/N)`:

- memory bounded by `8M²` **regardless of N** — 134 MB at M = 4,096;
- **every** contig contributes; nothing is dropped;
- contigs are stored genome-grouped (constraint C4), so a pooled slot is a run
  of consecutive contigs *within one genome* — a coherent sub-genome block, not
  an arbitrary mixture;
- the axis is already labelled by genome through `rowSuperGroups`, so the
  labelling needs no change;
- the density sort disappears, and with it the 190,000 reads.

One refinement worth taking: allocate slots per genome rather than by flat index
(`max(1, round(nContigs_g · M / N))` each) so a pooled slot never straddles a
genome boundary. That keeps the dividers exact, which is the point of the
contig-level picture.

**One semantic change to state plainly.** Today a 4,395-unit overview is
summed per genome pair and then *max*-pooled 2:1 by the renderer;
pre-aggregating sums those blocks instead, and max-of-sums ≠ sum-of-maxes. Sum
is the right aggregation here — it is what `metacooler aggregate --level genome`
does one level up, and an overview cell already *is* a total rather than a
sampled pixel — but the picture is not bit-identical to today's above 4,096
units, and that should be said rather than discovered. Max-pooling exists for
sparse *bin*-level maps, where averaging loses loops; it is not the right
operator for an already-aggregated block.

The headline then becomes:

> 154,468 contigs pooled into 4,096 rows (≈38 per row), grouped by genome.
> Nothing is dropped.

and 4,395 genomes are drawn **exactly**.

### 4.6 The message contradicts itself, and its load-bearing half is false

> "A 4395 × 4395 picture is neither **renderable** nor readable…"

4,395² pools at stride 2 to a 2,198² raster costing 77 MB of render memory. It
is comfortably renderable — the renderer's whole pooling machinery exists to
draw matrices *larger* than the cap. "Not readable at this scale" is the true
and sufficient claim. The unrestricted branch one line below says something
different again, so the two arms of the same ternary do not agree on what the
view is.

Neither branch states the number a reader needs: **53.4 % of genomes** or
**98.7 % of contigs** discarded — nor, more usefully, what share of the contacts
went with them.

---

## 5. The larger change: do not materialise what is only going to be pooled

Every view path is:

```
COO pixels → dense Float32Array (nRows·nCols) → poolDisplay → ≤4096² → RGBA → canvas
```

The middle step is the only thing any guard is defending, and the only one whose
size is unbounded. Every allocation on the render side is already bounded by
`P = ceil(N/stride) ≤ 4096`, so the *picture* costs ~268 MB whatever N is — but
the **work** is not bounded, because `poolDisplay` reads all N² cells to produce
P² pixels:

| block | stride | P | cells read per pixel drawn |
|---|---|---|---|
| 4,096 | 1 | 4,096 | 1× |
| 8,192 | 2 | 4,096 | 4× |
| 24,322 (yeast @ 500 bp) | 6 | 4,054 | 36× |
| 154,000 | 38 | 4,053 | **1,444×** |

That ratio is the argument for removing the dense block rather than budgeting
for it: the renderer is already forbidden from showing more than 4,096 units of
detail per axis, so materialising N × N above that is provably wasted.

Measured at the yeast-@-500 bp shape with nnz = 1.5e8:

| path | retained | time |
|---|---|---|
| dense → pool | 2,370 MB | 6,790 ms |
| **COO → pooled raster directly** | **82 MB** | **3,439 ms** |

Same bytes read from the file, same picture out: **29× smaller, 2× faster**, and
it deletes the allocation the whole guard exists to police.

### What it costs

The spec promises pan and zoom with **zero I/O** over the in-memory block
(§2, §7.2). Without a dense block, that holds down to the pooled resolution;
below it, a zoomed view needs a bounded re-read. That is a fair trade, and the
re-read is small by construction — a window filling 4,096 px at one cell per
pixel is at most 4,096 bins per axis, the size of a MAG.

Worth noting that a stride-1 re-raster of the visible domain is desirable
*anyway*, dense block or not: today a block above 4,096 bins per axis pools
permanently, and no amount of zooming recovers the detail, because
`heatmap.ts:1136-1152` only multiplies the draw transform by the stride and
nothing re-rasterises finer. Pooling is max-not-mean so a loop is dimmed rather
than lost, which is the right trade — but the ceiling is real and undocumented
in the UI.

### What else reads `DenseMatrix.values`

- hover readout / tooltip — `heatmap.ts:1107`, one cell;
- `aggregate` — should stream anyway (§6.8);
- `applyWeights` — `matrix.ts:392`; becomes a per-pixel multiply during the
  stream, with the two weight slices read once as now;
- auto-`vmin`/`vmax` — **already** taken over the pooled values
  (`autoRangeOfDisplay`), which a streaming build produces identically, so
  §7.1's parity property is preserved exactly: below the pooling threshold
  nothing is pooled and the bounds stay bit-identical;
- PNG/PDF export — re-renders through the same draw code from the raster;
  unaffected.

---

## 6. Other findings, with numbers

### 6.1 A local file is read whole, twice, before anything is parsed

`LocalFileSource.mount()` (`LocalFileSource.ts:156`):

```ts
const bytes = this.bytes ?? new Uint8Array(await (this.blob as Blob).arrayBuffer())
h5.FS.writeFile(target, bytes)
```

Emscripten's MEMFS stores contents as a plain JS `Uint8Array` (verified in the
bundle: `expandFileStorage` / `resizeFileStorage` both do `new Uint8Array(...)`),
so this is **not** inside the 2 GiB wasm heap — the ceiling is JS heap and
available RAM. But the cost is still real and it is the largest gap between the
local and remote paths:

- the whole file is materialised **twice** in the JS heap (`arrayBuffer()` plus
  the MEMFS copy) before one byte of HDF5 is parsed;
- opening a 5 GB `.mcool` to look at one 2 Mb region reads 5 GB and holds up to
  10 GB, when the remote path opens the same file with a few hundred KB of
  range requests;
- there is **no size guard at all** on this path, and no `ErrorView` case, so
  the failure mode is a raw allocation error with no advice — while the rare
  compressed-host fallback that ends in the same class is capped at 128 MB.

`RemoteRangeSource` already contains the fix: a lazy FS node with an LRU chunk
cache and a synchronous `read` stream op. The local path can take the same shape
using `FileReaderSync` over `blob.slice()` — available in workers, which is
where all I/O already lives. That makes local files arbitrarily large, instant
to open, and collapses both sources into one lazy-node implementation with two
byte accessors. It is the biggest scale win available and it is *simpler* than
what is there now.

### 6.2 Rasterisation blocks the main thread

`poolDisplay` and `colorize` run inside `MatrixPanel.schedule()`'s
`requestAnimationFrame` (`MatrixPanel.ts:563` → `heatmap.ts:1120` →
`rasterizeNow`). The 6.8 s measured in §2.3 is 6.8 s of a frozen tab: no
progress, no cancel, no repaint.

Moving rasterisation into the worker and transferring an `ImageBitmap` (or the
RGBA buffer) would keep the UI alive, make the work cancellable, and mean the
dense block never crosses `postMessage`. `OffscreenCanvas` is already referenced
in `createRasterCanvas` (`heatmap.ts:289`), so half the plumbing exists.

### 6.3 The auto-percentile is re-sorted on every colormap change

Two problems in one place.

**It full-sorts to read two order statistics.** `collectWhere` (`scale.ts:325`)
copies the kept values and calls `out.sort()` — O(n log n) — for the 1st and
99th percentiles. Quickselect returns the same *exact* order statistics in O(n),
so parity is untouched.

**And it runs again on every recolour.** `colorize` resolves `auto` whenever
either bound is non-finite (`heatmap.ts:186-188`), which is the default state,
so changing the colormap re-collects and re-sorts a buffer for a number the
colormap cannot affect. `rasterizeNow` already caches the pooled values across a
colormap change — the sort is what the caching does not cover.

The cost is density-dependent, which is why both of these are true:

| raster | positive fraction | collect + sort |
|---|---|---|
| 4,034² sparse bin-level (yeast @ 1 kb) | 0.4 % | 134 ms |
| 2,048² dense overview | 92 % | **515 ms** (472 in the sort) |
| 4,096² dense overview | 92 % | **2,066 ms** (1,831 in the sort) |

So a colormap change on a genome × genome overview is a half-second to
two-second main-thread freeze, entirely inside a computation whose inputs did
not change. Caching the resolved range on `PooledDisplay` beside `extent` —
it depends only on `values`, `transform` and `balanced`, which are already the
cache key for the pooled array — removes it in one field.

### 6.3b `PooledDisplay.extent` is computed per pixel and never read

`poolDisplay` tracks `lo`/`hi` over every pooled value (`heatmap.ts:155-158`)
and stores it as `extent`. No production path reads it — ~50 ms of `isFinite`
and comparisons at 4,050², in the hottest loop in the app, thrown away.

It is also *close* to what `colorize` then spends over a second re-deriving.
Repurposing that same pass to build a 4,096-bucket histogram of the finite
pooled values would turn the p1/p99 lookup into an O(buckets) scan and remove
the sort entirely — with the caveat that a bucketed percentile is no longer
bit-identical to numpy's, so it belongs on the pooled path (where §7.1 parity
does not apply, because nothing pooled matches `metacooler show` anyway) and not
on the unpooled one. Quickselect (§6.3) is the parity-safe version and is
already a 20–40× win.

### 6.4 `displayValue` is a call with a switch, in the innermost loop

`poolDisplay` (`heatmap.ts:150`) calls `displayValue(raw, transform, balanced)`
once per **cell** — 592 million times for yeast @ 500 bp — re-evaluating the
`balanced && transform === 'log10'` test and then a switch each time.
`transformValues` in the same codebase already argues for the opposite ("the
loop hoists its branch out of a million iterations, and that matters more than
the duplication"). The measured spread between transforms — 6,790 ms for `log1p`
against 4,808 ms for `log10` — is this plus the intrinsic.

Measured in isolation, hoisting the branch and inlining the intrinsic takes the
loop from 9.98 to 6.16 ns/cell — **38 %**, or 2.26 s of the yeast render.

**There is a better version of the same fix: pool the raw maximum first, and
apply `displayValue` once per *pooled pixel*.** That is 16.4 M calls instead of
590 M — 36:1 — and measured 5.74 ns/cell, a 2.05 s saving. It is value-identical
wherever the transform is monotone in `raw`, which covers `log1p`, `none`, and
`log10` on balanced values. **The one exception is `log10` on raw counts**,
whose `x > 0 ? log10(x) : 0` clamp is *not* monotone across zero — `f(0) = 0`
but `f(0.5) < 0` — so a float-count column with sub-unit values would differ.
Integer counts are ≥ 1 and unaffected. Take the fast path where the transform is
monotone and fall back to per-cell transformation for `log10` on a float-count
file, or clamp before pooling.

The triple-nested loop is also **slower per cell in the case where it does the
least work**: at stride 1 it still pays all the `y0/y1/x0/x1` bookkeeping and
the NaN-max reduction for a 1 × 1 block. Measured 35.6 ns/cell at stride 1
against 11.2 ns/cell at stride 2 — 3.2× worse per cell for a pass that is a pure
`displayValue` map. A straight-line branch when `strideX === 1 && strideY === 1`
covers every block small enough not to pool, which is every MAG and every region
view.

### 6.4b The raster's RGBA is retained forever, and its canvas re-allocated per recolour

`rasterizeNow` (`heatmap.ts:1249-1261`) allocates a fresh canvas per call,
`putImageData`s the RGBA into it — which copies — and then stores the `Raster`
*including its now-redundant `data`* on `this.raster`. At 4,050²:

| buffer | size | lifetime |
|---|---|---|
| `raster.data` (Uint8ClampedArray) | 65.6 MB | retained for the life of the view, read by nobody after `putImageData` |
| offscreen canvas backing store | 65.6 MB | fresh allocation per rasterise |
| pooled `Float32Array` | 65.6 MB | correctly retained (it is the recolour cache) |

So each colormap or clip change churns ~131 MB, and ~66 MB is pinned for
nothing. On the yeast case the live set is ~2.63 GB against a 2.86 GB budget —
the retained copy is the difference between fitting and not.

Fix: drop `data` from what `HeatmapView` retains after `putImageData`, and reuse
both the `Uint8ClampedArray` and the offscreen canvas across `colorize` calls
when the dimensions are unchanged — which is every colormap and clip change,
since neither resizes the raster.

This is also the second half of the `estimateBlockBytes` raster under-charge
(§2.4): the real cost is at least 12 B per raster pixel (pooled + RGBA + canvas
backing), not 8.

### 6.5 The overview allocates N² twice

`Float32Array.from(acc)` (`reader.worker.ts:281`) is a second N² allocation
*and* an element-at-a-time conversion through the iterator protocol.
`new Float32Array(acc)` gives the same result through the typed-array conversion
path.

### 6.5b Every pointer event draws twice, and repaints two things that cannot have changed

`panBy` and `zoomAt` call `changed()` (`heatmap.ts:974`), which reaches
`MatrixPanel.schedule()` and its correct one-draw-per-frame rAF coalescing —
and then the input handlers call `this.draw()` **synchronously as well**
(`heatmap.ts:1653, 1680, 1688, 1698, 1706, 1709, 1767, 1775, 1798`). The
synchronous half is not rate-limited at all, so a 120 Hz trackpad drives 120
full repaints per second *on top of* the 60 coalesced ones: **180 draws/s where
60 suffice**, and `schedule()`'s `if (this.frame !== 0) return` guard is
bypassed entirely.

Each of those frames also repaints two things that did not move:

- the **colourbar** — `schedule()` calls `colorbar.setScale` + `draw()` every
  frame, which is 256 `fillRect`s and 256 freshly built colour strings for a
  14 px strip whose scale is unchanged during a pan: ~15,000 fills/s;
- the **clip boxes** — `clip.setValues` every frame, worth two `toPrecision`,
  two `inverseTransform`, two `formatCount` and a template literal, ~8 string
  allocations, 60×/s.

Fix: delete the synchronous `draw()` calls and let `changed()` be the single
redraw path (or route them through a private rAF-coalescing `requestDraw()` for
the standalone/test case with no `onChange` wired), and guard the colourbar and
clip on an actual change of the resolved scale. Cache the 256 `fillStyle`
strings per colormap beside `RGBA_CACHE`; they are constant per map.

### 6.5c Hovering forces two layout flushes and rebuilds the tooltip per event

`describe()` → `placeTooltip` reads `offsetWidth`/`offsetHeight`
(`MatrixPanel.ts:646-647`) after `replaceChildren` has just written to the DOM —
a read-after-write, twice per pointer move, so **two forced synchronous layouts
per event**, plus 4–6 element allocations that immediately become garbage.

The data half is fine: `cellAt` is O(1) and `groupAt` is a binary search
(≤ 15 comparisons at 20,000 groups). The cost is entirely DOM.

It compounds because **`crosshair` defaults to on** (`plotOptions.ts:37`), so
`setHover` also calls `changed()` whenever the hovered cell changes — and at fit
zoom, where a 4,050 px raster is shown in ~800 CSS px, one pixel of pointer
travel crosses several matrix cells, so nearly every move triggers a full canvas
+ colourbar + clip repaint on top of the reflows.

Fix: cache the canvas rect and refresh it from the existing `ResizeObserver`;
build the five tooltip nodes once and assign `textContent`; position with a CSS
`transform: translate()` so no `offsetWidth` read is needed.

### 6.6 Separators are one Skia op per line, per frame, unculled

Mitigating fact first: **`dividers` and `labels` both default to off**
(`plotOptions.ts:36-41`) — deliberately, because "dividers and labels on a 20 k
contig map are ink over data". So everything below is one click away rather than
on by default. On an overview it is a click a reader will make, since the
dividers are what show the genome blocks.

`strokeBoundary` (`heatmap.ts:1265`) issues `beginPath` / `moveTo` / `lineTo` /
`stroke` per separator on every draw, with no visibility culling and no
de-duplication when several boundaries land on the same device pixel:

| overview N | `stroke()` calls per frame | at 60 fps |
|---|---|---|
| 2,048 (today's cap) | 4,094 | 245,640 /s |
| 4,096 | 8,190 | 491,400 /s |
| 8,192 | 16,382 | 982,920 /s |

At roughly 1–3 µs for a hairline stroke, dividers alone plausibly consume
**4–12 ms of a 16.7 ms frame** while panning or zooming. On a 20,000-contig
bin-level view with dividers on it is 40,000 strokes per draw — 40–120 ms/frame,
i.e. 8–25 fps, before the 2–3× double-draw multiplier of §6.5b. This — not the
33.6 MB accumulator — is what would actually make a raised overview cap feel
like a ceiling.

**Zooming in makes it worse, not better.** At 100 visible bins out of 24,300,
99.6 % of the strokes fall outside the clip rect and produce no pixels, while
the loop length stays constant. `at` values are ascending by construction
(`separatorsFor` maps over ordered groups), so binary-searching `scale.domain`
and iterating only the visible slice is exact and cheap.

At contig level the same coordinates are submitted **twice**: `separatorsFor`
(`MatrixPanel.ts:831-838`) puts the genome super-groups into `rows`/`cols` *and*
into `groupRows`/`groupCols`, deliberately (so the axis is labelled by genome
and the heavier stroke lands on the same coordinates) — but the fine set is then
drawn for nothing, since the heavy one covers it.

Fixes, all local: batch into two `Path2D` objects and issue one `stroke()` each
(4,094 submissions → 2); skip the fine set when there are more separators than
the data rect has device pixels, because every line then overlaps its neighbour
anyway; stop submitting the super-groups twice.

`labelBlocks` (`heatmap.ts:1376`) has the mirror-image problem: it builds
N-element arrays for **both axes on every frame** and then discards the result
because `blocks.length > maxLabels` — always true on an overview. Measured
`separatorBlocks` alone at 0.010 ms for 50 separators, 0.060 ms for 2,048 and
0.884 ms for 20,000; twice per frame in `drawLabels`, and twice more when a
resize fires `measureMargin`, so up to 3.5 ms — 21 % of a frame — producing
arrays that are then returned as `[]`. Testing
`this.separators[axis].length > this.opts.maxLabels` before building is exact,
since the block count can never exceed the separator count. Better still, cache
the blocks in `setMatrix` and invalidate only there.

### 6.6b What the audit confirms is already right

Worth recording, because these are the load-bearing claims of §7.2 and §12 and
they hold:

- **Pan, zoom, resize, theme flips and overlay toggles perform zero
  rasterisation.** Eight distinct re-render triggers audited; five are provably
  raster-free, and `dirtyRaster` has exactly two assignment sites.
- **A clip change costs `colorize` only**, not `poolDisplay`, because
  `ClipRange.fromBox` sets both bounds finite so the auto-range branch is
  skipped — and it fires on `change`, not `input`, so typing a bound does not
  re-render per keystroke.
- **The `postMessage` boundary is correct.** `transfersFor` moves every typed
  array zero-copy; the only cloned payload is the O(N) label strings, ~82 kB at
  2,048 units.

The invalidation design is easy to break with an innocuous-looking `setScale`
call, so it is worth a test that spies on `poolDisplay`/`colorize` and asserts
zero calls across a pan, a zoom, a resize, a theme flip and each overlay toggle.

### 6.7 The contigs table sorts through two closure calls and `localeCompare`

`VirtualTable.recompute()` (`VirtualTable.ts:333`) calls `column.value(row)`
**twice per comparison** and `String.prototype.localeCompare` once. For 154,468
contigs that is ≈5.2 M `value()` calls and ≈2.6 M `localeCompare` calls per
header click. Decorate-sort-undecorate plus a single shared `Intl.Collator` is
the standard fix, worth 5–20×.

The rest of the table is sound: virtualisation is real (rows in view plus 6 of
overscan), and search and filters are debounced at 120 ms.

### 6.8 Whole-genome contig level is unreachable for the wrong reason

`WholeView` says it plainly:

> Not "switch to contig level": that rolls up a block which has to be read
> first, so it is refused by the same guard for the same reason.

For a yeast `.cool` the contig-level whole-genome view is **17 × 17 = 289
cells** — it would open on a phone. It is unreachable because `handleAggregate`
(`reader.worker.ts:177`) loads the full bin-level dense block and only then
calls `mc.aggregate`. And for a cooler the level toggle is not offered at all
(`offerLevel: file.info.hasGenomes`, `main.ts:818`), so there is not even a
control to try.

Streaming aggregation — COO → group accumulator, which `scanPixels` already
provides — makes this O(nContigs²) instead of O(nBins²) and takes the guard out
of the path. **This is the cheapest large win in the list**: it turns the "too
big" screen into a usable picture using machinery that already exists.

### 6.9 Export is unguarded against canvas area caps at high DPI

`exportCanvas` (`MatrixPanel.ts:448`) scales by `dpi/96`, so at 600 dpi a
5,243 CSS-px figure crosses both Chrome's 2²⁸ area cap and Firefox's 32,767 side
cap; on iOS Safari's 2²⁴ area, any figure above ~656 CSS px does. The failure is
graceful ("export failed: …") but not actionable. Two comparisons before the
allocation could name the largest DPI from `EXPORT_DPI_CHOICES` that fits.

---

## 7. What the real ceilings are

For setting guards against hardware rather than against round numbers. Runtime
values were probed against the installed `h5wasm@0.10.3`.

| ceiling | reality | what the repo assumes |
|---|---|---|
| `Float32Array` max length | 2⁵³−1 bytes on 64-bit V8; measured `Float32Array(2**31 + 1)` = 8.6 GB allocates. Firefox caps ArrayBuffer at 2³³ | `MAX_TYPED_ARRAY_CELLS = 2**31`, documented as a hard V8 wall — **wrong, and unreachable** |
| ArrayBuffer max | measured OK to 8.6 GB, `RangeError` at 17.2 GB — i.e. bounded by RAM, not by spec | same |
| canvas | `RASTER_MAX_DIM = 4096` → 2²⁴ px, exactly iOS Safari's cap, 16× under Chrome's 2²⁸ | correct and deliberately conservative |
| **h5wasm linear memory** | **hard-capped at 2,147,483,648 B (2 GiB)** — `getHeapMax = () => 2147483648` in *both* the browser and node builds; measured `_malloc` succeeding to exactly 2,147 MB and then `Cannot enlarge memory, requested … but the limit is 2147483648` | **modelled nowhere in the repo's own guards** |
| `navigator.deviceMemory` | Chromium only; `undefined` in Firefox and Safari; capped at 8 | treated as a floor — which it is, but the 4 GiB fallback then governs two whole engines |
| failed allocation | a too-large typed array throws a catchable `RangeError`; it does not crash the tab | the app pre-refuses rather than trying |

**The 2 GiB wasm heap is the app's one genuine hardware wall.** It bounds every
single HDF5 read, because `Dataset.slice()` goes through h5wasm's own
`check_malloc`, which compares against `MAXIMUM_MEMORY` and then tests
`ptr === 0`. An unchunked `readPixelSpan` asks for `8·P` bytes per column, so:

| P (stored pixels in the row band) | staging `_malloc` | share of the 2 GiB arena |
|---|---|---|
| 1e7 | 80 MB | 4 % |
| 1e8 | 800 MB | 37 % — contiguous, in an arena that also holds HDF5's B-tree and metadata state |
| 2.68e8 | 2.147 GB | 100 % — nominally at the limit, practically unallocatable |
| 3e8 | 2.4 GB | **throws** |

So `P > 268,435,456` is an unconditional hard failure whatever the machine has,
surfacing as an uncoded `Requested allocation of N bytes exceeds maximum memory
of 2147483648 bytes` — a plain `Error`, no `ViewerError` code, no case in
`ErrorView`. `readTable.ts:288` re-implements the same check for string reads
only, and against the *total* cap rather than free heap.

Chunking `readPixelSpan` (§2.4) removes that ceiling from the picture entirely,
which is a second reason to do it.

The last row of the table is the practical opening: a
`try { new Float32Array(n) } catch (RangeError)` is a *measurement* of the
machine, in the only unit that matters, and it is free. The guard can become
estimate → warn if large → attempt → fall back to the streaming path if the
attempt fails. That is strictly better information than `deviceMemory` can ever
give.

---

## 8. Recommended order

Ranked by what it unlocks ÷ risk.

**Cheap and large:**

1. **Streaming aggregation for whole-genome contig/genome level** (§6.8).
   Reuses `scanPixels`; removes the guard from that path; turns the "too big"
   screen into a usable picture.
2. **Cache the auto-range on `PooledDisplay`** (§6.3). Removes a 0.5–2 s
   main-thread freeze from every colormap change. One field.
3. **Delete the synchronous `draw()` calls in the input handlers** (§6.5b).
   Removes a 2–3× repaint multiplier from every pan, zoom and hover.
4. **Pool the raw maximum and transform once per pooled pixel** (§6.4). 36:1
   fewer transform calls, measured 2.05 s off the yeast render — with the
   `log10`-on-float-counts caveat noted there.
5. **Stop retaining `raster.data` and reallocating the offscreen canvas**
   (§6.4b). ~66 MB pinned and ~131 MB churned per recolour, on the case where
   the budget is tightest.
6. **Batch the separators into two `Path2D`s, cull to the visible domain, and
   bail out of `labelBlocks` early** (§6.6).
7. **Fix the overview's density sort** (§4.4) — precompute keys, and read
   `bin1_offset` once as the contig path already does. Removes ~190,000 HDF5
   reads. Same in `handleGenomes`. Make `contigDensityLookup` lazy.
8. **Accumulate only the upper triangle in the overview** (§4.1). Halves memory
   and removes the cache-hostile mirror write — up to 134× per-pixel at large N.

**Then the substantive ones:**

9. **Chunk `readPixelSpan`, and budget against the real `P`** (§2.4). Removes
   the largest unmodelled allocation, the 7.9× estimate error, and the 2 GiB
   wasm ceiling, all from one change. Narrow int64 → Int32 directly and drop
   `toNumberArray`'s no-op copy while in there.
10. **Aggregate rather than truncate in the overview** (§4.5), with the cap
    derived from the budget so no real metagenome's genomes are pooled at all;
    fix the one-sided selection statistic (§4.3); wire or delete `maxUnits`
    (§4.2); fix the message (§4.6).
11. **Recalibrate the dense guard** (§3): try-and-catch instead of pre-refuse,
    warn-and-continue in the middle band, hard refusal only where an allocation
    actually failed. Fix `MIN_DENSE_BUDGET_BYTES` below 2 GiB, correct
    `estimateBlockBytes`'s constants, and either delete `MAX_TYPED_ARRAY_CELLS`
    or stop it choosing a false message.
12. **Rasterise in the worker** and hand back an `ImageBitmap` (§6.2). Retires
    ~197 MB of main-thread buffers and removes multi-second freezes; the code is
    already linked into the worker and the data is already there.
13. **Stream COO → pooled raster** above a threshold, keeping the dense path
    below it (§5), plus a **stride-1 re-raster of the visible window** when
    `zoom · stride > 1` — bounded by the plot area in pixels, so it fits in a
    frame at any zoom, and it is worth doing for fidelity even without the
    streaming change.
14. **Lazy local files** (§6.1). Removes the read-it-all-first cost and makes
    opening instant.

**Small:** quickselect percentile and the dead `extent` pass (§6.3, §6.3b),
stride-1 fast path in `poolDisplay` (§6.4), `new Float32Array(acc)` (§6.5),
colourbar/clip dirty flags and the tooltip layout thrash (§6.5b, §6.5c),
decorated sort with a shared `Intl.Collator` (§6.7), export DPI pre-flight
(§6.9), and the stale `SPECS.md` §9 paragraph.

Items 1–11 make the brief's yeast-@-500 bp case work on ordinary hardware and
the whole-metagenome overview show every contig — and they do it mostly by
deleting work, not by loosening a limit.
