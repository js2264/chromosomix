---
title: "Running a task"
description: "Write a chromosomix command — the task, its maps, its parameters and the shared flags — and find the files it writes."
---

Every task of the **Analysis** panel is a command: the same task, with the same parameters, gives the same numbers in a shell as it does on screen. This page is how a command is put together. The whole usage, as `chromosomix --help` prints it, is on the [command-line reference](/reference/command-line/), and every task's own parameters are on its page under [Analyses](/analyses/).

## The shape of a command

```sh
chromosomix <task> <map> [<map> …] [--<parameter> <value> …] --out <dir>
```

One task, one or more maps. Each map is run on its own, and its results are written into `--out` under its own name:

```sh
chromosomix insulation sample.mcool::/resolutions/10000 --window 10 --out results/
```

## Finding a task and its parameters

```sh
chromosomix tasks          # every task, its flags and their defaults
chromosomix tasks --json   # the same, as one JSON document
chromosomix --help         # the usage
```

`chromosomix tasks` prints each task's id — the word you type — its title, and a line per flag with its default and what it is:

```text
insulation
    Diamond insulation
      --window (default 10)  window
      --scales (default 1)  scales
      --sequences  sequences
      --ignoreDiags (default 2)  diagonals to ignore
      --no-balance  read the raw counts (balanced by default where the file carries weights)
      --call (default true)  call boundaries
      --prominence (default 0.2)  minimum prominence
      --minValid (default 0.5)  diamond coverage to call
      --spacing (default 0)  minimum spacing
      --domains (default true)  domains between them
```

With `--json` the same tasks come out as data, for a script: every value a choice takes, every range and unit, what each input reads and what each task writes. For one task's flags and defaults, for instance:

```sh
chromosomix tasks --json | jq '.tasks[] | select(.id == "insulation") | .params[] | {flag, default}'
```

`--help` anywhere on a line prints the usage and runs nothing. Each task's page — [insulation](/analyses/insulation/), say — lists the same parameters with what each one does, and the command line that runs it.

## Writing parameters

- A parameter takes its value after a space or an `=`: `--window 10` or `--window=10`.
- A parameter that is on or off takes no value: `--derivative` turns it on, and `--derivative=false` or `--no-derivative` turns it off.
- A list is the flag repeated, or one value with commas: `--sequences II --sequences IV` or `--sequences II,IV`.
- A choice must be one of its values, and a number must be a number. Anything else is refused before a file is opened, with a sentence naming what the flag takes, and so is a flag the task does not have.
- Where a task has a parameter with the same name as one of the command's own flags, the task's meaning wins. Insulation's and the directionality index's `--window` is their window in bins, APA's is its half-width, and Coverage's `--balance` is a switch of its own. Compartments' `--contacts` takes both meanings: a word (`cis`, `both`, `trans`) is the task's choice, and a number is the total the map is drawn to (below).

## Maps

A map is a path or an `http://` or `https://` address.

| File | How to name it |
| --- | --- |
| `.cool` | as it is: `sample.cool` |
| `.mcool` | one resolution after `::` — `sample.mcool::/resolutions/10000`. Named bare, it is refused with the list of the resolutions it has |
| `.hic` | one resolution the same way: `sample.hic::/resolutions/10000` |
| `.scool` | every cell summed into one map; `--cell <name>` sums the ones you name, repeated or comma-separated |
| `.pairs`, `.pairs.gz` | a contact list, binned before the task reads it, so it needs `--bin-size <bp>`; `--rungs <n>` builds more resolutions above it (a 1-2-5 series, 1 by default). A `.px2` index beside it is used |
| HiC-Pro | the `.matrix` with its `_abs.bed` bins file beside it |

The [contact maps page](/files/contact-maps/) has more on each format. A few flags change how the map is read before any task sees it:

- `--coarsen <bp>` reads the map at a bin size the file does not store, a whole number of its own bins summed along each sequence, as the app reads a resolution you added. Counts sum exactly.
- `--contacts <n>` draws the map to `n` contacts first: an exact subsample below the file's own total, an oversample through Boost-HiC above it. It takes `10M`, `23,000,000` or `2.5e7`, and uses the app's seed, so it draws the same pixels the app does. Two libraries drawn to one depth can be compared: `chromosomix insulation rep1.cool rep2.cool --contacts 10M --out results/`.
- `--value <column>` reads another column of the pixel table, for a file that stores more than the count.
- `--circular <name>` reads a sequence as a circle, and `--origin <name:pos>` says where a sequence's replication origin is, 1-based. `chromosomix circular sample.mcool::/resolutions/5000` prints which sequences join their own ends, with the names to pass as `--circular`.

