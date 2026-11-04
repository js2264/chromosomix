---
title: "UCSC track hubs"
description: "Open a UCSC track hub in chromosomix as a data store: what is read from its hub.txt, genomes.txt and trackDb.txt, which track types open, and what is left out."
---

chromosomix opens a UCSC track hub as a [data store](/advanced/data-store/), with its genomes and tracks as rows.

## Connecting a hub

1. On the landing page, under **Connect to a data store**, press **Connect to a UCSC hub**, or the same tile at the head of the store drawer.
2. Paste the address of the hub's `hub.txt` and press **open**.

The hub's text files are read at once; no track is read until you open it.

- **A link** to it is `https://chromosomix.app/?store=<address of hub.txt>`; the drawer's link button copies one, narrowed as the page is.
- **remember this store** keeps it as a tile in this browser; **forget this store** on its page removes the tile.
- **Either door works.** A hub is told by its first stanza, so it also opens from **Add a custom store**, and from an address not ending in `hub.txt`.
- **A hub on a private bucket** is read with the bucket key that covers it.

On this door, the arrow at the head of the drawer goes to UCSC's list of public hubs.

![The store drawer open on the yeast demo's assembly hub, its hub.txt address in the box, the facets Assembly, Genome, Role, Format and Group down the side, and its nine rows, the .2bit sequence and eight tracks, grouped under the sacCer3_syn40 heading with "open with its tracks" on it.](../../../assets/screens/advanced/track-hub-drawer.webp)

## What is read

| File | What chromosomix reads |
| --- | --- |
| `hub.txt` | `hub`, `shortLabel` (the store's name), `longLabel` (the start of its description), `genomesFile`, `useOneFile` |
| `genomes.txt` | each `genome` stanza: `genome`, `trackDb`, `twoBitPath`, `chromSizes`, and `organism` or `description` as the genome's name |
| `trackDb.txt` | each `track` stanza: `type`, `bigDataUrl`, `bigDataIndex`, `shortLabel` (the row's name), `longLabel` (its note), `parent` or `superTrack`, `visibility`; and every `include` line, followed |

- **One file or three.** With `useOneFile on`, the stanzas are in `hub.txt` itself, and a track belongs to the `genome` stanza it follows.
- **Each name is read against the file that wrote it**: a `bigDataUrl` against its `trackDb.txt`, a `twoBitPath` against `genomes.txt`.
- **The stanza format** is UCSC's. Indentation means nothing — a track nests by its `parent` line — and a `track` line starts a new stanza even without a blank line before it.
- **Display settings are not carried over**: tracks open with this viewer's own colours, heights and limits.
- **A hub is read in at most 64 files**, following `include` lines up to four files deep, so a very large hub may come in part.

## What a hub becomes

A row per genome and per track that can be drawn, grouped by assembly, with the columns *Assembly*, *Genome*, *Role* (sequence or annotation), *Format* and *Group*: the composite or super-track a track is filed under, usually the facet to narrow by.

**The genome row**, which the browser opens a genome on, is:

- an **assembly hub**'s own `.2bit` (`twoBitPath`);
- for a hub on an assembly UCSC hosts (`genome hg38`), its `chromSizes` file, or else its first `big…` track, whose header lists every sequence; the row's note says which;
- none, for a hub with neither: chromosomix does not fetch a sequence the hub did not name.

**open with its tracks**, on an assembly's heading, opens the genome row with the tracks the hub asks to show. Each track also has its own row.

## Track types

| Type | Opens as |
| --- | --- |
| `bigWig` | a signal track |
| `bigBed`, `bigNarrowPeak`, `bigGenePred`, `bigPsl`, `bigChain`, `bigMaf`, `bigLolly`, `bigDbSnp`, `bigRmsk` | a bigBed track |
| `bigBarChart`, `barChart` | a bar chart |
| `bigInteract`, `interact`, `longTabix` | interactions, drawn as arcs |
| `bigMethyl`, `bedMethyl` | methylation |
| `vcfTabix` | variants |
| `bam` | reads |
| `hic` | a contact map |

A `hic` track opens as a map, from its own row; **open with its tracks** leaves it out. An index named by `bigDataIndex` is read there, otherwise beside the file.

## Tracks a hub switches off

As at UCSC, a track with `visibility hide`, a subtrack with `parent <name> off`, and every subtrack of a hidden composite are off: **open with its tracks** leaves them out, but they keep their rows. The store's description counts both (*440 tracks, 20 on by default*).

## What is left out

A track this viewer cannot draw gets no row; the store's description counts them, with the reason:

- `cram`, which needs the exact reference its reads were compressed against: convert it to BAM with `samtools view -b`.
- `halSnake`, drawn by a server, with no file to read.
- a stanza with no `type`, or a type with no reader here.

Composites, super-tracks and views are headings, not rows: their names fill the *Group* column.

### Hubs on UCSC's own servers

As of September 2026, `genome.ucsc.edu` and `hgdownload.soe.ucsc.edu` do not let other sites read them, so no browser-only viewer can open UCSC's example hubs or GenArk, and chromosomix says so. Pasting such a hub's text gets past its `hub.txt`, not its data files. Copy the hub and its files to a host that does ([Hosting your data](/advanced/hosting/)), or drop a downloaded track or two on the window. A connected folder lists a `hub.txt` but does not open it as a hub.

## Pasting a hub

When a hub's host will not answer, or while you write one, open **or paste the hub** under the address box. Paste a one-file hub, or `hub.txt`, `genomes.txt` and `trackDb.txt` one after another, give the base address of relative names in the box under it, and press **open what is pasted**. A `hub.txt` alone is refused, with a note naming the file to add. A pasted hub is not remembered, nor linked.

**fill in an example** puts this working hub, over the yeast demo data, in the box:

```text
hub exampleHub
shortLabel Example hub
longLabel Yeast demo data from RSG lab
useOneFile on

genome R64-1-1
organism Saccharomyces cerevisiae
twoBitPath https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/store/yeast/S288c.2bit

track signal
compositeTrack on
shortLabel Signal
longLabel Two tracks, grouped as their hub groups them
type bigWig

    track mnase
    parent signal on
    shortLabel MNase
    longLabel Nucleosome occupancy
    bigDataUrl https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/store/yeast/Yeast_MNase.bw
    type bigWig

    track atac
    parent signal on
    shortLabel ATAC
    longLabel ATAC-seq accessibility
    bigDataUrl https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/store/yeast/Yeast_ATAC.bw
    type bigWig

track contacts
shortLabel Micro-C map
longLabel A contact map, which opens through the map door
bigDataUrl https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/store/yeast/GSE151553_A364_merged.hic
type hic
```

Its genome row is the yeast `.2bit`; **open with its tracks** adds the *Signal* composite's two bigWigs; the Micro-C map has its own row.

## Roadmap, a hub that ships with the viewer

**Roadmap (UCSC hub)**, a built-in store, is WashU's hub of the Roadmap Epigenomics integrative tracks (`https://vizhub.wustl.edu/VizHub/RoadmapIntegrative.txt`), read from WashU when you open it, and linked as `https://chromosomix.app/?store=roadmap`. The arrow at the head of its page goes to Roadmap's WashU portal.

## Publishing a hub of your own

Publish a hub like a [data store](/advanced/data-store/#hosting-it), with its data on a host that serves byte ranges ([Hosting your data](/advanced/hosting/)). For UCSC's browser too, keep to the formats UCSC takes in a hub — the `big…` formats, `bam`, `cram`, `vcfTabix`, `hic`, `longTabix` — so a BED or narrowPeak goes in as a bigBed. For chromosomix alone, a store file also takes your own columns, sizes and saved sessions.
