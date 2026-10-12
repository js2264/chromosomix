# Publishing a store

A **store** is one JSON file that names the maps, genome files and saved sessions on a bucket, with
columns to filter on, so a reader can choose one without opening any. The app draws it as a page
in the store drawer — the lab's and IGV's as cards of pre-configured sessions, 4DN's and ENCODE's
as a faceted search with a matrix, a lab's own as that search over its rows; a lab connects one by
pasting its URL under *Add a custom store* or arrives on it with `?store=<url>`. SPECS §24 is the
specification; this is the operator's page: how to write one, how to generate one, and how the
four public stores the app ships are kept fresh.

## The file

```json
{
  "kind": "chromosomix.store",
  "version": 1,
  "name": "Lab Hi-C",
  "description": "Everything under s3://my-lab/hic/, balanced at 1 kb.",
  "base": "https://my-lab.s3.eu-west-3.amazonaws.com/hic/",
  "columns": [
    { "key": "assembly", "label": "Assembly" },
    { "key": "condition", "label": "Condition" }
  ],
  "entries": [
    {
      "label": "WT, G2/M — map with tracks",
      "uri": "wt/WT_G2M.chromosomix.json",
      "kind": "workspace",
      "fields": { "assembly": "S288C", "condition": "G2/M" },
      "note": "GSE000000 · rep1+rep2"
    },
    {
      "label": "WT, G2/M (mcool)",
      "uri": "wt/WT_G2M.mcool::resolutions/1000",
      "kind": "map",
      "size": 812345678,
      "fields": { "assembly": "S288C", "condition": "G2/M" },
      "tracks": [{ "label": "CTCF", "url": "wt/WT_CTCF.bw" }]
    }
  ]
}
```

- `kind` and `version` are what the parser checks first; anything else is tolerated, and unknown
  keys are ignored, so a generator can add a column before a viewer knows it.
- `base` is the prefix relative names resolve against. Leave it out and they resolve against the
  store's own URL, which makes a store *beside its data* a self-contained folder that can be copied to
  another bucket with everything it names — the same rule a saved workspace follows.
- `uri` may carry `::group` (`::resolutions/1000`) and `#index=`/`#bins=` sidecars exactly as any
  URI the viewer takes. Dropbox and Drive share links, `gs://` and `s3://` names are rewritten to
  the form that opens when the row is picked.
- `kind` is `map`, `genome` or `workspace`. Left out, it is read from the file name: `.json` is a
  workspace, the rest route as the folder view routes them. **A workspace row is a pre-configured
  session** — tracks placed, a colour scale, the window the figure used — opened through the same
  road as `?config=`.
- `size` is bytes. Give it when you know it: the table shows it, and the load gate can ask its
  question before the first request instead of after.
- `fields` hold one value per column key; a missing key is an empty cell. `note` is free text and
  is searched by the name filter.
- `tracks` are offered from the Tracks card once the row is open, the way the demo annotations are.
- `group`, `headline` and `layout` say how the store is drawn. `group` names the field rows belong
  to — a species, a dataset — and `headline` the fields repeated once per group. The default
  `layout` is the faceted list, with a heading per group when there is a `group`; `"layout":
  "cards"` draws one card per group instead, the way IGV's genomes are: the group's
  `kind: "workspace"` row is the card's button (give it a `tracks` field, `"8"`, and the card says
  *8 tracks*), and every other row of the group is under the card's fold.

```json
{
  "kind": "chromosomix.store", "version": 1, "name": "Bacteria",
  "layout": "cards", "group": "species", "headline": ["strain"],
  "columns": [{ "key": "species", "label": "Species" }, { "key": "strain", "label": "Strain" }],
  "entries": [
    { "label": "E. coli — map with tracks", "uri": "ecoli/ecoli.chromosomix.json", "kind": "workspace",
      "fields": { "species": "E. coli", "strain": "MG1655", "tracks": "8" } },
    { "label": "E. coli", "uri": "ecoli/ecoli.mcool", "kind": "map",
      "fields": { "species": "E. coli", "strain": "MG1655" } },
    { "label": "E. coli · insulation", "uri": "ecoli/insulation.bw", "kind": "genome",
      "fields": { "species": "E. coli" } }
  ]
}
```