Any other address scheme, `s3://` or `gs://`, is refused: name the file by its `https://` address, or copy it to disk.

## Balanced by default

A map is read balanced wherever the file carries balancing weights, as the app reads it. `--no-balance` reads the raw counts. `--balance` is refused, with a sentence saying so, because balanced is already what you get. The one exception is Coverage's own `--balance` switch, which is off by default.

## Loci

A locus is written as the app shows one: 1-based and inclusive, digits grouped or not, as on the breadcrumb, in IGV and in samtools. A window copied from the app is the window that is read:

```sh
chromosomix fourc sample.cool --anchor IV:1,200,001-1,210,000 --out results/
```

The same form is taken by the 3D tasks' `--region` and `--locus`, and by `--window`, which names the part of a map a run was framed on. The console writes `--window` from the view on screen, and the outputs' `# framing:` line records it. To run a task over some sequences only, use its `--sequences`, where it has one.

## Files a task reads

A task that needs a feature set, a loop set, a track or a reference takes the file under one of the command's flags. Each task's page lists which of its parameters name one.

| What | Flag | How the task's parameter names it |
| --- | --- | --- |
| A feature set: BED, narrowPeak, GTF/GFF3, genePred, VCF, cytoBand, barChart, splice junctions | `--features <file>` | by its file name. Where the parameter is itself called `features`, the one flag does both |
| A set of pairs: BEDPE, interact, longrange | `--pairs <file>` (or `--features`) | by its file name. Where the parameter is itself called `pairs`, the one flag does both |
| A signal track: bigWig, bedGraph, wig, or a FASTA read as its GC content | the parameter itself: `--tracks ATAC.bw,MNase.bw`, peak calling's `--signal ChIP.bw` | the file it names is the file loaded |
| A reference: FASTA, gzipped or not, or `.2bit` | `--sequence <file>` | the same path. Where the parameter is itself called `sequence`, the one flag does both |
| Another contact map, for [Reproducibility](/analyses/hicrep/) | `--against <file>`, repeated for a third | — |

So an overlap between two BED files loads each and then names it, and compartments phased by GC content load the reference and name it:

```sh
chromosomix overlap sample.cool --features peaks.bed --a peaks.bed --features tads.bed --b tads.bed
chromosomix compartments sample.cool --sequence ref.fa.gz --phaseSequence ref.fa.gz --out results/
```

:::caution[`--pairs` is not a contact list]
`--pairs` names a table of pairs of features, such as a loop set. A `.pairs` contact list to bin is a map, named in the map's place with `--bin-size`. [Pairs QC](/analyses/pairsqc/) is the exception: its own `--pairs` is the contact list its map was made from.
:::

### Tasks with no map

The tasks of the 1D card run without a contact map, over the assembly their tracks or reference declare, as the 1D browser runs them. A run with neither a track nor a reference needs a map to give it one.

```sh
chromosomix metaplot --tracks ATAC.bw --features peaks.narrowPeak --flank 2000 --out results/
chromosomix peaks --signal ChIP.bw --out results/
chromosomix composition --sequence ref.fa.gz --out results/
```

Their results are named after the first track they read, or the reference.

## Files on a server

An `http://` or `https://` address works wherever a path does: as a map, and after `--against`, `--sequence`, `--tracks`, `--features` and `--pairs`.

```sh
chromosomix insulation https://example.org/sample.mcool::/resolutions/10000 --out results/
```

- A map, a bigWig, a `.2bit` and a FASTA with its `.fai` beside it are read by range, as the app reads them: one resolution of a 7 GB `.mcool` costs that resolution, and nothing of it is written to disk. A bedGraph or a wig is read in one request.
- What has to be read whole — a feature or loop file, a HiC-Pro matrix, a workspace, or any file whose server will not answer a range — is downloaded into `$TMPDIR`, with its progress on stderr, and removed when the command ends, Ctrl-C included.
- A file every run needs, named after `--sequence`, `--tracks`, `--features`, `--pairs` or `--against`, is fetched before the first map, so one that cannot be had stops the command at once, with exit status 2. A map that cannot be had fails on its own, and the other maps still run.

