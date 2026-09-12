# Feature gap analysis

> **Status, 2026-08-12.** Six of the eleven items below are built and on
> `claude/feature-gap-analysis-ri17pl`: **G1** (`.hic`), **G3** (per-map results,
> the overlay, interactive figures), **G4** (`metacooler-run`, as a CLI rather
> than as emitted snippets), **G5** (found already landed; the equivalence suite
> it was waiting on is now written), **G6** (tabix) and **G8** (bedGraph and
> wig). A Share button was built in place of G7's embed mode. What remained
> unbuilt was **G2**, **G7**, **G9**, **G10** and **G11** — and G2 is still the
> highest-value item in the document.
>
> **Since, G7 is built**: `?embed=1`, `?config=<url>` and a four-message
> `postMessage` channel, specified at SPECS §21 and demonstrated in the README.
> The share link it was once traded against turned out to be half of it — an
> embed's payload seed is `#session=`, unchanged — and the other half found a defect
> that was already there, which is that a frame writing `pushState` spends the
> host page's Back button.
>
> **Since, G12 is built**: `.pairs` files import into a map at a resolution the reader
> chooses, with a ladder derived in the same pass and an `.mcool` written back out —
> specified at SPECS §3.7, with the §18.9 clause it required narrowed there rather than
> quietly stepped around. It is the first input this app *imports* rather than opens,
> and the first file it writes that another tool will read as a format rather than as a
> picture.
>
> Three defects were found on the way and are worth naming here, because each was
> silent: `.hic` is little-endian and a self-consistent reader and writer had
> agreed it was not; a v9 straddle clause lost every near-diagonal block while
> leaving the distant ones correct; and a deck's analysis results were keyed by
> task alone, so a batch of four kept one figure and a saddle over a deck drew
> panel B's compartments out of panel A's numbers.


A scan of the source and of every companion document, against one question: **what would a reader
of this app go and open a different tool for?**

Nothing here is a bug and nothing here is polish. Every item is a capability that is absent, that
somebody would notice is absent, and that can be built **without breaking C1–C3** — no backend, no
upload, no required preprocessing, no write access to an opened file. An item that needs a tile
server, an account or a compute service is not in this document; those are settled at SPECS §13 and
are not reopened here.

The competition is read as: **HiGlass** (tiles, composition, embedding), **Juicebox / juicebox.js**
(`.hic`, whole genome, share links), **igv.js** (format breadth, assembly registry, embeddability),
**cooltools / coolpuppy / FAN-C / HiCExplorer** (the analysis this app already goldens against), and
— for the primary format — **anvi'o, bin3C, MetaTOR, ProxiMeta**, none of which is a browser.

Ordered by what I would do first, within three tiers. Each item names the code it lands in and the
spec clause it touches, and says where it is *not* what a stated non-feature already refused.

---

## Tier 1 — the three that change who can use this

### G1. Read `.hic`

**The gap.** The app opens `.metacool`, `.mmetacool`, `.cool` and `.mcool`, and nothing else.
`.hic` appears in this repository exactly once, in `TASKS_PLAN.md:631`, as *"a format this app does
not read"*. That single sentence is the largest limit on the app's reach: the majority of published
mammalian Hi-C — 4DN, ENCODE, most GEO submissions of the last eight years — is distributed as
`.hic` and nothing else. A reader with a `.hic` cannot open this app at all, cannot get to the
Analysis panel, and cannot get to the deck. They go to Juicebox.

**Why it fits rather than fights.** `.hic` is *better* suited to §2's bet than HDF5 is, not worse:

