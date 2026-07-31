# IMPLEMENTATION.md

Build plan for `metacooler-viewer`, implementing `metacooler-web-app-spec.md`.

---

## 0. Source of truth — verified against the code

Read from the uploaded `src.zip`: **metacooler 0.1.0** (`_version.py`), 49 modules, source dated
2026-07-29/30. The docs site is broadly accurate, but the source corrected nine things and revealed
capabilities the documentation does not mention.

### Corrections that changed the spec

| # | Docs said / I assumed | Source says |
|---|---|---|
| 1 | `genomeid-then-alpha` is a genome-grouped ordering | **It does not exist.** `GENOME_GROUPED_ORDERINGS = {"genome-then-length", "genome-then-alpha"}`. Valid orderings are `genome-then-length`, `genome-then-alpha`, `fasta`, `alpha` (from pairs) and `cool` (from a cooler). The format doc's `/indexes` paragraph is stale — **worth fixing before the paper** |
| 2 | `count` is int32 or int64 | **Also float64.** `resolve_count_dtype` preserves float sources rather than truncating; `CORE_COLUMN_KINDS["pixels/count"] = "iuf"`. Unsigned kinds are permitted throughout, so test dtype *kind* |
| 3 | `bin-size` is an integer or absent | May be the **string** `"null"`. `_int_attr` treats `""`/`"null"`/`"none"`/`"nan"` as absent, accepts integral floats, rejects booleans. `Number("null")` is `NaN` and `"null"` is truthy — a naive read **accepts a variable-bin file** |
| 4 | `__unbinned__` is genome index 0 | Only when it exists. `create(drop_unassigned=True)` omits it entirely, making index 0 a real MAG. **Match by name** |
| 5 | Names are `S<n>` | Confirmed — and sized by **UTF-8 encoded byte length**, not character count. But `CORE_COLUMN_KINDS` also permits `O` and `U`, so `create cool` output may carry vlen strings |
| 6 | Dense guard is "some limit" | `DENSE_MATRIX_BIN_LIMIT = 50_000` bins per axis; `PIXEL_SAMPLE_SIZE = 1000` for validation windows |
| 7 | `/bins/chrom` might be a cooler categorical/enum | Written as plain `int32`. Moot — we never read `/bins` — but it removes a worry |
| 8 | `info` key mapping | Confirmed exactly, plus an undocumented legacy fallback: `assembly-name` is read when `genome-assembly` is absent, `""` or `"unknown"`. `nchroms` → `ncontigs` |
| 9 | Overview needs `aggregate --level genome` | **`metacooler network --level genome` is better** — see below |

### Capabilities the docs never mentioned

The CLI has thirteen commands absent from the documentation site: `network`, `flatten`, `check`,
`ls`, `tree`, `attrs`, `metadata`, `dump`, `extract`, `stack`, `cp`, `mv`, `rm`.

Two matter here:

- **`network --level {bin,contig,genome}`** emits a `node1 / node2 / value` edge list (TSV, stdout or
  file, `--header` optional, `--weight` selects the pixel column). At genome level that is the entire
  genome × genome overview as a few KB of text. It replaces the aggregate-`.cool` sidecar in spec
  §7.3: no HDF5, no range requests, one `fetch`.
- **`check --deep`** is the full pixel scan (`DEEP_PIXEL_CHUNK = 1_000_000`), i.e. the exact operation
  the browser must never perform. Useful as the reference implementation for the debug-mode validator.

`flatten` (metacool → cool, contigs as chromosomes, bins preserved) is worth a line in the paper's
interoperability section, since it is a different export path from `aggregate --level contig`.

### Still unverified

The changelog was not in the archive, so I cannot see whether `0.1.0` is released or in flux. The
format version is `1` and `METACOOLER_FORMAT_VERSION` agrees, so the reader's version gate is sound.

## 1. Ground rules

Carried from the spec's constraints; every one of these is a review criterion, not a preference.

- **No changes to metacooler.** Nothing in this repo requires a new Python feature, flag, or file
  format. The catalog generator (M8) is a standalone script that lives *here*, not in metacooler.
- **No backend.** If a task seems to need one, it is the wrong task.
- **No required preprocessing.** A file straight from `metacooler create` opens and works.
- **`genome-then-length` and fixed-bin only.** Both checked at open; both produce a named refusal.
- **`/bins` is never read.** If a diff adds a read of `/bins`, it is a bug, not an optimisation.
  Enforce with a lint rule or a test that fails on any access to that path.
- **The reader mirrors the Python API.** Same names, same semantics, same errors. When in doubt,
  do what `MetaCooler` does.

---

## 2. Repository layout