Serve it from anywhere that answers a cross-origin `GET` — a bucket with the public CORS policy in
[hosting.md](hosting.md), GitHub raw, a lab website. A store in a **private** prefix is read with the
bucket key that covers it, and one on a Google host with the API key or the signed-in account,
exactly as its rows will be. Nothing is fetched until a reader chooses the store.

## Generating one

`scripts/make_store.py` needs nothing but Python 3.9 or newer — no `pip install`.

```bash
# A lab's own bucket: one row per openable object under the prefix, with sizes.
python3 scripts/make_store.py bucket https://my-lab.s3.eu-west-3.amazonaws.com/hic/ \
    --name 'Lab Hi-C' --out store.json

# The four public stores (this is what the workflow runs). The first three ask
# their own APIs; DNA Zoo is a bucket with a README.json in each species' folder.
python3 scripts/make_store.py igv    --out out/igv.json    --sessions-dir out/sessions
python3 scripts/make_store.py 4dn    --out out/4dn.json    --sessions-dir out/sessions
python3 scripts/make_store.py encode --out out/encode.json --sessions-dir out/sessions
python3 scripts/make_store.py dnazoo --out out/dnazoo.json

# Validate a store — or a session — somebody else wrote.
python3 scripts/make_store.py check store.json
```

Common options: `--limit N` caps the rows for a dry run; `--timestamp` writes a dated copy beside
`--out`; `--check` re-reads everything it wrote and validates it; `--sessions-dir DIR` writes the
pre-configured sessions and `--sessions-out FILE` the store that lists them (default
`<out-stem>-sessions.json`). `--from-json`, `--from-xml` and `--from-tsv` replay a recorded
response, which is how the tests run without a network. A run that finds **nothing exits 2 and
writes nothing**, so a workflow never overwrites a good store with an empty one.

### What each front end asks, and of whom

Both portal front ends read **two** sources, and which is which matters when something goes wrong.
The *spine* says what files exist and comes from an object store, which is complete by
construction: 4DN's bucket listing, and ENCODE's `encode_file_manifest.tsv` — a gigabyte of TSV
that ENCODE rewrites daily at the root of `encode-public`. The *enrichment* says what each file is
of, and comes from one lean portal search keyed by accession. A row exists because an object
exists; a file the portal does not describe keeps its row with empty metadata cells.

`--portal` decides what an unreachable portal means:

| | |
|---|---|
| `require` (default) | fail the run and write nothing, so a store **with** columns is never replaced by one without |
| `optional` | publish the spine with the metadata columns empty — for the week a portal is down |
| `skip` | never ask; for a dry run, or a machine that can reach a bucket and not a search API |

**How much of a search to ask for at once differs by portal**, and `--page-size` is the knob:

| | default | why |
|---|---|---|
| `4dn` | 50 records a request | `limit=all` is an 83 MB answer and a live run died half way through one — `IncompleteRead(43378383 bytes read, 39983032 more expected)` |
| `encode` | `0`, meaning `limit=all` | it answers **403** to a query carrying `from`, and its whole answer is ten megabytes of scalars |

Lower it if a portal cuts responses off part-way; set it to `0` if a portal refuses `from` — a 403
on a page says so in its own message. Every whole read is retried three times when a host agrees to
answer and then stops talking. `--portal-base` points the same front end at a mirror or a staging
instance.