- It is block-indexed with a master index at a known offset, so a region is a bounded range read —
  the same shape `RemoteRangeSource` already serves, with **fewer** round trips than an HDF5
  metadata walk (which is what §12's twenty-request budget exists to police).
- It carries a resolution ladder in the file, unconditionally. That is `src/ui/refine.ts`'s ladder
  handed over for free, and it makes §3.4's rule — *a ladder is an accelerator, never a requirement*
  — trivially satisfied.
- It carries its normalisation vectors (`VC`, `VC_SQRT`, `KR`, `SCALE`) in the file, which is the
  `hasWeights` path `src/render/derive.ts` already models.
- Reading it is still one bounded read drawn whole. **No tiles are assembled.** §14's invariant
  holds unchanged.

**Cost, honestly.** Not small, and concentrated in one place. A reader under `src/hic/` behind the
existing `ByteSource` is a known quantity (the format is documented and `hic-straw` is a working
reference). The real work is that `src/analysis/run/*` walks `MetaCooler`'s `/pixels` directly —
twelve adapters written against one storage layout. They need a `PixelSource` seam: *give me the
stored records for this bin window*. That seam is worth having on its own merits, and it is the
whole of the risk. `detect.ts` gains a magic-number branch above the HDF5 one; `Layout` gains a
kind; `genomes` is `null`, exactly as for a cooler.

**What it does not get.** `.hic` has no genome hierarchy, so it is a cooler-class citizen: contigs
table, regions, tracks, the twelve non-MAG tasks. That is the right shape.

---

### G2. The metagenome's actual question: host assignment for unbinned contigs

**The gap, and it is a sharp one.** The README's second sentence sells the off-diagonal MAG × MAG
block as *"where phage–host, plasmid–host and HGT signal lives"*, and §5.3, `ui/PairView.ts` and
`ui/Overview.ts` all draw it. But there is **no task that answers the question**, and worse:

> `__unbinned__` contacts are dropped from every metagenome accumulation
> (`src/analysis/run/mags.ts:10`, SPECS §18.8).

Phages are not binned. Plasmids are usually not binned. Small mobile elements are not binned. They
are, by construction, in `__unbinned__` — so the one part of the file where the app's headline
biology lives is the one part every analysis task refuses to touch. `MAG_PURITY_TASK` computes the
right quantity (per contig, contacts out to each MAG, plurality partner) for exactly the contigs
that do not need it.

**The feature.** A *host linkage* task: given a set of contigs — pasted names, a BED, a
`genomad`/`CheckV`/`geNomad` output, or simply "every `__unbinned__` contig over N kb" — rank the
MAGs each one contacts, normalised for MAG bin count and MAG depth, with a null expectation from the
file's own inter-MAG background and a score that separates a real link from the trans floor. Output
a ranked table (contig, MAG, contacts, normalised score, rank ratio to the runner-up), exportable as
TSV and as a per-contig BED, and a click that opens the pair view for that contig × that MAG — which
is the picture this app already uniquely draws.

**On §7.4.** This does not violate it. §7.4 forbids `__unbinned__` as a *view* — not selectable as an
axis, absent from the genomes table — and §7.4 itself already carves out the unassigned QC statistic
because *"it is a number, not a view"*. A ranked table of contig→MAG scores is the same kind of
object, and it is the diagnostic the format exists to make possible.

**Why it is the highest-value item in the document.** Every other item on this list closes a gap
against a tool that exists. This one is a capability **no competitor has, in a niche the app already
owns**: bin3C, MetaTOR and ProxiMeta produce host assignments in a pipeline, offline, as a table
nobody can interrogate. Nothing lets you see the block the call was made from. This app is one task
away from being the reference tool for metaHiC host assignment, and it is currently zero tasks in.

**Cost.** Low relative to its value. `src/analysis/mags.ts`'s accumulator already walks the right
pixels; what changes is that a genome id of `-1` stops being discarded and starts being a row key,
behind a task that asks for it explicitly. One new descriptor, one new `run/` adapter, one golden.

---

### G3. One figure across the deck

**The gap.** `AnalysisRunner.runAll` (`runner.ts:353`) queues a task against every panel of a deck
and produces N results — and then `this.results.set(step.task.id, result)` at `runner.ts:599` keys
the cache by **task id alone**, and the drawer shows one plot per run. So a reader with four
libraries side by side can compute four P(s) curves and cannot put them on one axis.

That is the single most-drawn figure in the Hi-C literature. It is the figure people leave a browser
for. `CurveOutput` is **already multi-series** (`ui/analysisPlots.ts:53`, with a legend, colours and
band drawing), so the picture is built; what is missing is that nothing ever hands it series from
more than one file.

**This is not §18.9's refusal.** §18.9 declines *differential* APA and *differential* insulation, and
the argument given is precise: subtracting one track from another is a worse version of a picture the
app can already make. Overlaying N curves is not a subtraction, is not derived, and is a picture the
app **cannot** make. The two are different claims and the second one is unargued.

**Cost.** Small. Key the result store by `(task.id, target.map)`; give the drawer a *combine* mode
that folds the held results for one task across targets into one `CurveOutput` with a series per
panel, named by the panel's own label. Applies immediately to P(s), coverage, insulation-at-a-window,
4C and the saddle. Falls out for free on the metaplot and APA, which are the other two comparisons
worth having.

---

### G12. Read the format the data actually arrives in — **built** (SPECS §3.7)

**The gap.** Every format this app read was a *matrix*, and a matrix is what a pipeline produces at
its end. The thing a reader has on disk after running one — and the thing this project's own
`data/README.md` starts from — is a `.pairs.gz`: the contact list, before anybody chose a bin size.
Turning one into something openable meant leaving the browser for `cooler cload` or `metacooler
create pairs`, which is exactly the preprocessing step C3 exists to deny, applied to the one input
where the app could not deny it.

**Why it fits rather than fights.** The objection to reading contacts is §13's, and it is about
*alignments*: a viewer that builds matrices from a BAM is two applications, because it would have to
decide what a contact is — mate pairing, mapping quality, duplicates, restriction fragments,
ligation junctions. A `.pairs` file is the output of that decision, made by a pipeline, recorded in
a header. Binning a contact list is a histogram, not a method. Nothing about strands, pair types or
mapping quality is read or re-decided; a reader who wants different records runs `pairtools select`
and imports the result.

**What made it affordable** is the shape of the data rather than any cleverness: the input is
gigabytes and the output is tens of megabytes — 179 M records to 13.7 M pixels on `demo/yeast/` —
so the file is read once, at open, and every view afterwards is free. Measured at 2.9 M records/s
against a decompression ceiling of ~195 MB/s, which is the platform's floor and not this code's.

**What it cost doctrinally**, paid at §18.9 rather than avoided: writing a `.cool` was refused, and
the refusal's own reason turns out to be about a matrix *derived from an opened map*, where
provenance, balancing and the bin table are choices the app would be making for the reader. A file
binned from a `.pairs` answers all three from its input. The clause is narrowed there, in the open,
with the golden that the narrowing requires.

**What it did not buy.** A genome layer. `#chromsize:` has no concept of one, so an imported map is
a cooler-class citizen and the four metagenome tasks are absent — G2 still wants a `.metacool`, and
getting one in the browser would need the contig and genome tables as a second required companion
file, which is C3's line.

---

## Tier 2 — real gaps, bounded work

### G4. Emit the code that reproduces the run

Every result already carries a `Provenance` and the drawer has *copy provenance* (`AnalysisDrawer.ts:424`)
— as prose. One step further is the differentiator: **a runnable snippet**. Each `AnalysisTask` already
carries typed, named parameters and each result already carries its framing, so a `script(params,
framing)` on the descriptor can emit the eight lines of `cooltools` / `coolpuppy` / `numpy` that
recompute the same number from the same file, and the session can emit the whole notebook.

Nobody does this. HiGlass exports a view config; Juicebox exports a link. Neither closes the loop
between *the figure I made in a browser* and *the methods section I have to write*. This app is
uniquely placed to, because §18.10 already pinned every kernel to the reference implementation the
snippet would name — the goldens are the proof the emitted code is honest. It is also the cheapest
possible answer to the reviewer's question *"what tool produced this?"*, and it costs no runtime,
no dependency and no server.

### G5. Stream the pixels into the pooled raster (§8.17 of the performance review)

Not a new idea — it is `docs/performance-review.md` §1.2 and §8.17, measured by its author and
recorded at §9.2 as *not landed*: **82 MB and 3.4 s against 2,370 MB and 6.8 s**, same bytes, same
picture. The dense `Float32Array` is materialised only to be collapsed to a raster bounded at
`RASTER_MAX_DIM`.

This is on the list as a **feature** rather than as an optimisation, because of what it unlocks:
`checkBrowserDenseSize` refuses on `cells * 4` (`metacooler/matrix.ts`), so the thing standing
between this app and a genome-wide view of a large cooler is an allocation the picture does not
need. Landing §8.17 moves the ceiling from *"a block whose cells fit in memory"* to *"a block whose
picture fits on a screen"* — which is a different and much larger set of files, and it gets there
with **no tiles, no tile server and no composition**, so §13 and §14 survive intact. The prerequisite
(`forEachPixelSpan`, chunked reads) is already in the tree.

The perf review's own caution stands and should be honoured: a second render path with its own
equivalence suite, deliberately, not as a tail item.

### G6. Tabix, for feature files over the network

The app does bounded range reads for HDF5 and for bigWig, and then fetches a **whole** GTF and parses
it (`annotations/parse.ts`; the demo GTF is 9.5 MB / 41,566 lines, and GENCODE is five times that).
A `.gz` + `.tbi` companion is the same bounded-read model the rest of the app is built on, and it is
opportunistic in exactly §3.4's sense — a plain GTF still works, minus the speed.

This is what makes gene models over a bucket as cheap as a bigWig, and it is the difference between
"the app supports GTF" and "the app is usable with a human annotation on a hotel connection". BGZF
inflation is `DecompressionStream` per block, which `parse.ts` already reaches for.

### G7. An embeddable mode — **built** (SPECS §21)

`package.json` says *an application, not a library*, and that is right about npm. It was never an
argument against an **embed mode**: `?embed=1` for chrome-less rendering of one view, the hash API
that already exists as the documented contract, and a `postMessage` channel for *go here* / *tell me
where you are*.

HiGlass's reach comes overwhelmingly from being embeddable — in portals, in supplementary material,
in Jupyter. This app had the two hard prerequisites already: a complete URL state model
(`state/ViewState.ts`) and archived immutable builds at `…/v/<commit>/` (`docs/deploy.md`), which
means an embed in a 2026 paper still renders in 2031. That combination is genuinely rare and was
unexploited. It needed no backend, no accounts, no npm publish and no second bundle — and it got
none of them.

**What was built**, over `src/embed.ts`, `app/EmbedChannel.ts` and four gates elsewhere:

- `?embed=1` mounts the same web build without the header, the tab strip, the restore slot or the
  status bar, and turns off the service worker and the version notice with them. In their place is
  one bar: the mark and the name — a link out to this same view in the full application — the file's
  breadcrumb, and on the right the Annotations and Aesthetics toggles and **About**, which is where
  an embedded figure says what it is, that nothing is uploaded, and which build drew it.
- **Two of the five columns stay**, folded, standing as their own spines on either edge: Annotations
  and Aesthetics are controls over the picture, and the other three are about the window. The fold
  was the surprise, and it was measured rather than reasoned — a column is open until somebody folds
  it, so the first real embed of the yeast figure came up in a 1,200-pixel frame with five open
  columns and thirty-two pixels of map between them. Worth noting for its own sake: **the full app
  does the same thing** on a fresh profile at 1,400 pixels with a file that offers all five, which
  is a separate question from this one and is not answered here.
- **An embed never pushes history.** This was the one real defect the exercise turned up rather than
  a feature it added: a frame's `pushState` writes into the joint session history, so an embedded
  figure was going to take over the reader's Back button on any page that used one.
- `?config=<url>` opens a published `.metacooler.json` named in the address — the pointer form of
  what `#session=` carries as a payload, through the fetch, the signing and the resolving that
  `Session.openConfigUrl` already did for the picker's URL box.
- Four messages over `postMessage`: `ready`, `state`, `where`, `navigate`. Only the framing window
  is answered, only after it has spoken, only at the origin it spoke from — and a `navigate` patch is
  parsed by §5.5's own reader rather than believed.
- The File System Access pickers are *present and throwing* in a cross-origin frame, so
  `handlesSupported`, `directoriesSupported`, `directoryPickerSupported` and `chooseFiles` now check
  the frame as well as the function. Before that, an embedded Choose-files button did nothing at all
  and the rejection was indistinguishable from a cancelled dialog.

What was **not** in it was a way to embed the viewer without depending on this project's own
hosting — and that is now built too, at SPECS §22. The package is published to npm as a *built
directory with a relative base*, so one tarball runs from a registry CDN, from a lab site's
`/viewer/`, or from any other path, with no rebuild. `package.json`'s old argument against it
survives in a narrower form: this is still an application rather than a library, and nothing imports
it. What a registry turned out to be wanted for is hosting nobody has to trust, which is a different
claim from the one `private: true` was refusing.

### G8. bedGraph and wig in

Concrete and slightly embarrassing: the app **writes** bedGraph (`analysis/write/bedgraph.ts`, and
a button in two cards) and **cannot read one**. `parse.ts` sniffs `gtf | bed | bedpe` only, so a
four-column bedGraph is taken for BED and its value column lands in `name` at `parse.ts:212` — a
segment track with no signal, silently. Every peak caller, every deepTools invocation and cooltools
itself emit bedGraph; so does this app.

Add `bedgraph` and `wig` as sniffed formats producing a quantitative lane, and let a BED's `score`
column drive one on request. Half a day, and it removes a whole class of *why does my file look
wrong*.

---

## Tier 3 — worth doing, lower leverage

### G9. Contig reassignment proposals, as a table

§18.9 declines contact-based reordering *because the ordering would have nowhere to go* — the app
cannot write a `.metacool`. That argument is sound for **ordering** and does not carry to
**assignment**: a corrected contig→MAG mapping is a two-column TSV, and DAS_Tool, anvi'o and
`metacooler create` all consume exactly that. It has somewhere to go.

MAG purity already flags the contigs whose plurality partner is another MAG; MAG split already flags
the MAGs that separate spectrally. Turning those two into a proposed binning **delta** — per contig:
current bin, proposed bin, score, evidence — is authoring an output, not editing an input, and it is
the natural end of a session spent finding that a binning is wrong.

### G10. A catalogue of published files — **built** (SPECS §24)

> **Since:** built as a *hub* — a static JSON of maps, genomes and workspaces with columns to filter
> on, drawn as a table in the picker, connectable by URL and addressable as `?hub=`. The generator is
> `scripts/make_hub.py`, with a `bucket` front end that is the `make_catalog.py` below and three
> public-store front ends — `igv`, `4dn` and `encode` — that a weekly workflow runs and publishes
> to the `hubs` branch. Those three list **every file this viewer has a route for**, not the contact
> maps only: IGV's 41 genomes and their tracks, ~25,700 files on the 4DN open-data bucket, and
> ~210,000 ENCODE rows across twelve shards, plus one pre-configured session per genome and per
> dataset that carries both a map and something to draw on it (SPECS §24.3).
> What this entry asked for that is *not* in a hub row is the per-file `ngenomes`/`nnz`/edge-list
> metadata, which needs the metacooler CLI over each file; the format has room for it (`fields`),
> and the `bucket` front end is where it would be computed.

`IMPLEMENTATION.md` M8 specifies `scripts/make_catalog.py` and the README records it as not built.
`ui/BucketsCard.ts` browses an S3 prefix, which is the folder and not a description of it: a reader
still opens files to find out what is in them. A catalogue — URI, ngenomes, ncontigs, nnz, bin sizes,
assembly, taxonomy summary, byte size — lets somebody browse a hundred published files without
opening any, and M8 already notes that referencing each file's `metacooler network --level genome`
edge list from the catalogue is what makes §7.3's overview *instant* remotely. Existing CLI, no new
API, and it is the thing that turns a lab's bucket into a resource other people cite.

### G11. A small assembly registry, and an ideogram

The 1D browser (§5.8) needs a `chrom.sizes` before it can start. igv.js and HiGlass ship assemblies.
A static JSON in the bundle — names and lengths for a dozen common assemblies, cytobands for the
handful that have them, and URLs (not bytes) for their gene models — removes the first friction step
for the cooler audience and costs a few tens of kilobytes. Cytobands additionally give the 1D browser
and the contigs bar the ideogram every other browser has. Explicitly no benefit to the metagenomics
case, which is why it is here and not higher.

---

## Checked, and deliberately not proposed

So that the absence of each is legible as a decision rather than as an oversight in the scan:

- **A tile server, tiles, or any composed picture** — §13, and the whole architecture. Not reopened.
  G5 is the constraint-compatible route to the same outcome for most files.
- **Loop and dot calling** — §18.9's argument (a half-good caller inside a viewer is a liability
  precisely because its output looks like a result) is correct and I would not overturn it.
