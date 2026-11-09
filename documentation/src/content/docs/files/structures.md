---
title: "3D models"
description: "chromosomix opens 3D chromatin models as g3d text or binary, Dip-C's .3dg, bed3d or its own PDB, and matches each to the map by sequence name and base pair."
---

A 3D model is a chain of beads, each a stretch of the genome placed in space. Dropped beside a
map, it opens in a cell of its own, linked both ways to the map and its tracks
([3D models beside the map](/browse/structures/)); with no map, it opens over its beads' genome and
takes the screen. Each model is a row of the Annotations panel's **Structures** card, whose **Load a
structure** zone takes the formats below; the row's eye shows and hides the model's cell.

![The Structures card with the yeast model's row, 2,431 beads · 5 kb · 16 sequences, and the model's cell beside the yeast micro-C map, where the pointer on a cell 262 kb off the diagonal lights the beads at its two loci on chromosome IV, joined by a dashed chord.](../../../assets/screens/files/model-beside-map.webp)

## The formats

| Format | Each row | What it is |
| --- | --- | --- |
| g3d text | `chrom start x y z [haplotype]` | WashU's format: no end, no header, rows in any order |
| `.3dg` | the same, with the haplotype in the name, `chr7(mat)` | Dip-C's models |
| bed3d | `chrom start end x y z [haplotype]` | the same with each bead's end |
| binary g3d | — | what `g3dtools load` writes: a header and a block per resolution |
| PDB | atoms | a model chromosomix wrote, and only that ([below](#pdb-files)) |

Text formats may be gzipped, and a file whose name says nothing is recognised by its content.
Ensembles and series of frames (FOF-CT, `.cndb`) are not read: a row holds one model.

- **Haplotypes.** The optional last column is `m`, `p` or `s` (or `maternal`, `paternal`, `shared`),
  and a phased model draws two homologues per chromosome. Any other word is a category of its own.
- **Bead width.** In a g3d it is taken as the commonest step between consecutive starts, and printed
  on the row: a model meant to be at 10 kb that reads *1.04 Mb* was not read as you expected. A
  bed3d's beads keep their own ends.
- **A binary g3d** opens at its finest resolution, its others named on the row. A version-1
  container, from a `g3dtools` older than 0.2, is refused: rewrite it with `g3dtools load` over the
  original text.
- **Beads with no place** — `nan`, `NA`, `inf`, `.` or nothing — are left out, the gap drawn as a
  dashed line. A file with no placed bead says so.

## How a model is matched to the map

A model meets a map in base pairs, by sequence name, matched as a track's are (`chr7` meets `7`);
the row reports how many of its sequences the map has. Pointing at a map's cell lights the beads at
its two loci, on both homologues of a phased model; pointing at a bead marks its place on every map
and track. Beads outside the maps' window are ghosted, hidden or shown, as you choose. Changing the
map's resolution moves no bead. Distances are in the model's own units; nothing claims nanometres.

## PDB files

chromosomix reads only the PDBs it writes, whose `REMARK 250` lines place each bead on the genome;
of several `MODEL`s, the first is read. A PDB from pastis or another solver is refused, and so is
one chromosomix wrote and PyMOL saved again, which drops the `REMARK` lines: write the coordinates
beside their bins as a bed3d, or open the file as chromosomix wrote it.

## Saving a model

A model's row exports, after the word *export*, a **bed3d**, which reads back here and in
`g3dtools`, and a **PDB** for PyMOL or ChimeraX: a chain per sequence and haplotype, bonded along
the fibre but not across a gap. A model too big for a PDB's columns — more than 99,999 beads, or a
chain of more than 9,999 — leaves as a bed3d only, and the button says why.

A model built by [Model from the map](/analyses/reconstruct3d/) leaves the same ways, and
`chromosomix reconstruct3d --out` writes both files. [Model versus map](/analyses/structuremap/)
measures a model's agreement with the map; [Spatial tracks](/analyses/spatialtracks/) turns it into
tracks.
