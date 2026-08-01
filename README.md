# metacooler-viewer

A browser-based viewer for [`.metacool`](https://github.com/js2264/metacooler) multi-genome
(metagenomic) Hi-C contact maps.

Drop a file on the page and you get a sortable table of every MAG in it, the intra-genome contact
map of any one of them, and — the part no other browser does — the rectangular off-diagonal block
between *two* MAGs, which is where phage–host, plasmid–host and HGT signal lives.

There is no server. There is no upload. There is no preprocessing step. A file straight out of
`metacooler create` opens and works.

---

## The three constraints, and why they are the whole design

Everything below follows from these. They are stated first because most of what this project does
*not* do is a direct consequence of them.

**No backend of any kind.** No tile server, no metacooler process on a host, no accounts. The
viewer is static files; the data are objects on a bucket, or a file on your disk. This is what makes
the app free to run, free to archive, and impossible to take offline.

**Nothing is uploaded.** A local file is handed to a worker by reference and read in place through
the Emscripten filesystem. Nothing crosses the network, which is why there is no account system, no
storage, no hosting cost and nothing to review for GDPR. You can open unpublished patient-derived
metagenomes on a laptop with the network cable out.

**No preprocessing, and no companion file is ever required.** Two optimisations exist — a `zoomify`
resolution ladder and a genome-level edge list from `metacooler network` — and both are strictly
opportunistic. A plain `.metacool` behaves identically, minus the extra speed.

The architectural bet that makes all three affordable is that **MAGs are small**. A bacterial genome
is 2–6 Mb, so at 1–5 kb bins a single MAG's matrix is at most a few million cells and its non-zero
pixels are a bounded, contiguous slice of `/pixels`. One genome is therefore *one bounded read*,
held whole in memory, after which pan and zoom are pure canvas transforms with **zero** further I/O.
That is the central difference from HiGlass, which has to stream a 3 Gb genome and needs a tile
server, a tile cache and progressive refinement to do it. None of that is built here, because none
of it is warranted.

Two things break the small-MAG assumption, and both are handled as exceptions rather than as the
general case: `__unbinned__` (never displayable) and non-metagenomic coolers (region level only).
Both are covered under [Scope](#scope-what-this-is-not) below.

---

## Running it

### Node on this machine

Node is not on the system `PATH` here. Put it there first:

```bash
export PATH=/pasteur/helix/users/jaseriza/opt/node-v24.18.1-linux-x64/bin:$PATH
node --version   # v24.18.1, npm 11.16
```

`node_modules/` is already installed — **do not run `npm install`**.

> **Known limitation of this host.** `vite` and `vitest` both load `rollup`, whose native binary
> (`@rollup/rollup-linux-x64-gnu`) requires `GLIBC_2.29`; this machine has glibc 2.28, so
> `npm run dev` and `npm test` cannot start here. `npm run typecheck` and `npm run fixtures` are
> unaffected. Everything runs normally on any host with glibc ≥ 2.29.

### Commands

```bash
npm run dev        # vite dev server; open the printed URL and drop a file on the page
npm run build      # tsc --noEmit && vite build  →  dist/
npm run preview    # serve the built dist/ locally
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run fixtures   # regenerate test/fixtures/ and test/golden/
```

`npm run fixtures` shells out to Python and needs an interpreter with `metacooler` installed:

```bash
METACOOLER_PYTHON=/pasteur/helix/users/jaseriza/repos/metacooler/.venv/bin/python npm run fixtures
```

It uses **only** the public `metacooler` and `cooler` CLIs — no hand-written HDF5 — and then exports
one golden JSON per fixture straight out of the Python API. `test/fixtures/` is generated and
gitignored; `test/golden/` is committed, so a `metacooler` upgrade that changes the format fails at
the golden boundary rather than somewhere in the middle of the app.

Large real-world files live in `data/` and are gitignored. Tests that need them
(`test/unit/real-file.test.ts`) skip with a named message when they are absent.

---

## Repository layout

```
src/
  types.ts constants.ts errors.ts format.ts uri.ts   # the shared contract
  sources/       ByteSource implementations: LocalFileSource, RemoteRangeSource
  h5/            the only code that imports h5wasm or touches raw HDF5 bytes
  metacooler/    the reader: detect, MetaCooler, coords, range, matrix, aggregate
  worker/        message protocol; the worker owns all I/O
  render/        canvas heatmap, matplotlib LUTs, colour scale, colourbar
  state/         ViewState and its URL-hash serialisation
  ui/            file picker, genomes/contigs tables, genome/pair/region views, errors
  main.ts        the app shell
scripts/
  make_fixtures.py  make_golden.py  gen_luts.py
test/
  fixtures/ (generated)   golden/ (committed)   unit/
docs/
  hosting.md     bucket configuration for published files
  deploy.md      publishing the app itself to GitHub Pages
SPECS.md         the specification — section numbers are cited throughout the source
IMPLEMENTATION.md  the build plan, and nine corrections where the docs were wrong
```

Two layering rules are enforced rather than encouraged, because breaking either is silent:

- **`h5wasm` is imported only under `src/h5/`.** That is what makes the local and remote paths
  identical everywhere downstream.
- **`/bins` is never read.** With fixed bins the entire coordinate model is arithmetic over
  `indexes/chrom_offset` and `contigs/length`, so one of the four large tables in the file is never
  touched — not on open, not per view, not over the network. `test/unit/real-file.test.ts` records
  every dataset path the reader touches while loading a MAG and fails if `/bins` appears.

---

## What is implemented today

Read against the milestones in `IMPLEMENTATION.md`. This section describes the code that is on disk,
not the plan.

| | Milestone | State |
|---|---|---|
| M0 | Fixtures and golden oracles | **done** — 13 fixtures, 13 goldens + manifest, regenerated by one command |
| M1 | Reader core, headless | **done** — URI parsing, detection and acceptance gates, `MetaCooler`, fixed-bin coordinates, extents, range parsing |
| M2 | Matrix queries | **done** — bounded reads, dense-size guard, COO → dense, transpose handling, contig/genome roll-up |
| M3 | Render and first visible app | **done** — canvas heatmap with matplotlib's own LUTs, `metacooler show` defaults, genomes table, genome/pair/region views, breadcrumb, URL-hash state |
| M4 | Interaction | **mostly** — pan, zoom, level toggle and cross-navigation are all local and I/O-free; the mmetacool *zoom ladder* is classified but not yet wired to a zoom control (see below) |
| M5 | Remote sources | **done** — `RemoteRangeSource` (range probe, LRU chunk cache, the two distinct §10 refusals), `docs/hosting.md`, and the §12 request-budget regression tests in `test/budgets/` |
| M6 | bigWig tracks | **not started** — no `src/tracks/`, and the `.bw` fixtures are not built |
| M7 | cool / mcool | **done** — opened natively, not as a synthesised one-genome metacool: a cooler's `/chroms` is the contig table, `genomes` is `null`, and the contigs table is the landing view. An `.mcool` root is refused by name and the app opens its finest resolution; the ladder is the entry picker. A second, browser-side dense cap refuses the whole-chromosome blocks the CLI-parity limit would wave through |
| M8 | Catalog, deploy, benchmarks | **partly** — a GitHub Pages workflow builds and publishes the app (`docs/deploy.md`); no `scripts/make_catalog.py` and no benchmarks |

Other gaps worth naming rather than discovering:

- **The mmetacool resolution ladder is inferred but not driven.** All-integer entry names are
  correctly recognised as a `zoomify` ladder (and the entry names *are* the bin sizes — the test
  suite checks that, and that the levels nest by exact integer ratios), but the entries are not yet
  wired to a zoom control. Today both a ladder and a sample collection present the same entry
  picker, with different explanatory text.
- **Balancing is unavailable, deliberately.** SPECS §6.4 offers a weights toggle "if a weight column
  exists in `/bins`"; SPECS §3.3 says `/bins` is never read. The two cannot both hold, and the
  implementation keeps §3.3 — a balance request is refused with a message pointing at
  `metacooler show`. This is a real divergence from the spec text and should be resolved there.
- **The genome × genome overview** is implemented and correctly gated (explicit action, progress,
  cancellable; refused over HTTP above a size threshold; instant when a `metacooler network
  --level genome` edge list is advertised), but has not been exercised end-to-end on a large remote
  file.

Tests currently live in `test/unit/`: `reader-core`, `render`, `viewstate`, `real-file`,
`mmetacool`.

---

## Scope: what this is *not*

Every item here is a decision that removed code, not a feature that ran out of time.

**Fixed-bin files only.** `bin-type = "variable"` — fragment-level and contig-level metacools — is
refused at open, with a message naming the file's actual bin type and pointing at
`metacooler binnify`. Excluding variable bins is what makes the coordinate model pure arithmetic and
what deletes every read of `/bins`.

**`contig-ordering = genome-then-length` only.** Any other ordering is refused, naming the ordering
the file actually has. Only a genome-grouped layout puts each genome in one contiguous block of
bins, which is what makes a genome — or a genome *pair* — a single bounded read. The known cost is
real: files built from a cooler (`cool` ordering) or from a FASTA-ordered assembly are excluded.

**`__unbinned__` is never displayable.** The reserved genome holding every contig that binning
failed to assign is not a genome, and it breaks the small-MAG assumption outright. It is absent from
the genomes table with no toggle, not selectable as either axis of a pair, and refused as a range
label with its own message rather than a generic "unknown name". It is matched by **name**, never by
index, because `create --drop-unassigned` omits the row entirely and makes genome 0 an ordinary MAG
in exactly the files that were binned best.

Nothing is renumbered to make it disappear: `genome_id`, `genome_offset` and every bin index stay
exactly as written, and exclusion happens at selection and display time only. The single exception
is one read-only QC statistic in the file info panel — *"unassigned: 67,058 contigs / 23.8% of
bins"* — because that fraction is a direct diagnostic of binning quality that a metagenomics reader
will look for. It is a number, not a view: it opens nothing and selects nothing.

**cool and mcool are region-level only, and this is not a HiGlass replacement.** A eukaryotic cooler
reintroduces exactly the streaming problem the design avoids, so those files are supported as
*browse a region*, never *view the whole genome*: the entry point is the contigs table, a
`chrom:start-end` selection loads through the same bounded-read path as a MAG, and whole-chromosome
or whole-genome selections are size-guarded and refused with the CLI's own wording. The claim is
zero-install regional inspection of any cooler, **plus** a genome hierarchy that HiGlass has no
concept of — not a general Hi-C browser.

### Non-features

Stated as decisions so they are not mistaken for omissions: no tile server; no user accounts; no
file upload; no server-side computation of any kind; no required companion files; no required
preprocessing; no support for orderings other than `genome-then-length`; no whole-genome views of
eukaryotic coolers; **no write access of any kind** — the viewer never modifies a file.

---

## Correctness

The reader is a mirror of the Python `MetaCooler`: same names, same semantics, same error text.
Where this repo and `metacooler/api.py` disagree, this repo is wrong.

That is enforced rather than asserted. `scripts/make_golden.py` exports, from Python, the `info`
block, both tables, all three index arrays, every genome extent, a battery of range strings
including the error cases, thirteen dense matrices at bin/contig/genome level, and
`pixels_for_genome_pair` records — and **exact integer equality is the bar** for anything derived
from counts. Two failure modes justify that on their own: the upper-triangular transpose (get it
wrong and every inter-genome panel is silently blank), and the aggregation fold (get it wrong and
every contig-level diagonal is silently doubled, which reads as "the diagonal is strong" rather
than as a bug).

`test/unit/real-file.test.ts` adds the check that fixtures cannot make: it opens a real 26 MB,
4,395-MAG MetaTOR output and asserts numbers that were read out of the file with `h5py` before any
of this code existed.

---

## Documents

- `SPECS.md` — the specification. Source files cite its section numbers (§3.3, §7.4, …) at the
  points where a decision is not obvious from the code.
- `IMPLEMENTATION.md` — the build plan, plus nine corrections where the metacooler documentation
  disagreed with the metacooler source. Those corrections are load-bearing; the one most likely to
  be re-broken is that `bin-size` can be the *string* `"null"`, so it must go through a verbatim
  port of Python's `_int_attr` rather than `Number()`.
- `docs/hosting.md` — the bucket configuration a published `.metacool` needs, and why GEO and SRA
  cannot serve as hosts.

## Licence

MIT.
