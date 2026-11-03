---
title: "3D models"
description: "chromosomix opens 3D chromatin models as g3d text or binary, Dip-C's .3dg, bed3d or its own PDB, and matches each to the map by sequence name and base pair."
---

A 3D model is a file of beads, each a stretch of the genome with a place in space. Drop one beside a
map and it opens in a cell of its own, linked to the map and the tracks in both directions — see
[3D models beside the map](/browse/structures/). Open one with no map and it opens over the genome
its beads are on, with the model given the screen.

Every model is a row of the **Structures** card in the Annotations panel, whose **Load a
structure** zone takes *a g3d (WashU, text or binary), a .3dg (Dip-C), a bed3d or a PDB this app
wrote*. The row says what it holds — *2,412 beads · 5 kb · 16 sequences* — and its eye shows and
hides the model's cell.

<!-- screenshot: the Structures card with a phased model's row, and its cell beside a map with a locus lit on both homologues -->

## The formats

| Format | Each row | What it is |
| --- | --- | --- |
| g3d text | `chrom start x y z [haplotype]` | WashU's format, and what `g3dtools` takes: a bead per row, no end, no header, rows in any order |
| `.3dg` | the same, with the haplotype in the name, `chr7(mat)` | Dip-C's models |
| bed3d | `chrom start end x y z [haplotype]` | the same with each bead's end written down, for beads of any width |
| binary g3d | — | the container `g3dtools load` writes: a header and a compressed block per resolution |
| PDB | atoms | a model chromosomix wrote, and only that ([below](#pdb-files)) |

Each opens from your disk or by address, and the text formats gzipped or not.

**Haplotypes.** The optional last column is `m`, `p` or `s` — or `maternal`, `paternal` and
`shared` — and a phased model has two chains for each chromosome, drawn as two homologues. Any
other word there is a category of its own, as `g3dtools` allows.

**Bead width.** A g3d does not state how wide its beads are, so the width is taken as the commonest
step between consecutive starts and printed on the row: a model meant to be at 10 kb that reads
*1.04 Mb* has been read as something other than you expected. A bed3d's beads keep their own ends.

**A binary g3d** is read by range, its header and then one block. It opens at its finest
resolution, and its other resolutions are named on the row. A version-1 container, written by a
`g3dtools` older than 0.2, is refused: run `g3dtools load` over the original text to rewrite it.

**Beads with no place.** A solver writes `nan`, `NA`, `inf`, `.` or nothing at all for a bin it
could not place. Such a bead is left out, and the gap it leaves in its chain is drawn as a dashed
line, so the chain reads as one chain with a hole. A file in which no bead has a place says so.

## How a file is recognised

A file named `.g3d`, `.3dg`, `.bed3d` or `.pdb` — gzipped or not, on your disk or at an address — is
read as the model its name says, and a file that turns out not to be one gets that format's own
refusal. A file whose name says nothing is recognised by its content: coordinates with fractions,
and beads that walk like a chain rather than scatter, which is what tells a model from a BED whose
columns happen to be numbers.

## How a model is matched to the map

A model and a map meet in base pairs, by sequence name. The model's sequences are renamed into the
map's spelling as a track's are, so `chr7` in the model meets `7` in the map
([Reference sequences](/files/sequences/)), and the row reports how many of the model's sequences
the map has.

- Pointing at a cell of the map lights the beads at its two loci — on both homologues of a phased
  model — and pointing at a bead marks its place on every map and track.
- The beads outside the window the maps are showing are ghosted, hidden or shown, as you choose.
- The model's bead width and the map's bin size are independent: the same model opens the same way
  beside a 1 kb map and a 50 kb one, and changing the map's resolution moves no bead.

Distances are in the model's own units; nothing claims nanometres.

## PDB files

A PDB says where each atom is in space and nothing about the genome, so chromosomix reads only the
PDBs it writes, which carry each chain's sequence and every bead's place in `REMARK 250` lines. The
first `MODEL` of several is read.

- A PDB from pastis or another solver, its beads in bin order and nothing else, is refused: placing
  them would mean guessing which bin each atom is. Write the coordinates beside the bins they were
  modelled at, as a bed3d, and open that.
- A PDB chromosomix wrote and PyMOL then saved again is refused too, because PyMOL drops the
  `REMARK` lines. Open the file as chromosomix wrote it, or its bed3d.

## Saving a model

A model leaves from its row, after the word *export*:

- **bed3d**, the format above, which reads back here and in `g3dtools`;
- **PDB**, for PyMOL, ChimeraX and other molecular viewers: a chain per sequence and haplotype, with
  bonds along the fibre and none across a gap. A model past what a PDB's columns can number — more
  than 99,999 beads, or a chain of more than 9,999 — leaves as a bed3d only, and the button says why.

A model built from the map by [Model from the map](/analyses/reconstruct3d/) leaves the same ways,
and `chromosomix reconstruct3d --out` writes both files. [Model versus map](/analyses/structuremap/)
measures how well a model agrees with the map, and [Spatial tracks](/analyses/spatialtracks/)
turns one into tracks.

## What is not read

Ensembles and series of frames — FOF-CT, `.cndb`, several models of one map in one file — are not
read: a row holds one model.
