---
title: "UCSC track hubs"
description: "Open a UCSC track hub in chromosomix as a data store: what is read from its hub.txt, genomes.txt and trackDb.txt, which track types open, and what is left out."
---

A UCSC track hub is a shelf of published data in the format most of the world's genomics data is
already indexed by: a `hub.txt` naming a `genomes.txt`, which names a `trackDb.txt` for each
assembly, in which each track is a stanza with a `bigDataUrl` and a `type`. chromosomix reads a hub as
a [data store](/advanced/data-store/): its genomes and tracks become rows, with the same facets, the
same search, the same **remember this store** and the same `?store=` link as any other store.

## Connecting a hub

1. On the landing page, under **Connect to a data store**, press **Connect to a UCSC hub** — or the
   same tile in the row at the head of the store drawer.
2. Paste the address of the hub's `hub.txt` and press **open**.

The hub is read there and then — the `hub.txt`, its `genomes.txt` and each `trackDb.txt` — and nothing
of its tracks until you open one. Its page is headed by the hub's own name.

- **A link** that opens it is `https://chromosomix.app/?store=<address of hub.txt>`; the link button at
  the head of the drawer copies one, narrowed as the page is.
- **remember this store** keeps it as a tile in this browser, and **forget this store** on its page
  takes the tile away.
- **Either door works.** A hub is told by its first stanza, not by its address, so a hub pasted into
  **Add a custom store** opens just the same, and so does one served from an address that does not
  end in `hub.txt`.
- **A hub on a private bucket** is read with the bucket key that covers it, as any store is.

The arrow at the head of the drawer, on this door, goes to UCSC's own list of public hubs.

<!-- screenshot: a track hub open in the store drawer, rows grouped by assembly with "open with its tracks" on the heading -->

## What is read