- **Differential APA / differential insulation** — §18.9. G3 is a different claim, argued there.
- **Writing `.cool` / `.mcool` / `.metacool`** — §13, §18.9. G9 works within it, not around it.
- **KR balancing** — `render/derive.ts:80` and SPECS §7.5 settle it; ICE is the same answer.
- **Variable-bin files, non-`genome-then-length` orderings** — §3.3, §14. The judgement call recorded
  at §14 (whether the refusal message alone is enough) is a question for first users, unchanged.
- **CRAM** — refused on its own ground rather than as collateral, and the ground is stronger than
  "wrong app". A CRAM cannot be decoded without the exact reference its records were compressed
  against, identified by an M5 checksum and conventionally fetched from a third-party registry — which
  C1 and C5 forbid outright — or supplied as a second required file, which is the rule §1 has been at
  pains to keep narrow. Converting with `samtools view -b` is the answer and the folder view says so.

*(**VCF** was on this list, and is not any more.* The entry read: "it is a small indexed text format
that this app already has the machinery for (`annotations/tabix.ts`), and what it is missing is a
picture — a variant lane is not a track and not a segment set, and nobody has said what it should
look like beside a contact map." Both halves turned out to be answerable. The picture is a
**segment set**, in the sense that matters: a variant is an interval, so it packs, draws,
hit-tests, exports and collapses through the code a peak set already uses, and what a variant lane
needs of its own is a kind rather than a renderer. Beside a contact map it collapses to density,
which is the one reduction of a point set that is exact at any interval width — so a bin's worth
of variants is a true reading rather than a smear, which is what a *pile* of reads could never be
and why that one is 1D-only. Specified at §8.14, with what is still refused inside the scope —
the genotype matrix above all — listed at the end of it.)*

*(BAM was on this list, and is not any more.* The line read "real formats, wrong app — a contact-map
browser that reads alignments is two applications", and the strongest part of it was never the
formats but the *scope*: a viewer that reads alignments in order to build contact matrices from them
would indeed be a second application. That is still refused, at SPECS §13. What is *specified*
instead is narrower and is an annotation like any other: a BAM imports as two rows — a coverage
track over the genome the map is already about, and a pile of individual reads that lives only where
a base can have a pixel (§8.13). Both are built, with the pile's own controls, its per-read card,
mates and split reads. What is still refused inside that scope is listed at the end
of §8.13, and the one worth repeating here is that **no matrix is ever built from alignments** —
that was the second application this entry was drawing a line against, and it still is.
The doctrinal cost was real and is paid in the open at §1: requiring a `.bai` collides with the
C1/C3 corollary, so that corollary is now *scoped* — it protects the contact map's opening path,
which is what makes the no-preprocessing claim true — and the narrow rule that replaces it is stated
positively at §8.13 rather than left as an exception.)*
- **WebGL rendering** — the technique at §7.2 re-rasterises on three events and never on pan or zoom.
  There is nothing here for a GPU to fix; G5 is where the real cost is.
- **Accounts, sharing, collaboration** — C1.