```
metacooler-viewer/
├── src/
│   ├── uri.ts                   # parseUri — mirrors metacooler.uri
│   ├── sources/
│   │   ├── ByteSource.ts        # interface
│   │   ├── LocalFileSource.ts   # M1
│   │   └── RemoteRangeSource.ts # M5
│   ├── h5/
│   │   ├── bootstrap.ts         # h5wasm init, worker-side only
│   │   ├── readTable.ts         # UTF-8 S<n> decode, BigInt64 → Number
│   │   └── typed.ts             # dtype resolution, count int32/int64
│   ├── metacooler/
│   │   ├── detect.ts            # layout detection + acceptance gates
│   │   ├── MetaCooler.ts        # the class
│   │   ├── coords.ts            # fixed-bin arithmetic; no /bins access
│   │   ├── range.ts             # parseMetacoolerRange
│   │   ├── matrix.ts            # COO → dense, symmetry, transpose
│   │   └── aggregate.ts         # contig/genome roll-up of a loaded matrix
│   ├── tracks/bigwig.ts         # M6
│   ├── worker/                  # message protocol, owns all I/O
│   ├── render/                  # canvas heatmap, colormaps, separators
│   ├── state/                   # ViewState, URL hash serialisation
│   └── ui/                      # genomes table, breadcrumb, pickers, errors
├── scripts/
│   ├── make_fixtures.py         # uses ONLY the public metacooler CLI/API
│   ├── make_golden.py           # exports oracle JSON from Python
│   └── make_catalog.py          # M8; standalone, not part of metacooler
└── test/
    ├── fixtures/                # generated, git-lfs or regenerated in CI
    ├── golden/                  # JSON oracles
    ├── unit/
    └── budgets/                 # request-count regression tests
```

---

## M0 — Fixtures and golden oracles (before any app code)

Nothing else can be tested without this, and it is the milestone that catches format
misunderstandings while they are still cheap.

### Fixtures (`scripts/make_fixtures.py`, public API only)

| File | Purpose |
|---|---|
| `basic.metacool` | ~6 genomes, ~30 contigs, fixed 5 kb bins, `genome-then-length`, includes `__unbinned__` with real contigs |
| `metadata.metacool` | same, plus `/genomes` extra columns (completeness, contamination, taxonomy) and `/contigs` extras |
| `utf8.metacool` | genome and contig names containing non-ASCII (e.g. `é`) — guards the decode path |
| `int64.metacool` | product of `binnify`, so `count` is int64 — guards the BigInt path |
| `ladder.mmetacool` | `zoomify` output, integer entry names |
| `samples.mmetacool` | multiple entries with non-integer names |
| `dropped.metacool` | `create(drop_unassigned=True)` — no `__unbinned__` row, so genome 0 is a real MAG. Guards correction #4 |
| `floatcount.metacool` | float `count` column. Guards correction #2 |
| `fasta_order.metacool` | `--contig-order fasta` — **must be refused** |
| `variable.metacool` | fragment-level, variable bins — **must be refused** |
| `plain.cool`, `plain.mcool` | non-metagenomic, for M7 |
| `coverage.bw`, `mismatched.bw` | one with matching contig names, one deliberately not |

Keep every file under a few MB so they can live in the repo and run in CI.

### Golden oracles (`scripts/make_golden.py`)

Export to JSON, from Python, for each fixture: `info`, `genomes`, `contigs`, `chromnames`,
`chromsizes`, `shape`, `binsize`; `genome_extent` and `contig_extent` for every genome and a sample of
contigs; `parse_metacooler_range` results for a battery of range strings including the error cases;
dense matrices for a handful of selections at bin, contig and genome level; and
`pixels_for_genome_pair` for two pairs.

**Exact integer equality is the bar** for counts. Anything less and a silent off-by-one in the
symmetry logic survives to production.

**Exit criteria:** fixtures generate reproducibly from a pinned metacooler version; golden JSON
committed; a Python test asserts the goldens still match after a metacooler upgrade.

---

## M1 — Reader core, headless (2 weeks)

No UI, no canvas. Runs in Node under vitest, since h5wasm works outside the browser — which makes
this milestone fast to iterate and trivial to CI.

### Tasks

1. **`parseUri`** — mirror `metacooler.uri.parse_uri` exactly, including `file::` → `/` and the empty
   file-part error. Table-driven tests.
2. **h5wasm bootstrap** in a worker context, lazy-loaded on first open.
3. **`LocalFileSource`** — mount a `File`/`Buffer` into the Emscripten FS.
4. **`readTable`** — the only place raw datasets are touched.
   - `S<n>` → `TextDecoder('utf-8')`, strip trailing NULs. **Not** ASCII.
   - int64 → `Number` at read time for offsets and ids; resolve `count` dtype once.
   - Column set is discovered, never hard-coded, so optional metadata columns flow through.
