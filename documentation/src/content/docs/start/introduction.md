---
title: "What chromosomix is"
description: "chromosomix is a genome browser for Hi-C and Micro-C contact maps, genome tracks and 3D models that runs entirely in your web browser, reads your files where they are, and runs the same analyses from a command line."
---

chromosomix shows contact maps, genome tracks and 3D models side by side, straight from your files.
It runs in your web browser — at <https://chromosomix.app/>, as a desktop app or as one HTML file —
and uploads nothing. A `chromosomix` command line runs the same analyses in a script.

![A yeast micro-C contact map of chromosome IV from 1.0 to 1.4 Mb with its loop calls ringed on it, the sequence's GC content, the genes, ATAC and the ATAC peaks under it, and the GC content, the genes, Pol II over input and the Pol II peaks beside it.](../../../assets/screens/start/yeast-microc.webp "live: ?config=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC.chromosomix.json")

## What you can do with it

- **Read a contact map** at every resolution it stores: raw, balanced, observed over expected or as
  a correlation ([Reading a contact map](/browse/contact-maps/)).
- **Line tracks up with it** — bigWig, peaks, genes, BAM — on any edge of the map, or in a
  [genome browser](/browse/genome-browser/) of their own.
- **Compare maps**: two in one square, their ratio ([Comparing two maps](/browse/comparing/)), or
  several [side by side](/browse/deck/).
- **See a 3D model beside the map**, each pointing at the other
  ([3D models beside the map](/browse/structures/)).
- **Run analyses in the page** — P(s), insulation, compartments, loops, APA, virtual 4C and more —
  each [checked](/analyses/validation/) against the package it reproduces ([Analyses](/analyses/)).
- **Repeat them in a shell**: every run is written to the [console](/browse/console/) as the command
  that repeats it ([From the app to a script](/cli/from-the-app/)).
- **Keep and share the work** as a PDF or PNG ([Figures and export](/browse/figures/)), a link or a
  workspace file ([Sessions, workspaces and links](/browse/sessions-and-links/)).

## What it reads

| What | Formats |
| --- | --- |
| Contact maps | `.cool`, `.mcool`, `.hic`, `.scool`, HiC-Pro, `.pairs` |
| Tracks and features | bigWig, bedGraph, bigBed, BED, narrowPeak, GTF, GFF3, VCF, BAM and more |
| Interactions | BEDPE, `interact`, `bigInteract`, `longrange` |
| Sequences | FASTA, `.2bit`, `chrom.sizes` |
| 3D models | g3d, `.3dg`, bed3d, PDB |

From your disk, any web host that serves byte ranges, Dropbox, Google Drive, a private bucket, a
UCSC track hub, or the data stores the app offers: [Opening files](/files/opening/). Every format is
in [Files, hosts and stores](/reference/files-and-stores/).

## Why it is built this way

- **No server, no account.** Reading, drawing and every analysis happen in your browser.
- **Nothing is uploaded.** A file on your disk is read in place; unpublished data never leaves your
  machine.
- **Remote files are read by range**: one chromosome of a large `.mcool` costs a few requests, not a
  download.
- **It works offline** after one visit, and the map stays live while a task runs.

What the browser keeps is listed in the command palette under *What this browser is remembering*
([Privacy](/advanced/privacy/)).

## Where next

- [Ways to use it](/start/ways/): the web app, the desktop app, one file, a notebook or a shell.
- [Your first map](/start/first-map/): open a public map, step by step.
- [A tour of the window](/start/window/): what each part of the screen is for.

chromosomix is free software (GPL-3.0 or later), at <https://github.com/js2264/chromosomix>
([Source code and contributing](/contributing/)).