## What comes out

Every file goes into `--out`, which is created if it is not there; without it, into the folder you run the command from. A file is named

```text
<stem>.<task>.<output>.<format>
```

- The **stem** is the map's file name up to its first dot, with the resolution after it where you named one: `sample.mcool::/resolutions/10000` gives `sample_10000`. A run with `--coarsen 3000` adds `_coarsen3000`.
- The **output** is the result's own name. Insulation at a 10-bin window writes its score as `insulation-w10`, and its calls as `insulation-boundaries` and `insulation-domains`. Unless you pass `--quiet`, the command says `wrote` and the path for each file as it writes it.

So the insulation run above leaves these, the boundaries and domains where any were called:

```text
results/sample_10000.insulation.insulation-w10.tsv
results/sample_10000.insulation.insulation-w10.bedGraph
results/sample_10000.insulation.insulation-w10.bw
results/sample_10000.insulation.insulation-boundaries.tsv
results/sample_10000.insulation.insulation-boundaries.bed
results/sample_10000.insulation.insulation-domains.tsv
results/sample_10000.insulation.insulation-domains.bed
```

Each kind of result is written in every format that means something for it:

| Result | Files |
| --- | --- |
| A value per bin, such as a score or a track | TSV, bedGraph and bigWig |
| A curve | TSV |
| A matrix, a pileup or a heatmap | TSV |
| A table | TSV |
| A set of intervals | TSV and BED; BEDPE for pairs; bed3d and PDB for a 3D model |

The [Map report](/analyses/mapreport/) also writes the run as a whole, as `<stem>.mapreport.report.html` and four sections for MultiQC: see [In a pipeline](/cli/pipelines/).

When several maps of one command would share a stem, they keep more of their names until they differ — `HCT116.rep1` and `HCT116.rep2`, then their folders, `dirA_sample` and `dirB_sample` — and nothing one command writes is written over by it.

### Every result says how it was made

Each TSV opens with `#` lines naming the build, when it ran, the file, the task and its version, the framing, and then every parameter, one a line, defaults included:

```text
# chromosomix <version> cli
# created: 2026-11-03T10:12:44.180Z
# file: /data/maps/sample.mcool::/resolutions/10000
# task: insulation v2
# framing: whole file at 10000 bp, balanced, count
# param balance: true
# param call: true
# param domains: true
…
```

So `head` on any table says how its numbers were made. The BED and the bigWig beside it are the files other tools read; the TSV is the same rows with this header above them.

## Progress, notes and exit status

Progress, the task's notes and every failure go to stderr, so stdout stays clean for a pipe. `--quiet` silences the progress; the notes and failures are still written.

| Exit status | Meaning |
| --- | --- |
| `0` | every map ran |
| `1` | at least one map failed; the others still ran and wrote their files, and stderr says which failed and why |
| `2` | the command was refused before any file was opened: an unknown task or flag, a choice that is none of its values, a number that is not one, a missing input. Fix the command and run it again |

## Threads

`--threads <n>` lets a task that shares its work use more than one thread. So far that is [Model from the map](/analyses/reconstruct3d/), for pastis-NB's MDS start and its likelihood. The default is one, and the results are the same to the last bit on any number of threads.

## Commands that are not tasks

- `chromosomix circular <map>` prints, as a table on stdout, which sequences join their own ends: the test the app runs when it first opens a map. A sequence needs 50 bins at the resolution read to be decided.
- `chromosomix stats <file.pairs.gz>` writes what `pairtools stats` writes, for MultiQC: see [In a pipeline](/cli/pipelines/).
- `chromosomix replay <workspace> --over <file> …` runs again every analysis a saved workspace recorded, over other files: see [From the app to a script](/cli/from-the-app/).
- `chromosomix boost <map>` writes the boosted map an oversample draws each sequence's new contacts from, as Boost-HiC writes it: one square TSV per sequence (`--sequences`, `--alpha`).