5. **`detect.ts`** — layout detection in the spec's order (mmetacool → metacool → mcool → cool), then
   the acceptance gates: format version, `contig-ordering == "genome-then-length"`, `bin-size`
   resolved through an `_int_attr` mirror (string sentinels, integral floats, boolean rejection) and
   positive with `bin-type != "variable"`, `storage-mode` read not assumed. Each rejection throws a
   typed error carrying the file's actual value. **Port `_int_attr` verbatim** — this is correction #3
   and the one most likely to be got wrong by writing idiomatic JS.
6. **`MetaCooler.open`** — read attrs, `/genomes`, `/contigs`, `chrom_offset`, `genome_offset`.
   Normalise `info` the way Python does (`metacooler-format` → `format`, `contig-ordering` →
   `ordering`, `genome-assembly` → `assembly`, numerics to plain numbers, `metadata` excluded).
7. **`coords.ts`** — fixed-bin arithmetic from `chrom_offset` + `contigs.length` only.
   `bins_in_contig`, `bin_index`, `bin_start`, `bin_end`, with the short-last-bin `min()`.
   **Add the test that fails if `/bins` is ever opened.**
8. **Extents** — `extent`, `offset`, `contigExtent`, `genomeExtent`. Under the accepted ordering
   `genomeExtent` always succeeds; keep the contiguity assertion anyway as an invariant check, since
   it is free and it catches a mislabelled file.
9. **`parseMetacoolerRange`** — genome-first precedence; coordinate suffix on a genome name is an
   error; `__unbinned__` gets its own distinct refusal; unknown labels list genomes and contigs
   truncated to ~20.

**Exit criteria:** every golden oracle from M0 reproduces exactly, in Node, for every accepted
fixture; all refused fixtures throw the right typed error; the `/bins` guard test passes;
`dropped.metacool` exposes its genome 0 as a normal MAG; `floatcount.metacool` reads without
precision loss.

---

## M2 — Matrix queries (1.5 weeks)

### Tasks

1. **Bounded read path** — slice `bin1_offset[i0 … i1+1]`, then the corresponding contiguous
   `bin1_id` / `bin2_id` / `count` span. Nothing else.
2. **Dense guard** — mirror `_check_dense_size` with the same constant, `DENSE_MATRIX_BIN_LIMIT =
   50_000`, and reuse its hint wording verbatim so browser and CLI say the same thing.
