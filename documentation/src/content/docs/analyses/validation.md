---
title: "How the results are checked"
description: "How every analysis is held to the package it reproduces on public data, how its speed and the app's agreement with the command line are measured, and how to check a result yourself."
---

A task is only worth running here if its numbers are the numbers the field's own tools give, because
an insulation score a few per cent away from cooltools' is worse than none: somebody will put it in a
figure. So every task that re-implements a published method is run on public data both by chromosomix
and by the package it reproduces, and the two are lined up number for number, in a notebook published
with every release. Three more notebooks time the same commands, hold the app to its own command line,
and measure what a run costs on a laptop.

| Notebook | What it holds chromosomix to | Published at |
| --- | --- | --- |
| Validation | the package each task reproduces, on public data | <https://chromosomix.app/validation/> |
| Timings | the same packages, in time and memory, and two other viewers in time to a picture | <https://chromosomix.app/timings/> |
| Parity | its own command line: the same run in the app and in a shell, file for file | <https://chromosomix.app/parity/> |
| Laptop | what a genome-wide run costs on a laptop, on the command line and in three browsers | <https://chromosomix.app/laptop/> |

In the app, **About this viewer**, from the header or the command palette, lists the four under
**Notebooks**, each with the one line of what it found and when it was rendered.

## The validation

Each analysis is run on the same public file twice: once by `chromosomix`, the command-line form of the
**Analysis** panel, which runs the same code, and once by the reference package, called as its authors
mean it to be called and never re-implemented. The two outputs are then matched bin by bin, or call by
call. The references are the tools the field uses: cooltools for insulation, compartments and their
saddle, P(s), coverage, virtual 4C, cis and trans per sequence and loop calling; coolpuppy for pileups;
chromosight for pattern detection; domaincaller for the directionality index; Juicer for Arrowhead;
yapc with IDR for peak calling; hicrep for reproducibility; pastis for the 3D model; deepTools for the
metaplot and track correlation; bedtools for interval overlap; bioframe and Biopython for base
composition and restriction sites; seqkit for the motif search; pairtools for Pairs QC; cooler for the
map report; and pyBigWig, NumPy and SciPy for the fraction of signal in features and signal by group,
where the reference is the arithmetic itself.

The data are public, and every file is named by its accession and fetched from where it was published:
Hi-C of mouse, chicken and human cells from the 4DN Data Portal, a yeast Micro-C map from GEO, ChIP-seq
and ATAC-seq from 4DN and ENCODE, and the mouse and yeast genomes from UCSC and Ensembl. Where a
reference draws at random — a pileup's controls, an overlap's shuffles, IDR's ties — the app's answer is
compared with the reference's own spread from one seed to the next.

Each section of the notebook says, for one analysis, what both sides were run with, how the two came out,
and why they differ where they do: cooltools counts a bin's contact with itself twice in its coverage,
for instance, where chromosomix counts it once. Every command is printed as it ran, and three tables are
published beside the page:

- **`commands.json`**, every command of both sides, as it ran;
- **`summary.tsv`**, every analysis's verdict;
- **`validation.txt`**, every number the figures draw, one row a mark, so that any figure can be drawn
  again from the table alone.

<!-- screenshot: the published validation page, on the coverage section, with its figure of chromosomix against cooltools -->

## What the badge on a task's page means

The top of every task's page carries the validation's verdict for it, as the `?` on its row of the
Analysis panel does.

- **Identical**, in green: the validation found the task's numbers to be the reference's, to the float32
  the app computes in or to every digit it writes.
- **Equivalent**, in green: the same answer, where two correct implementations are not expected to
  agree digit for digit — an eigenvector from another solver, a 3D model fitted from a random start, a
  reference that reads a bigWig's summaries rather than its values. The section says how far apart the
  two are, and why.
- **Not yet compared with its reference** (*Not yet validated* in the [list of tasks](/analyses/)), in
  the text's colour: the notebook does not compare the task yet. This is the case for the scalogram,
  the HiC score and per-cell contact QC.
- **No badge**: the task follows no published method, so there is nothing to compare it with. This is
  the case for inter-arm alignment, origin and terminus, model versus map and spatial tracks.

A green badge links to the task's section of the published notebook.

The badge is read from the app's own table of references as this site is built, so it is the verdict
for the version these pages describe. Beside the notebooks, the app's test suite holds its tasks to
their references' own output on the yeast demo data; the notebooks do it again at full size, on the
files the field works with.

## The timings

