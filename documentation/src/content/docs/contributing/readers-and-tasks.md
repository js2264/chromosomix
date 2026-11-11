---
title: Adding a reader or a task
description: Where a new file format or a new analysis goes in chromosomix's code, and what it has to come with.
---

A reader and a task each go in one repository,
[js2264/chromosomix](https://github.com/js2264/chromosomix), and each comes with its section of
[`SPECS.md`](https://github.com/js2264/chromosomix/blob/main/SPECS.md), a test against the tool it
reproduces, a line in `CHANGELOG.md` and its page on this site. Nothing runs on a server: the web
app, the desktop app and the command line run the same code, on the user's machine.

## How a file is read

- **By byte range, through a source.** `src/sources/` turns a local file or an address into a
  source that reads a range of bytes. A reader asks for the bytes it needs and never for the whole
  file, and it never fetches by itself: the source counts, caches and signs every request.
- **In a worker.** Contact maps are read in the reader worker (`src/worker/`), tracks in the
  annotations worker (`src/annotations/worker/`), so a slow file never blocks the window.
- **The bytes decide what a file is**, not its name: magic bytes first, then each text format's
  sniffer. The name only picks the placeholder row shown while the first bytes arrive.
- **A file it cannot read is refused in a sentence** that says why and what to do
  (`src/errors.ts`), never with a stack trace.

## Adding a track format

1. **The parser**, in `src/annotations/<format>.ts`: from bytes or text to one of the kinds in
   `src/annotations/types.ts` (`AnnotationKind`). The kind decides the card, the lane and its
   controls, so reuse one whose rows mean what the new format's rows mean, and add a kind only when
   none does.
2. **Detection**, in `load` in `src/annotations/worker/annotations.worker.ts`: a binary format by
   its magic bytes, ahead of every text format; a text format by a sniffer, ahead of `sniffFormat`,
   which reads whatever is left as BED.
3. **The name's guess** in `guessOf` (`src/annotations/loader.ts`), and the index the format needs,
   if any, in `src/annotations/sidecar.ts`.
4. **Tests.** Read the same file with the format's reference reader and compare, as
   `test/unit/bam-oracle.test.ts` does with `@gmod/bam`. A binary format also gets a writer in
   `test/support/` and a part in `test/unit/fuzz-readers.test.ts`, which corrupts its files a few
   hundred ways and expects an answer or a refusal every time, within a budget of bytes, memory and
   time.
5. **Where it is said**: SPECS §8 and [Tracks and features](/files/tracks/).

## Adding a contact-map format

Every view and task reads a map through one class, `MetaCooler` (`src/metacooler/MetaCooler.ts`),
and every way into one is `openMap` (`src/worker/open.ts`), which the reader worker, the analysis
worker and the command line share, so all three agree on what a file is. A new format plugs in under
`MetaCooler` in one of three ways:

- **A binary container with an index of its own**, as `.hic` is: a `PixelStore`
  (`src/metacooler/store.ts`; `src/hic/store.ts` is the one to read), found by its magic bytes in
  `MetaCooler.open`, before HDF5 is asked anything.
- **A text format read whole**, as HiC-Pro is: parsed into an in-memory handle that the cooler
  reader opens unchanged (`src/hicpro/`).
- **A list of contacts with no resolution**, as `.pairs` is: binned when it is imported
  (`src/pairs/`).

Test it against the reference reader, as `test/unit/hic-straw-oracle.test.ts` holds `.hic` to
`hic-straw`; the other formats are held to `cooler` through the goldens in `test/golden/`, which
scripts in `scripts/` write. Then say it in SPECS §3 and on [Contact maps](/files/contact-maps/).

## How a task runs

A task is two halves, so that the window never loads the code that reads a map:

- **The descriptor** (`src/analysis/tasks/<id>.ts`) is data, read by the Analysis panel, the
  command line and this site: its `id`, `title` and `blurb`; the card it sits on (`group`); the
  worker it runs in (`venue`: `analysis` for a task that reads a map, `annotations` for one that
  reads only tracks); its parameters (`params`); its outputs; when it is offered (`availability`,
  which says what to load while it is not); and what a run will read before it starts (`estimate`).
- **The runner** (`src/analysis/run/<id>.ts`) runs in that worker. It reads through the job it is
  handed (the open map, the tracks, the parameters, the framing), reports progress, stops when it is
  cancelled, and returns its outputs: tables, profiles, curves and matrices, which the app writes as
  TSV, bedGraph, bigWig, BED, PNG and PDF.

Every task is also a command, built from the same descriptor, and a run in the app copies as the
command line that repeats it ([From the app to a script](/cli/from-the-app/)).

## Adding a task

1. **The descriptor**, in `src/analysis/tasks/<id>.ts`. `frip.ts` is a short one to start from.
2. **Offered**, by adding it to `TASKS` in `src/analysis/registry.ts`, in catalogue order (SPECS
   §18.8).
3. **The runner**, in `src/analysis/run/<id>.ts`, named by its id in `RUNNERS`
   (`src/analysis/run/index.ts`) for a map task or `TRACK_RUNNERS` (`src/analysis/run/tracks.ts`)
   for a track task. `test/unit/analysis-registry.test.ts` fails while the registry and the runners
   disagree.
4. **Held to the package it reproduces**: a golden written by that package
   (`scripts/make_analysis_golden.py`, into `test/golden/analysis/`) and a test against it; and a
   section in `notebooks/validation.qmd` that runs both on public data, with its commands timed in
   `notebooks/timing.qmd` ([How the results are checked](/analyses/validation/)).
5. **Its page**, `documentation/src/content/docs/analyses/<id>.mdx`, with the four headings every
   task's page has. Its parameters, command and outputs are read from the descriptor when the site is
   built, and the build fails while a task has no page.
6. **Where it is said**: its entry in SPECS §18.8.

## Before the pull request

```sh
npm run typecheck
npm test
npm run docs:build     # every internal link checked
```

A change to what is on screen comes with screenshots of the real app. The rest of the rules are in
[`CONTRIBUTING.md`](https://github.com/js2264/chromosomix/blob/main/CONTRIBUTING.md) and on
[Source code and contributing](/contributing/).
