---
title: "Contact maps"
description: "The contact-map formats chromosomix opens — .cool, .mcool, .hic, .scool, HiC-Pro and .pairs — how each is read, and which balancing each offers."
---

Every format below opens as a contact map. Drop one, open it by its address, or pick it from a
folder or a store ([Opening files](/files/opening/)); it opens on its **Chromosomes** table, from
which you open a chromosome, a region or the whole genome — see [Your first map](/start/first-map/)
and [Reading a contact map](/browse/contact-maps/).

| Format | What it is | How it is read |
| --- | --- | --- |
| `.cool` | one cooler: a matrix at one bin size | by range, a block per view |
| `.mcool` | a cooler at each resolution of a ladder | by range, at the resolution you pick |
| `.hic` | Juicer's format, versions 7, 8 and 9 | by range, at the resolution you pick |
| `.scool` | one cooler per cell, on shared bins | the cells you tick, summed |
| HiC-Pro | a `.matrix` and the `_abs.bed` beside it | whole, once, then held in memory |
| `.pairs`, `.pairs.gz` | a list of contacts | binned once, at a bin size you choose |

Only maps with bins of one fixed size are read ([What is not opened](#what-is-not-opened)).

## Coolers (.cool)

A `.cool` is read where it is. Opening one reads a few kilobytes — its sequences, their lengths and
the index into its pixels — and each view after that reads one bounded block of pixels, so a large
file on a bucket opens as quickly as a small one on your disk. A cooler saved under `.h5` or
`.hdf5` opens the same way.

Its chromosomes are its sequences, in the file's order and spelled the file's way. A track or a
second map that spells them differently still lines up with it
([Reference sequences](/files/sequences/)).

What each cell holds is chosen in the **score** box of the Aesthetics panel's Map card: **counts**
to begin with, **balanced** where the file carries balancing weights ([below](#balancing-weights)),
and any extra column the file's pixel table carries beside its counts.

## Multi-resolution coolers (.mcool)

An `.mcool` holds the same matrix at several bin sizes. It opens a third of the way up its ladder
from the finest — the second of five rungs, the third of seven — because the finest rung's reads
are the largest the file has. The **resolution** picker in the breadcrumb lists every rung; zooming
in never goes finer than the rung you are on, so pick the finest when you want it.

- To open one resolution directly, name it in the address: `sample.mcool::/resolutions/5000`.
- The whole genome, and the first picture of a whole chromosome, are read from a coarser rung
  where the file has one that fits, so a 5 GB file shows its whole genome in seconds.
- The **+** beside the picker adds a resolution the file does not store — any whole number of a
  stored rung's bins, summed. [Reading a contact map](/browse/contact-maps/) explains it.

## Hi-C files (.hic)

A `.hic` of version 7, 8 or 9 opens from your disk or by address, at every base-pair resolution it
stores. Each resolution is named as an `.mcool`'s is, `sample.hic::/resolutions/5000`, and a `.hic`
named with no resolution opens at the same rung an `.mcool` would.

A `.hic` stores normalisation vectors rather than weights. The best one at the open resolution is
used for **balanced** — `SCALE`, then `KR` with its `INTER_KR` and `GW_KR` variants, then the
coverage ones — and the General panel's File card names it on its **normalisation** row, or says
*none at this resolution*. A bin the normalisation left out is drawn as missing, as in a balanced
cooler.

Not read: the fragment-resolution matrices, whose bins are not a fixed size; the file's own
expected-value vectors, since the analyses compute their own; and the synthetic `All` chromosome
Juicer writes, which is not a sequence. A `.hic` older than version 7 is refused: convert it with
`hic2cool`, or run Juicer Tools `pre` again.

## Single-cell coolers (.scool)

An `.scool` holds one cooler per cell, every cell on the same bins, so any set of cells is one map
with their contacts added together. It opens on its **Cells** table — each cell's name, its `nnz`
and its `contacts` — and both layouts are read: the standard one `cooler.create_scool` writes, and
the older one HiCMatrix and scHiCExplorer write.

<!-- screenshot: the Cells table of an .scool with a few cells ticked and the sum button showing their count -->

- Click a cell to open its own map.
- Tick cells and press **sum N cells →** to draw them as one map. **sum all N →** is the
  pseudo-bulk of every cell. Ticking adds cells together; it never lays them side by side.
- The chosen cells stay chosen as you move into a chromosome and back out, are named in the
  breadcrumb, and travel in a link.
- One cell opens as a plain cooler by its own address: `file.scool::/cells/<name>`.
- **balanced** is offered only where the file has one weight column shared by every cell, and is
  applied once, to the sum.

Opening an `.scool` from a server asks first, **How should this single-cell file be read?**, because
listing its cells means about a thousand small reads spread across the whole file. Choose
**download all … once**, after which everything is read from memory, or **read it in small
pieces**, which moves far fewer bytes and takes minutes rather than seconds. A copy on your own
disk is never asked: it is read in place. Summing many cells shows how far it has got —
*summing 1,204 of 3,882 cells…*.

[Per-cell contact QC](/analyses/cellqc/) measures every cell on its own.

## HiC-Pro matrices

A HiC-Pro map is two files from one run and resolution: `<prefix>_<res>_abs.bed`, a row per bin,
and `<prefix>_<res>.matrix` (or `_iced.matrix`), a row per non-zero pixel. Either may be gzipped.
They open together, in one of three ways:

- drop or choose both files at once, or pick the matrix from a connected folder with the bed
  beside it;
- open the matrix by address, and the bed is found where HiC-Pro writes it — beside the matrix, or
  in `raw/` for a matrix in `iced/`;
- name the bed outright: `<address of the matrix>#bins=<address of the bed>`.

A matrix with none of the three is refused, and the refusal says which to reach for.

All four layouts HiC-Pro writes open — `upper`, `lower`, `complete` and `asis`. The matrix has no
index, so it is read whole once, at about 100 MB a second, and then behaves exactly as a cooler
does: every view and every analysis after that is instant. Over 200 MB of matrix, you are told the
cost before the read starts (**read all …**), and the read can be cancelled.

About 100 million pixels is comfortable, and past about 250 million it is not a browser tab's job.
That covers any small genome at any resolution, and human down to about 250 kb. For a finer map,
convert the same two files to a `.cool` once with `cooler load -f coo`, and open that.

Not read: fragment-level maps (`GENOME_FRAGMENT`), which are refused, and the `.biases` file. To see
normalised counts, open the matrix in `iced/`.

## Pairs files (.pairs)

A 4DN `.pairs` file — plain, gzipped or bgzipped, with its `.px2` index or without one — is a list
of contacts, not a matrix, and it states no bin size. So it is imported: the first open asks how to
bin it, in a dialog headed **Bin** and the file's name.

<!-- screenshot: the Bin dialog for a .pairs.gz, with its base resolution, ladder and cost line -->

- **Base resolution (bp)** opens on a value suggested from the file's own numbers, and snaps to a
  1-2-5 series.
- **Ladder rungs** is how many resolutions to build, the base among them: five to begin with, up to
  thirteen. The lines under it list them (*Ladder: 1 kb, 2 kb, 5 kb, 10 kb, 20 kb.*) and price
  them — bins, an upper bound on stored pixels, and their size — and warn when the grid is so fine
  that most bins would hold a single contact.
- **Download the .mcool when it is ready**, ticked to begin with, saves the result, so that next
  time you open the map rather than the contacts.
- **build the map** starts.

The file is read once, in one pass, with a progress bar and a cancel: counted in records where a
`.px2` gave an exact count, in bytes otherwise. Every rung is built from that pass and held in
memory, and from then on every view, the deck and every analysis read it as they read a cooler. An
analysis reads the records once more, the first time one runs.

**What the header must say.** The first line is `## pairs format`. The sequences and their lengths
are in `#chromsize:` lines (or, failing those, `#samheader: @SQ` lines); a file with neither is
refused with the command that adds them, `pairtools header generate --chroms-path <chrom.sizes>`.
A `#columns:` line is followed wherever the columns are, and without one the specification's order
is assumed. Positions are 1-based, as the specification says.

**What is counted.** Every record is binned: nothing is filtered, so a duplicate (`DD`) is counted
as a duplicate and still binned, and mapping quality is not read. To change which records count,
filter with `pairtools select` or `pairtools dedup` and import the result.

**An incomplete file.** A bgzipped file that stops part-way through a block, or has no end-of-file
marker, is drawn from the records that did arrive and reported as an **Incomplete file**. Sequences
with nothing on their own diagonal are named alongside, since the two together usually mean the
file was cut off before them.

:::tip[A slow import]
How fast a `.pairs.gz` imports depends on how it was compressed: a file written in very small
blocks inflates several times more slowly than one written in `bgzip`'s own 64 KiB blocks.
Re-blocking it once is the fix:

```sh
bgzip -d < sample.pairs.gz | bgzip > sample.reblocked.pairs.gz
```
:::

### Pairs statistics and the .stats file

Because the import reads every record, it also counts what `pairtools stats` counts. The General
panel's **Pairs statistics** card shows the rows a library is judged by — **records**, **mapped**,
**one side**, **unmapped**, **duplicates**, **cis**, **trans**, **library size** and **strands
meet**, the separation at which the four read orientations converge — each as a count and the
share pairtools and MultiQC give it. Three small charts sit among them: the pair types, cis
contacts past 1 to 40 kb, and P(s) for each orientation. A file with no `pair_type` column has no
duplicates to count, and the card says so.

**save .stats** writes every count in pairtools' own format, which MultiQC and
`pairtools stats --merge` read. The command line writes the same file:

```sh
chromosomix stats sample.pairs.gz --out qc/
```

[Pairs QC](/analyses/pairsqc/) reads the same records with restriction fragments added.

## Balancing weights

Where a file carries balancing weights, the **score** box offers **balanced**: each cell is its raw
count times the weights of its two bins, which is cooler's own definition, and the result matches
cooler's balanced matrix cell for cell. A bin the balancer dropped has no weight, so its row and
column are drawn transparent — absent rather than empty.

| File | Its weights |
| --- | --- |
| `.cool` | the `weight` column `cooler balance` writes into its bins table |
| `.mcool` | each rung's own; a ladder made with `cooler zoomify --balance` is balanced at every rung, and a coarse picture is read from a rung balanced at its own resolution |
| `.hic` | its normalisation vector at the open resolution |
| `.scool` | the weight column its cells share, applied to their sum |
| HiC-Pro | none: open the `iced/` matrix for normalised counts |

The box opens on **counts**. Where a file has no weights, **balanced** is not offered, and a link
that asks for it opens on counts. Three normalisations computed from the counts on screen — **VC**,
**VC √** and **ICE** — are offered for every map, weights or not.

## What is not opened

- **Bins of different sizes.** A cooler whose bins are not one fixed size — fragment-level, or one
  bin per contig — is refused, as are a fragment-level HiC-Pro map and a `.hic`'s fragment
  resolutions. Bin the contacts at a fixed size (`cooler cload pairs` does it from the pairs file)
  and open that.
- **A compressed cooler.** A `.cool` or `.mcool` that has been gzipped or zipped is refused: HDF5 is
  read in place and cannot be decompressed on the way. Decompress it first. (A `.pairs.gz` and a
  `.matrix.gz` are read compressed.)
- **Other HDF5.** An HDF5 file that is not a cooler, an `.mcool` or an `.scool` is refused.
- **A map from alignments.** A BAM is drawn as its reads ([Tracks and features](/files/tracks/)),
  never binned into a map.

Every refusal, with what to do about it, is on [When a file will not open](/files/problems/).
