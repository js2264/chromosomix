---
title: "Running a task"
description: "Write a chromosomix command — the task, its maps, its parameters and the shared flags — and find the files it writes."
---

Every task of the **Analysis** panel is a command that gives the same numbers in a shell as on screen. The full usage is on the [command-line reference](/reference/command-line/); each task's parameters are on its page under [Analyses](/analyses/).

## The shape of a command

```sh
chromosomix <task> <map> [<map> …] [--<parameter> <value> …] --out <dir>
```

Each map runs on its own, its results in `--out` under its own name:

```sh
chromosomix insulation sample.mcool::/resolutions/10000 --window 10 --out results/
```

## Finding a task and its parameters

```sh
chromosomix tasks          # every task, its flags and their defaults
chromosomix tasks --json   # the same, as one JSON document
chromosomix --help         # the usage
```

`chromosomix tasks` prints each task's id, the word you type. `--json` adds every choice, range and unit, and what each task reads and writes:

```sh
chromosomix tasks --json | jq '.tasks[] | select(.id == "insulation") | .params[] | {flag, default}'
```

`--help` anywhere on a line prints the usage and runs nothing.

## Writing parameters

- A value follows a space or an `=`: `--window 10` or `--window=10`.
- A switch takes none: `--derivative` turns it on, `--no-derivative` or `--derivative=false` off.
- A list repeats the flag or uses commas: `--sequences II --sequences IV` or `--sequences II,IV`.
- An unknown flag, or a value it cannot take, is refused before any file is opened, with a sentence naming what the flag takes.
- A task's own parameter wins over a command flag of the same name: insulation's `--window` is its window in bins, Coverage's `--balance` its own switch (off by default). Compartments' `--contacts` is the task's choice as a word (`cis`, `both`, `trans`), the map's total (below) as a number.

## Maps

A map is a path or an `http://` or `https://` address; `s3://`, `gs://` and other schemes are refused. Formats: [Contact maps](/files/contact-maps/).

| File | How to name it |
| --- | --- |
| `.cool` | as it is: `sample.cool` |
| `.mcool`, `.hic` | one resolution after `::`: `sample.mcool::/resolutions/10000`. An `.mcool` named bare is refused with the list of its resolutions |
| `.scool` | every cell summed into one map; `--cell <name>` sums the ones you name, repeated or comma-separated |
| `.pairs`, `.pairs.gz` | binned first, so it needs `--bin-size <bp>`; `--rungs <n>` builds more resolutions above it (a 1-2-5 series, 1 by default). A `.px2` index beside it is used |
| HiC-Pro | the `.matrix`, with its `_abs.bed` bins file beside it |

A map is read balanced wherever the file carries weights, as in the app. `--no-balance` reads the raw counts; `--balance` is refused, except as Coverage's own switch.

- `--coarsen <bp>` reads a bin size the file does not store, a whole number of its own bins. Counts sum exactly.
- `--contacts <n>` (`10M`, `23,000,000` or `2.5e7`) draws the map to `n` contacts — an exact subsample below the file's total, a Boost-HiC oversample above it — with the app's seed, so it draws the same pixels as the app. To compare libraries at one depth: `chromosomix insulation rep1.cool rep2.cool --contacts 10M --out results/`.
- `--value <column>` reads another column of the pixel table.
- `--circular <name>` reads a sequence as a circle; `--origin <name:pos>` sets its replication origin, 1-based.

## Loci

A locus is written as the app shows it: 1-based, inclusive, digits grouped or not, as in IGV and samtools. A window copied from the breadcrumb is the window read:

```sh
chromosomix fourc sample.cool --anchor IV:1,200,001-1,210,000 --out results/
```

The 3D tasks' `--region` and `--locus` take the same form, and so does `--window`, the part of the map a run was framed on. To run over some sequences only, use the task's `--sequences`, where it has one.

## Files a task reads

| What | Flag |
| --- | --- |
| A feature set: BED, narrowPeak, GTF/GFF3, genePred, VCF, cytoBand, barChart, splice junctions | `--features <file>` |
| A set of pairs: BEDPE, interact, longrange | `--pairs <file>` (or `--features`) |
| A reference: FASTA, gzipped or not, or `.2bit` | `--sequence <file>` |
| A signal track: bigWig, bedGraph, wig, or a FASTA read as its GC content | the parameter itself: `--tracks ATAC.bw,MNase.bw`, peak calling's `--signal ChIP.bw` |
| Another contact map, for [Reproducibility](/analyses/hicrep/) | `--against <file>`, repeated for a third |

The flag loads the file, and the task's parameter names it by its file name (a reference by its path); a parameter itself called `features`, `pairs` or `sequence` needs only the flag. Each task's page says which parameters name a file.