The first part of the timings measures **the time to a picture**: chromosomix, juicebox.js and HiGlass
each drawing the same contact map with one track beside it, at the same resolution, from files on the
machine and from the bucket they are published in. The second part runs **every command of the
validation again**, each as a fresh process, four rounds round robin, with the two sides of each pair
taking turns to go first, and measures for each its CPU time, its wall-clock time and its peak memory.
Each chromosomix command's time is set beside its reference's. The command line runs a task on one
core unless told otherwise, and a reference that takes a number of processes is given one per core, at
most four. A few analyses are compared and not timed: cis and trans per sequence, the saddle, the
fraction of signal in features and signal by group.

Beside the page: **`timings.tsv`**, every timed run, and **`viewers.tsv`**, every picture timed in a
viewer, each with the machine and every version.

## The parity

The Analysis panel and the `chromosomix` command are one implementation, and the parity holds them to
it. Ten tasks are run in the app, built from the same commit as the command line and driven in a
headless Chromium as a reader drives it: the files dropped on the landing page, the task opened from
the Analysis panel, its form set, **run** pressed, and every file the app offers saved through the
buttons a reader presses. Then the line the console wrote for that run is run in a shell as written,
with only `--out` added, and each pair of files is compared:

- **identical**: a bigWig byte for byte, a text file line for line once the `#` lines that say when,
  by which build and from which file it was made are set aside;
- **data differs**: a line of data, or a byte of a bigWig, differs;
- **browser only** or **command line only**: one side wrote a file the other did not.

The ten are insulation, compartments phased by GC content, P(s), coverage, virtual 4C, loop calling and a
motif search on a yeast Micro-C map; aggregate peak analysis over the loops the app called there; and
peak calling and a metaplot on yeast ATAC-seq, opened with no map. Beside the page: **`summary.tsv`**,
every file compared and its verdict.

## The laptop

The laptop notebook answers what the other three do not: how long a genome-wide analysis takes, and how
much memory it needs, on a machine like yours. It runs 23 analyses on public data — Hi-C maps from 69
million to 1.08 billion contacts, a yeast Micro-C map down to 50 bp, and ATAC-seq tracks and sequence
over the whole mouse genome — on the command line and then in the app, in Chromium, Firefox and WebKit,
Safari's engine. Each run's wall-clock time, CPU time and peak memory are tabulated, with the command
and the line the app's console wrote for it.

The page at <https://chromosomix.app/laptop/> is rendered by hand, on a laptop, which its opening block
names. To measure your own, render it from the root of a clone of
[the repository](https://github.com/js2264/chromosomix), on a laptop that is plugged in and otherwise
idle. It needs Quarto, Python with pandas, matplotlib and pyfaidx, Node, and Playwright's browsers, but
no reference package. It downloads about 13.7 GB of data, and takes about twenty minutes on the command
line and about as long again in Chromium; Firefox and WebKit take their own time, which the results give.

```sh
npm ci && npm run build && npm run build:cli
npm ci --prefix notebooks/viewers && npx --prefix notebooks/viewers playwright install chromium firefox webkit
pip install jupyter pandas matplotlib pyfaidx
quarto render notebooks/laptop.qmd
```

## When they are published

The validation, the timings and the parity are rendered on a fresh GitHub runner whenever a release is
published, and on demand, and the three are published together only if all three rendered. Each
release also keeps its own copies of the three pages and their tables among its files. Every page opens
on a block saying when it was rendered, from which version and commit, by which run or by hand, and on
what machine, and closes on how long it took.

## Checking a result yourself

- **Keep the provenance.** Every TSV, bedGraph and BED a task writes opens with `#` lines naming the
  build, the task and its version, the file, the framing and every parameter, and **copy provenance**
  in the drawer copies the same lines. That is what a methods section needs.
- **Run it again from a shell.** The [console](/browse/console/) holds the `chromosomix` line of every
  run, and **copy CLI command** copies one. Pin the version the app ran, which `chromosomix --version`
  prints and the provenance names, with `npm install -g chromosomix@<version>` or
  `npx chromosomix@<version>`, and the same line on the same file gives the same numbers: that is what
  the parity checks. See [From the app to a script](/cli/from-the-app/).
- **Keep the session.** An exported session holds every task's settings for its files, so opening it
  and pressing **run** repeats the analysis; see [Sessions, workspaces and
  links](/browse/sessions-and-links/).
- **Seeds are fixed.** A task that draws at random, such as the controls of a pileup or the shuffles of
  an overlap, takes a seed with a stable default, and the same seed with the same settings gives the same
  output.
- **Run the reference beside it.** The validation prints both sides' commands for every analysis, so
  you can run chromosomix and the reference on a section's data, or on your own file, and compare them
  as the section does. Each notebook's opening section says how to render it: the validation needs,
  among other things, the reference packages pinned in `notebooks/requirements.txt`, environments of
  their own for yapc and for pairtools, and 9.8 GB of data.