3. **Scatter to dense** — COO → `Float32Array`, with the int32 / int64 / **float64** count path
   resolved once at open (correction #2). Float counts must not be rounded.
4. **Symmetry.** On-diagonal: mirror across the diagonal. **Off-diagonal where the column range
   precedes the row range: query the transpose and flip.** Respect `storage-mode == "square"` by
   skipping mirroring entirely.
5. **Aggregation** — contig and genome roll-up computed from an already-loaded genome matrix, using
   `/bins/chrom`… *which is not read*: derive bin → contig from `chrom_offset` by binary search
   instead. Accumulate in `Float64Array`.
6. **Genome pair** — both genomes contiguous, so one rectangular query.

**Exit criteria:** bin-, contig- and genome-level matrices match golden with exact integer equality,
including at least one off-diagonal pair in each orientation (g1×g2 and g2×g1). A deliberately
transposed test that would pass if step 4 were skipped, and fails loudly.

---

## M3 — Render and first visible app (2 weeks)

The first milestone with something to show, and the first that can be demoed.

1. **Canvas heatmap** — `ImageData` → offscreen canvas at matrix resolution → `drawImage` scaled to
   display.
2. **`show` parity** — `log1p`, `afmhot_r`, `vmin = 0`, `vmax` = 99th percentile of non-zero
   *transformed* values, separators at boundaries.
3. **Genomes table landing view** — sortable and filterable, generic rendering of optional metadata
   columns, `__unbinned__` absent with no toggle, the free `bin1_offset` density proxy as a labelled
   column, and the unassigned QC statistic in the info panel.
4. **Genome, pair and region views**; breadcrumb; URL-hash view state.

**Exit criteria:** a perceptual-diff test against `metacooler show` output for three fixtures, within
a small tolerance. If the browser and CLI disagree visibly, one of them is wrong and it matters for
the paper's figures.

---

## M4 — Interaction (1.5 weeks)

Small, because the spec deleted most of it. There is no tiling, no LRU cache, no progressive refine.

1. Pan and zoom as canvas transforms over the in-memory matrix.
2. Level toggle (bin ↔ contig) computed locally.
3. Cross-navigation: click an off-diagonal cell → that pair; breadcrumb to go back up.
4. mmetacool handling: integer entry names → zoom ladder wired to the zoom control; otherwise an
   entry picker. Exact integer nesting (`k = resolution / base`), no interpolation.

**Exit criteria:** an instrumented test asserting **zero** network or file reads during pan and zoom
within a loaded genome, and sustained 60 fps on the largest fixture.

---

## M5 — Remote sources (2 weeks)

**Do the spike before the milestone.** Host one `basic.metacool` on the real bucket and, in ~30 lines,
open it with h5wasm over range requests in a worker and print `/genomes`, with the network tab open.
This tests CORS, range support, the `HEAD`-before-`GET` behaviour and request count at once. If it
returns the table in a handful of requests, the milestone is routine.

1. **`RemoteRangeSource`** via `FS.createLazyFile` (h5wasm's `lazyFileLRU` demo is the reference).
2. **Bucket configuration** — `Accept-Ranges`, CORS exposing `Content-Length`/`Content-Range`,
   `Content-Type: application/octet-stream`, long TTLs. Public URLs, not presigned — presigned URLs
   are single-method and break the `HEAD` probe.
3. **Request instrumentation** — count requests and bytes per view change, surfaced in a debug panel.
4. **Budget tests in CI** — the spec's §12 numbers as hard assertions against a hosted fixture.

**Exit criteria:** all §12 budgets met. If open exceeds ~20 requests, do not proceed to M6 — diagnose
first, and only then consider `hdf5-indexed-reader` as the fallback.

---

## M6 — bigWig tracks (1 week)

`@gmod/bbi`, local via `generic-filehandle2`, remote via its `RemoteFile`. Binned fetch at view pixel
resolution using bigWig's own zoom levels. Shared `Scale` object with the heatmap.

**The contig-name intersection report is the deliverable, not a nicety** — on load, intersect the
bigWig chrom list with `chromnames` and display the overlap ("412 of 418 contigs matched"). The
`mismatched.bw` fixture exists to test that a zero-overlap load is loud.

Budget an hour for the ESM/CommonJS bundler friction.

---

## M7 — cool and mcool, region level (1 week)

Synthesise the single-genome view (one `/genomes` row, all `genome_id = 0`,
`genome_offset = [0, n_contigs]`) so no downstream path branches. Entry point is the **contigs**
table, not the genomes table. Whole-genome and whole-chromosome selections are size-guarded and
refused with the CLI's wording. `.mcool` resolution levels drive the zoom control exactly as
mmetacool entries do.

---

## M8 — Catalog, deploy, benchmarks (1.5 weeks)

1. **`scripts/make_catalog.py`** — standalone, in this repo. Per file: URI, ngenomes, ncontigs, nnz,
   sum, bin size(s), ordering, assembly, taxonomy summary, byte size, schema version. The app browses
   100+ files without opening any. For each published file also emit the genome-level edge list via
   `metacooler network --level genome --header`, and reference it from the catalog — that is what
   makes spec §7.3's overview instant remotely. Existing CLI, no new API.
2. **Deploy** to GitHub Pages; bucket for data; Zenodo for archival with a version scheme.
3. **Benchmark harness** producing the paper's figure: one `.metacool` vs N separate `.cool` files for
   size, open time, per-genome extraction and memory across a few hundred MAGs; plus browser request
   counts and time-to-interactive.

---

## Sequencing and risk

```
M0 ──► M1 ──► M2 ──► M3 ──► M4 ──► M5 ──► M6 ──► M7 ──► M8
                             │
                     first demo-able
```

Roughly **12–13 weeks**, single developer, with M0–M3 being the half that determines whether the rest
is routine.

| Risk | Signal | Response |
|---|---|---|
| Remote HDF5 too chatty | M5 spike exceeds ~20 requests to open | Diagnose metadata layout; `hdf5-indexed-reader` as fallback. **Does not change any file format.** |
| A MAG is larger than assumed | M3 stalls on a real file | Only affects unusually large genomes; region-level path already exists as the escape |
| Docs diverge from `devel` | M1 goldens fail after a metacooler bump | The M0 golden-regeneration test catches it at the boundary |
| `@gmod/bbi` bundler friction | M6 build errors | Known, ~1 hour |

**The de-risking order is deliberate:** correctness against Python (M0–M2) before anything visual,
and the network spike before committing to M5. The two things most likely to be wrong are the
symmetry/transpose logic and the remote request count, and both are provable early and cheaply.

---

## Definition of done

- Every accepted fixture opens and renders; both refused fixtures produce their named error.
- All golden matrices match with exact integer equality.
- §12 request budgets hold in CI against a hosted file.
- Pan and zoom inside a loaded genome perform zero I/O.
- No code path reads `/bins`.
- `__unbinned__` is unreachable as a view; the QC statistic is present.
- A private file dropped on the page renders without a single network request leaving the browser.