The filter on what gets a row is **whether this viewer can open the file name**, with one
exception. There is no experiment-type filter and no format list, which is why Micro-C, bigWigs,
peaks, pairs and BAMs are all there and why nobody has to edit the query when a consortium publishes
something new. `--formats hic,mcool` narrows it for a dry run. The exception is a BAM the viewer
could only refuse: the alignment file of a Hi-C-family assay (Hi-C, Micro-C, Capture-C, ChIA-PET,
PLAC-seq, HiChIP, TCC, MARGI, …) is in read-pair order, and reads are drawn from a coordinate-sorted
file, so the 4DN front end leaves those out, along with any BAM the portal does not describe — no
assay to judge it by, no cell to filter on. The `.pairs` and the contact map of the same set stay,
and so do the alignments of RNA-seq, ChIP-seq, CUT&RUN, Repli-seq, DamID and TSA-seq. The ENCODE
front end leaves out its Hi-C pipeline's alignments and nothing else: ENCODE's ChIA-PET alignments
are ChIA-PIPE's and coordinate-sorted (their `@HD` line says so), and a BAM the portal did not
describe keeps the cells its manifest row carries. Both lists were chosen by reading the files'
headers, not by assuming what an assay's pipeline writes.

The `igv` front end reads [IGV's own genome table][igv] — the file the IGV desktop app and igv.js
both load their genome menu from — and **probes every URL** with a ranged GET before writing a row
(`--probe off` skips it). Two things come out of one request: the size, which that table does not
carry, and the answer to *does this open without credentials*. Both of the rows it drops are worth
knowing about:

- **IGV's `refgene` tracks are no longer dropped.** 29 of its 63 tracks are UCSC `genePred` tables
  in a `.txt.gz`, and until the viewer could read one they were counted in the log rather than
  written as rows that fail when they are clicked. SPECS §8.19 reads the format — `genePred`,
  `genePredExt` and `refFlat`, with or without a MySQL dump's leading `bin` — so those rows are
  published, and most of IGV's genomes gained the gene model that is the first track anybody wants
  beside a sequence. They carry `format: genepred` whatever UCSC called the file, so one tick of the
  Format facet finds `refGene`, `ncbiRefSeq`, `refFlat` and `knownGene` together. `.2bit` came off
  the same list for the same reason (§8.21).

  A genome's cytoband table is published too. IGV names it beside the sequence (`cytobandURL`)
  rather than among the tracks, and it was dropped as an ideogram this viewer did not draw; SPECS
  §8.22 draws one, so each is a row with `format: cytoband` — even the two IGV names `.bed` — the
  first track on its genome's shelf, and an ideogram lane in its session. What is still dropped is
  two files that are not annotations of a genome: an alias file (a map between spellings, which
  §5.9 does from the files themselves) and a `chrom.sizes` (which declares a genome rather than
  annotating one).
- **Six genomes whose sequence is not public.** As of 2026-09-11, `igv-genepattern-org` answers
  `403 AccessDenied` to an anonymous ranged GET, which takes out IGV's `hg38`, `hg19`,
  `GCF_016699485.2`, `NC_016856.1` and `GCA_000182895.1`; so does one object on
  `igv.broadinstitute.org` (`rn6`). A genome whose sequence will not open is dropped whole — its
  tracks annotate coordinates this viewer cannot read — and every refused URL is named in the log.
  GRCh38 is still on the shelf through IGV's `hg38_1kg` row, whose FASTA is on the public
  `1000genomes` bucket; GRCh37 has no readable alternative in IGV's table. If those permissions are
  ever fixed, the next run picks the rows up with no change to anything here.

[igv]: https://s3.amazonaws.com/igv.org.genomes/genomes.json

The `bucket` front end lists with `ListObjectsV2`, so the prefix's bucket needs `s3:ListBucket`
granted to `*` for that prefix ([hosting.md](hosting.md), *Making a public bucket browsable*), or
run it from a machine whose AWS credentials cover it. It emits no columns: what a bucket knows
about a file is its name and its size. Add columns by hand, or generate them from your own sample
sheet; the format is plain JSON and the `check` front end will tell you if a row is malformed.

### How much ENCODE

ENCODE's manifest holds **1,209,805 released files this viewer can open** — 658,000 BED, 284,000
bigWig, 134,000 BAM, 123,000 bigBed, 4,100 `.hic`. Listing all of them in one file is a quarter of
a gigabyte of JSON, so `--breadth` chooses how much is published:

| `--breadth` | rows | what it keeps |
|---|---|---|
| `representative` (default) | ~210,000 | one file per dataset, assembly and format — every dataset ENCODE has, with the per-replicate and intermediate duplicates collapsed. Each row says how many files it stands for. |
| `full` | ~700,000 | every file, less the 502,000-row `footprints` annotation dump |
| `all` | 1,209,805 | everything |

The chosen file is the one made from the most libraries, then the newest, then the lowest
accession — a total order, so two runs over unchanged data pick the same file and the published
diff is empty.

Even at the default, 210,000 rows is too much for one file, so the `encode` front end **shards**:
one store per assembly group (`GRCh38`, `hg19`, `mm10`, `other`) and output category (`signal`,
`annotation`, `alignment`), twelve files, largest about 25 MB. `--out out/encode.json` writes
`out/encode-GRCh38-signal.json` and its eleven siblings and no `out/encode.json`; `--shards off`
writes the single file instead. Each shard is one file, and the ENCODE page turns the shard list
into its first two facets — *Genome* and *Files* — so a reader never meets twelve entries; the list
is fixed in the generator and mirrored in `src/ui/stores/registry.ts` —
`test/dom/builtin-stores.test.ts` checks the two agree, because a name that drifted would be a
facet answering 404 for a file that exists under another name.

### Pre-configured sessions

`--sessions-dir DIR` writes one `.chromosomix.json` per genome or dataset with its tracks already
placed, and a store listing them as `kind: "workspace"` rows. IGV's hg38 becomes its FASTA plus every
track IGV publishes for hg38; a 4DN experiment set becomes its richest contact map with the
bigWigs and peak files of the same set on it. One click and it is on screen, which is what three
rows in a table is not — and the viewer needed no new code for it, because a workspace row is a
road it already has.

Four rules the generator follows:

- **One session is one set of coordinates.** Sessions are grouped by dataset *and* assembly.
  ENCODE publishes one experiment against GRCh38 and hg19 both, and grouping on the dataset alone
  drew hg19 tracks over a GRCh38 map with nothing on screen saying so.
- **The view follows the lead file.** A contact map opens on its genome list; a genome or a track
  opens in the 1D browser.
- **A group with a map and no tracks is skipped**, because it would be a row that opens one file,
  which that file's own row already does. So is a group with tracks and no map: a session whose
  lead is a bigWig is a fine thing and is not what picking an experiment set means.
- **A 3D model opens beside the map.** A `.g3d`, `.3dg` or `.bed3d`, gzipped or not, is placed as a
  structure row and the session's deck names a structure cell for it (`maps: 3d`): a structure row
  restored from a session opens no cell of its own, so without that the model would be a row on the
  Structures card and nothing on screen.

At most 24 tracks are placed per session — a 4DN set can carry two hundred processed files, and a
session that opened all of them would be unreadable when it had finished drawing. The cap is on the
session; every one of those files still has its own row in the data store.

## The stores the app ships

`.github/workflows/stores.yml` — **Actions → Stores** — runs all four front ends every Monday and on
demand, uploads everything as a timestamped workflow artifact (`stores-<date>`, kept ninety days),
and publishes to the `stores` branch:

```
igv.json  4dn.json  dnazoo.json  encode-<assembly>-<category>.json ×12
igv-sessions.json  4dn-sessions.json  encode-sessions.json
sessions/*.chromosomix.json
index.json        what is there, how many rows each has, how big, and when
fingerprint.json  each file's hash with its timestamps removed
archive/          dated copies of index.json and of every store under 2 MB, last 26 runs
```

The branch is the store, not the door: the deploy (`.github/workflows/deploy.yml`) copies the
current files into `stores/` beside the app on every deploy, and the stores workflow asks for a deploy
as soon as it has published something new. The drawer's pages read `<site>/stores/<name>.json` —
the same origin as the page, so no CORS is involved and a private repository changes nothing; the
desktop build reads the deployed site by the `homepage` in `package.json`.

Two properties of that branch are worth knowing before you look at it. It is **force-pushed as one
orphan commit** each run: about 100 MB changes weekly, and a branch that kept every week as a
commit would be five gigabytes within a year for a store whose only interesting state is its tip.
And **a run that found nothing new publishes nothing**: every file carries the instant it was
written, so the comparison is made on `fingerprint.json` — each file hashed with `generatedAt` and
`createdAt` removed — rather than on the bytes. A second run over unchanged portals commits
nothing, pushes nothing and asks for no deploy.

Until the workflow has run once on a fork, those pages answer *not generated yet* and name
the workflow to run. On the first run, check the "Generate every store" step's counts (about 75 IGV
rows and 41 sessions; about 25,700 4DN rows; about 210,000 ENCODE rows across twelve shards; DNA Zoo
in the low thousands, one directory a species), that `--check` passed on everything, that the deploy
it asked for has finished, and that `<site>/stores/4dn.json` answers `200`. A second run must publish
nothing when the four sources answered the same thing.

