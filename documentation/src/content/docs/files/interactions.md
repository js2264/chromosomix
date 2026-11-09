---
title: "Interactions"
description: "BEDPE, interact, bigInteract and longrange files of paired loci are drawn as rings on the contact map, or as arcs beside it and in the 1D browser."
---

An interaction file lists pairs of places that touch, such as loop calls. Load one like any track —
drop it on the map, or use the Tracks card's **Load a track** ([Opening files](/files/opening/)) —
and it opens on the map, a ring round each pair.

![The yeast micro-C map of IV:1,000,001-1,400,000 with a set of loop calls drawn as rings on it, loaded from its interact file, and the same loops from the loop caller's .tsv drawn as arcs under the map.](../../../assets/screens/files/rings-and-arcs.webp)

## The formats

| Format | On disk | Read as |
| --- | --- | --- |
| BEDPE | `chrom1 start1 end1 chrom2 start2 end2` and optional columns after them, 0-based | the six columns, or a headed table naming them, such as a loop caller's `.tsv`; pairs across two sequences are kept, off the diagonal |
| `interact` | UCSC's BED5+13: a span covering both ends, then each end's sequence, start, end, name and strand | ranked, read out and exported by its `value`, not the 0–1000 `score` of UCSC's shading, which stays on the pair's card |
| `bigInteract` | the same rows in a bigBed | recognised by its schema |
| `longrange`, `longTabix` | a BED3 and a fourth column, `chrom:start-end,score` | the score optional; the two mirrored lines of each interaction folded into one, the row saying how many |

A loop set saved as `.txt` or `.tsv` opens as pairs, recognised by its columns. A bgzipped
`longTabix` with its `.tbi` is read like any indexed text file
([Tracks and features](/files/tracks/)). Sequence names are matched as a track's are (`chr1` against
`1`).

## Rings and arcs

A ring outlines the pixel it points at, never covering it. A set is drawn only on the maps it is
placed on: dropped on a map's middle, **on this map** while you drag, it is drawn there alone. In a
deck, its row's **maps** field has a mark per map, with *every map*, *no map* and *on N of M*
([Maps side by side](/browse/deck/)).

The row's **display** switches between **map overlay**, the rings, and **arcs (1D track)** along any
edges of the map. An arc's height is the log of its span, so loops of 2 kb and 2 Mb show in one
view, and a pair with one end off screen is still drawn. Flipping the lane hangs the arcs from its
other side. In the 1D browser a set is always arcs.

## Anchors, analyses and the command line

The row's **anchors** export writes both ends of every pair as a BED, each place once.

The same files feed the analyses that pile up pairs, such as
[Aggregate peak analysis](/analyses/apa/), and the command line reads all four formats the same way
under `--pairs` and `--features` ([Running a task](/cli/running/)). The Manual annotations card
writes and reads its arrowheads and rectangles as BEDPE
([Annotations and bookmarks](/browse/annotations/)).