| File | What chromosomix reads |
| --- | --- |
| `hub.txt` | `hub`, `shortLabel` (the store's name), `longLabel` (the start of its description), `genomesFile`, `useOneFile` |
| `genomes.txt` | each `genome` stanza: `genome`, `trackDb`, `twoBitPath`, `chromSizes`, and `organism` or `description` as the genome's name |
| `trackDb.txt` | each `track` stanza: `type`, `bigDataUrl`, `bigDataIndex`, `shortLabel` (the row's name), `longLabel` (its note), `parent` or `superTrack`, `visibility`; and every `include` line, followed |

- **One file or three.** A hub with `useOneFile on` holds its genome and track stanzas in the
  `hub.txt` itself, and a track belongs to the `genome` stanza it follows. The classic three files are
  read in turn.
- **Each name is read against the file that wrote it**: a `bigDataUrl` against the `trackDb.txt`
  that names it, a `twoBitPath` against `genomes.txt`, and the tracks of an `include`d file against
  that file.
- **The stanza format** is UCSC's: `key value` on a line, a blank line between stanzas, `#` for a
  comment, a trailing `\` to continue a line. Indentation means nothing — what nests a track is its
  `parent` line — and a new `track` line starts a new stanza even without a blank line before it.
- **Display settings are not carried over.** A stanza's colour, height or view limits are not read;
  each track opens with this viewer's own defaults, which you can then change as for any track.
- **A hub is read in at most 64 files** — its `genomes.txt`, each `trackDb.txt` and what they
  `include`, following `include` lines up to four files deep — so a very large hub may come in part.

## What a hub becomes

One row for each genome, and one for each track that can be drawn. The rows are grouped by assembly,
with the genome's name on each heading, and carry five columns to narrow by: *Assembly*, *Genome*,
*Role* (the sequence or an annotation), *Format* and *Group* — the composite or super-track the hub's
author filed the track under, usually the facet worth narrowing by.

**The genome row** is what the browser opens a genome on, and it is one of three things:

- an **assembly hub** carries its own sequence as a `.2bit` (`twoBitPath`), and the row is that
  sequence;
- a hub on an assembly UCSC hosts (`genome hg38`) carries no sequence, so the row is the
  `chromSizes` file the hub declares, or failing that the first `big…` track of its own, whose header
  holds every sequence and its length — the row's note says which;
- a hub with neither gets no genome row and keeps its track rows. chromosomix does not go to UCSC's
  servers for a sequence the hub did not name.

**open with its tracks**, on an assembly's heading, opens the genome row and loads the tracks the hub
asks to show. Each track also has a row of its own, to open by itself or add to a map you already
have.

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

A `hic` track opens as a map rather than a track: it has a row of its own and is not among the tracks
**open with its tracks** loads. A BAM or tabix index at an unusual address, which a stanza names with
`bigDataIndex`, is found there; otherwise it is looked for beside the file.

## Tracks a hub switches off

A large hub asks for a few of its tracks to be on when you connect, and the rest off. chromosomix
reads the hub's answer the way UCSC does: a track with `visibility hide`, a subtrack with
`parent <name> off`, and every subtrack of a hidden composite are off. **open with its tracks** loads
only the tracks that are on, and the store's description says how many there are of each — for one
published hub, *440 tracks, 20 on by default*. A track that is off is not absent: its row is there, to
open by hand.

## What is left out

A track this viewer cannot draw gets no row, and the store's description counts what was left out,
with the reason:

- `cram` — CRAM needs the exact reference its reads were compressed against, which chromosomix will
  not fetch. Convert it to BAM with `samtools view -b`.
- `halSnake` — HAL alignments are drawn by a server, and there is no file behind one to read.
- a stanza with no `type`, or a type with no reader here.

Composites, super-tracks and views are headings rather than files, so they get no row of their own:
their names fill the *Group* column of the tracks under them.

### Hubs on UCSC's own servers

A hub is fetched by your browser, so its host must let other sites read it. As of September 2026,
`genome.ucsc.edu` and `hgdownload.soe.ucsc.edu` do not, which puts UCSC's own example hubs and GenArk
out of reach of every viewer that runs in a browser alone; the message chromosomix shows for such a
hub says so. Pasting the hub's text (below) gets past its `hub.txt`, but its data files are on the
same servers and will not open either. chromosomix does not route your requests through a proxy to
get round another host's headers.

## Pasting a hub

When a hub's host will not answer, or while you are writing one, open **or paste the hub** under the
address box and paste the hub's text: a one-file hub, or the `hub.txt`, `genomes.txt` and
`trackDb.txt` one after another, which read exactly as one file. If its names are relative, give the
address they hang off in the box under it, then press **open what is pasted**. A `hub.txt` pasted
alone is refused, with a note naming the file to paste after it. A pasted hub is not remembered, and
not put in the address bar.

**fill in an example** puts a small hub that works in the box — this one, over the yeast demo data:

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

It is an assembly hub: the genome row is the yeast sequence as a `.2bit`, **open with its tracks**
opens it with the two bigWigs of the *Signal* composite, and the micro-C map has a row of its own that
opens as a map.

## Roadmap, a hub that ships with the viewer

**Roadmap (UCSC hub)**, among the built-in stores, is WashU's hub of the Roadmap Epigenomics
integrative tracks over the 111 reference epigenomes,
`https://vizhub.wustl.edu/VizHub/RoadmapIntegrative.txt`, read as any hub you connect would be — and
read from WashU when you open it, not before. Its link is `https://chromosomix.app/?store=roadmap`,
and the arrow at the head of its page goes to Roadmap's WashU portal.

## Publishing a hub of your own

A hub is published like a [data store](/advanced/data-store/#hosting-it): its three files on a host
that lets other sites read them, and its data files on a host that serves byte ranges as
[Hosting your data](/advanced/hosting/) describes. A hub meant for UCSC's browser as well should keep
to the formats UCSC takes in a hub — the `big…` formats, `bam`, `cram`, `vcfTabix`, `hic` and
`longTabix` — so a plain BED or narrowPeak goes in as a bigBed. For a shelf meant for chromosomix
alone, a [store file](/advanced/data-store/) also takes columns of your own, sizes and saved
sessions.