A fork that would rather publish its stores elsewhere changes `storesBase()` in `src/ui/stores/registry.ts`
and the branch name in the two workflows; nothing else knows where they live.

### The DNA Bacterial Zoo, which no workflow writes

One shipped store is the lab's own analyses rather than a portal's catalogue, so it is not on the
`stores` branch. `scripts/dbz-store.sh` runs the suite over every map of `scripts/DBZ_species.tsv`
straight into the folder that is published — one directory a sample with its `.mcool`, its reference
and a directory a step — and then `scripts/DBZ_store.py index` writes `store.chromosomix.json` over it with every
name relative: every file the viewer opens, species by species, and a session a species that opens
the map with its HiC score, insulation and E1 along both arms and nothing else. The folder is the
store, and publishing it is uploading it beside the demo data:

```bash
npm run build:cli                                                   # the chromosomix command it drives
scripts/dbz-store.sh                                                # ~/Downloads/metacooler/data/dbz → …/dbz/store
python3 scripts/DBZ_store.py serve ~/Downloads/metacooler/data/dbz/store   # look at it first, on :8765
aws s3 sync ~/Downloads/metacooler/data/dbz/store/ s3://rsglab-data/dbz/ --delete \
  --exclude '*.tsv' --exclude '*.log'                               # the tables and logs stay here
```

The maps and references are found at any depth under `DATA` (a reference is `<species>.fa`, `.fna`
or `.fasta`, gzipped or not, or failing that the one holding the map's longest sequence), and the
store goes to `STORE`, `$DATA/store` by default. `STEPS="oriter compartments-arms"` reruns two steps
and keeps the rest; `scripts/dbz-store.sh --help` lists the other settings.

The *DNA Bacterial Zoo* tile is a dev feature (SPECS §29), published with the multi-genome format: with
the switch in *About* off there is no tile. It reads `https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/store.chromosomix.json`
(`DBZ_STORE` in `src/ui/stores/registry.ts`), whose bucket already answers the cross-origin ranged
reads the demo needs. The folder's `store.json` beside it is the index the build before the rename
reads, a `metacooler.store` this build refuses: keep it, and the `*.metacooler.json` sessions, in the
local folder until that site is gone, or the sync's `--delete` takes them off the bucket. Until the sync has run it answers 404, and the tile says what publishes it.
`--delete` keeps the prefix a mirror of the folder, so a sample dropped from the table leaves the
bucket too; the prefix holds nothing else.