```sh
chromosomix overlap sample.cool --features peaks.bed --a peaks.bed --features tads.bed --b tads.bed
chromosomix compartments sample.cool --sequence ref.fa.gz --phaseSequence ref.fa.gz --out results/
```

:::caution[`--pairs` is not a contact list]
`--pairs` names a table of feature pairs, such as a loop set. A `.pairs` contact list is a map, named in the map's place with `--bin-size`. Only [Pairs QC](/analyses/pairsqc/)'s own `--pairs` is the contact list its map was made from.
:::

### Tasks with no map

The 1D card's tasks run over the assembly their tracks or reference declare, and need a map only when they have neither. Results are named after the first track read, or the reference.

```sh
chromosomix metaplot --tracks ATAC.bw --features peaks.narrowPeak --flank 2000 --out results/
chromosomix peaks --signal ChIP.bw --out results/
chromosomix composition --sequence ref.fa.gz --out results/
```

## Files on a server

An `http://` or `https://` address works wherever a path does: as a map, and after `--against`, `--sequence`, `--tracks`, `--features` and `--pairs`.

```sh
chromosomix insulation https://example.org/sample.mcool::/resolutions/10000 --out results/
```

Maps, bigWigs, `.2bit` files and indexed FASTAs are read by range, a bedGraph or a wig in one request. Files read whole, including any whose server ignores ranges, go into `$TMPDIR` until the command ends, Ctrl-C included. A file every run needs is fetched first, and stops the command with exit status 2 if it cannot be had; a map that cannot be had fails alone.

## What comes out

Files go into `--out`, created if needed, or the current folder without it, named:

```text
<stem>.<task>.<output>.<format>
```

- The **stem** is the map's file name up to its first dot, plus the resolution you named: `sample.mcool::/resolutions/10000` gives `sample_10000`, and `--coarsen 3000` adds `_coarsen3000`. Maps that would share a stem keep more of their names until they differ (`HCT116.rep1`, then `dirA_sample`), so nothing is written over.
- The **output** is the result's name: `insulation-w10` for insulation at a 10-bin window, then `insulation-boundaries` and `insulation-domains`.

The run above leaves these, the calls only where some were made, and prints `wrote` and each path unless you pass `--quiet`:

```text
results/sample_10000.insulation.insulation-w10.tsv
results/sample_10000.insulation.insulation-w10.bedGraph
results/sample_10000.insulation.insulation-w10.bw
results/sample_10000.insulation.insulation-boundaries.tsv
results/sample_10000.insulation.insulation-boundaries.bed
results/sample_10000.insulation.insulation-domains.tsv
results/sample_10000.insulation.insulation-domains.bed
```

| Result | Files |
| --- | --- |
| A value per bin, such as a score or a track | TSV, bedGraph and bigWig |
| A curve, a matrix, a pileup, a heatmap or a table | TSV |
| A set of intervals | TSV and BED; BEDPE for pairs; bed3d and PDB for a 3D model |

The [Map report](/analyses/mapreport/) also writes `<stem>.mapreport.report.html` and four sections for MultiQC ([In a pipeline](/cli/pipelines/)).

### Every result says how it was made

Each TSV opens with `#` lines saying how it was made, with every parameter, defaults included, so `head` tells you:

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

The BED and bigWig hold the same rows without the header.

## Progress, notes and exit status

Progress, notes and failures go to stderr, so stdout stays clean for a pipe. `--quiet` silences only the progress.

| Exit status | Meaning |
| --- | --- |
| `0` | every map ran |
| `1` | at least one map failed; the others still ran and wrote their files, and stderr says which failed and why |
| `2` | refused before any file was opened: an unknown task or flag, a value a flag cannot take, a missing input. Fix the command and run it again |

## Threads

`--threads <n>` gives more threads to a task that can share its work: so far only [Model from the map](/analyses/reconstruct3d/). The default is one, and results are the same to the last bit on any number.

## Commands that are not tasks

- `chromosomix circular <map>` prints which sequences join their own ends, as the app tests when it opens a map, to pass as `--circular`. A sequence needs 50 bins at the resolution read to be decided.
- `chromosomix stats <file.pairs.gz>` writes what `pairtools stats` writes, for MultiQC ([In a pipeline](/cli/pipelines/)).
- `chromosomix replay <workspace> --over <file> …` reruns a saved workspace's analyses over other files ([From the app to a script](/cli/from-the-app/)).
- `chromosomix boost <map>` writes the boosted map an oversample draws from, as Boost-HiC writes it: one square TSV per sequence (`--sequences`, `--alpha`).
