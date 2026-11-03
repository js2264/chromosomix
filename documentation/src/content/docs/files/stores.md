---
title: "Data stores"
description: "A data store is a catalogue of somebody's files that chromosomix opens in a drawer, whether one of its built-in stores, a UCSC track hub or a store a lab publishes."
---

A data store is somebody's shelf of files — a consortium's, a lab's, a genome collection — with
enough written about each file to choose it without opening it: its cell line, its assay, its
assembly, its size. chromosomix draws a store as a page you narrow with facets and a search box, in
a drawer beside whatever you have open, and every row opens with one press.

The files stay where their owners publish them and are read from there, by range, like any file you
open by address. Nothing is fetched until you open a store.

## The built-in stores

The landing page's **Connect to a data store** is a grid of tiles, one per store; press one to
open it.

<!-- screenshot: the Connect to a data store tiles on the landing page, with the example sessions beside them -->

| Store | What it holds | Drawn as |
| --- | --- | --- |
| **RSG lab data** | the lab's demos of the viewer and the figures of its papers, over yeast, human, chicken, mouse and bacterial data | a card per figure, under *Demo* and *Papers* |
| **IGV genomes** | IGV's reference genomes, each with the tracks IGV ships for it | a card per genome, whose button opens it with its tracks in the 1D browser |
| **4DN open data** | every file on the 4DN open-data bucket, by cell line, assay, lab and experiment set | a faceted list, grouped by experiment set |
| **ENCODE** | ENCODE's released signal, peaks and alignments, by assembly | a faceted list, grouped by experiment |
| **DNA Zoo** | chromosome-length assemblies and the Hi-C maps behind them | a faceted list, grouped by species under its common name |
| **Roadmap (UCSC hub)** | the Roadmap Epigenomics integrative tracks, as WashU publishes them | a hub, grouped by assembly |

ENCODE is split by what you came for: the two groups of tick boxes at the top of its facets,
**Genome** (GRCh38, hg19, mouse, other assemblies) and **Files** (signal, peaks and annotations,
alignments), choose which parts are read.

The 4DN store leaves out the alignment files of Hi-C-family assays, and ENCODE those of its Hi-C
pipeline: they are in read-pair order and could not be drawn as reads. The `.pairs` files and the
contact maps of the same experiments are there.

Beside the tiles, **Just looking?** offers four example sessions — *Human Hi-C data*, *Yeast
micro-C data*, *Linear tracks* and *Comparing data* — each a tab put together from these stores'
files. The `?` on each says what it holds.

## The store drawer

A store opens in a drawer down the left of the window, over whatever is open, so you can narrow a
catalogue beside a map you have been working on. Its head shows the store's name; a small row of
every tile, to switch stores; a link button that copies a link to the store as you have narrowed
it; an arrow to the store's own website; and a download of the catalogue as the drawer holds it.
The drawer is one per window, whichever tab is in front.

<!-- screenshot: the store drawer open on 4DN beside a map, with facets ticked and the tray showing two files -->

The stores button in the header and the <kbd>\\</kbd> key open and close it, and so does **Stores**
in the command palette; opened that way, it comes back on the store you were last on. <kbd>Esc</kbd>
puts it away.

### Finding a file

A faceted store — 4DN, ENCODE, DNA Zoo, a hub, a store of your own — has:

- **facets** down its side, one per column, with every value counted. Values ticked in one facet
  are either-or; ticks in different facets must all hold. The count beside a value is what ticking
  it would add;
- a search box, *search the names, notes and cells*, matching every word you type in any order;
- two views, the rows as a list and a matrix of two facets against each other (**down** and
  **across**), whose every cell is a count and a button that ticks both its values;
- **clear filters**.

The list draws the first 1,000 rows of the answer and says so when there are more; narrow it to see
the rest. Rows are grouped under the experiment, the set or the species they belong to, and a
group's heading carries **open with its tracks** where there is a session to open.

A row shows the file's name as the store gives it — *Hi-C on HFF cells, protocol variations* rather
than `4DNFI24F7GRY.mcool` — and its size where the store knows it. That name goes with the file onto
the map, track or tab it becomes.

### Opening what you find

Every row that is a file carries two marks:

- **+** adds it to the tab in front: a map comes up beside the map there, as a deck, anything else as
  a track, a 3D model in a cell of its own;
- the window mark opens it in a tab of its own, leaving the tab in front as it is.

A row that is a saved session opens as tabs. A row can also be dragged out of the drawer onto the
place you mean — a map's edge or middle, a cell of the deck, the Tracks card, an analysis form's
file box — exactly as a file is ([Opening files](/files/opening/)).

Tick several rows and a tray appears: **open together** opens the first map ticked and adds the rest
to it, in the order you ticked them; **add to this tab** adds each to the tab in front; **clear**
unticks them. Opening folds the drawer away; adding keeps it up, since you were aiming at something
beside it. A row never replaces what a tab holds.

When a map opens from a row that has tracks published with it, the Tracks card offers them as one
button: **load the N tracks published with this map**.

## Connecting a UCSC hub

A UCSC track hub is a store already: the **Connect to a UCSC hub** tile reads one. Paste the address
of its `hub.txt` and press **open**. Its genomes and every track chromosomix can draw become rows,
grouped by assembly, with the hub's own composite tracks as a facet.

- **The genome row.** An assembly hub's sequence is its `.2bit`, which opens as the genome with the
  hub's tracks beside it. A hub over an assembly UCSC hosts (`genome hg38`) carries no sequence; its
  genome row then comes from the `chromSizes` the hub names, or from the first bigWig or bigBed in
  it. A hub of nothing but BAMs gets no genome row and keeps its track rows.
- **open with its tracks** on an assembly's heading opens the genome with the tracks the hub turns on
  by default. A track the hub switches off still has a row of its own, and the store's description
  says how many are on — *440 tracks, 20 on by default*.
- **What is read**: `bigWig`, `bigBed`, `bigNarrowPeak`, `bigGenePred`, `bigPsl`, `bigChain`,
  `bigMaf`, `bigLolly`, `bigDbSnp`, `bigRmsk`, `bigBarChart`, `barChart`, `bigInteract`,
  `interact`, `bigMethyl`, `bedMethyl`, `longTabix`, `vcfTabix` and `bam` as tracks, and `hic` as a
  contact map. Anything else — `cram`, `halSnake`, a type there is no reader for — gets no row, and
  the store's description counts what was left out.

A hub is fetched by the page, so its host must allow a cross-origin read. Where it does not, open
**or paste the hub**, paste its text — a one-file hub, or the `hub.txt`, `genomes.txt` and
`trackDb.txt` one after the other — with the address its relative names hang off, and press **open
what is pasted**. **fill in an example** puts a small working hub in the box to start from.

:::caution[Hubs on UCSC's own servers]
`genome.ucsc.edu` and `hgdownload.soe.ucsc.edu` do not allow cross-origin reads, so no browser-only
viewer can read a hub hosted there, or its data files. Pasting the hub's text gets past the first
part, but its tracks are on the same servers and will not open either.
:::

The arrow in the drawer's head leads to UCSC's own list of public hubs. What a hub needs to be
readable is on [UCSC track hubs](/advanced/track-hubs/).

## Adding a custom store

A lab publishes its own store as one JSON file beside its data, and you read it from the **Add a
custom store** tile: paste its address and press **open**, or paste the file itself under **or paste
the store**. **remember this store** keeps it as a tile of its own in this browser; **forget this
store**, on its page, takes it away again, and nothing on the host changes. Remembered stores are
listed, and can be forgotten all at once, under **What this browser is remembering** in the command
palette.

How to write and publish one is on [Your own data store](/advanced/data-store/).

## Links to a store

The drawer writes what you are looking at into the address bar, so a link reopens the same store,
narrowed the same way; the link button in its head copies it. For example,
`https://chromosomix.app/?store=4dn&q=HFF` opens the 4DN store searched for *HFF*.

`?store=` takes a built-in store's id (`rsg`, `igv`, `4dn`, `encode`, `dnazoo`, `roadmap`) or the
address of a store file or a `hub.txt`; `q=` is the search, and `<column>=<value>` ticks a facet.
The [Files, hosts and stores](/reference/files-and-stores/) reference lists the ids.

## Links that expire

A presigned S3 link, a signed Google Cloud Storage link and an Azure SAS link all open, and go on
working until they expire. After that the host refuses them with a `403`, and the refusal names it:
ask for a fresh link, or for a public address, which is what a paper should cite.

A file opened from a connected Dropbox is read through a temporary link that lasts four hours, and
that link is what the address bar carries — enough for a colleague to open it the same afternoon,
not the next week.

## Credentials

A store's rows are read exactly as the files they name would be:

- **A bucket key.** A store, or a file, on a private bucket is read with the key of the bucket you
  connected that covers it ([Opening files](/files/opening/)). The key is kept in this browser.
- **Google.** A public Drive file opens with the site's own key, built in; nothing is asked of you.
  A private Drive file or Cloud Storage object needs you to sign in to Google. The sign-in lasts
  about an hour, and never longer than the tab; when it runs out, the refusal that follows offers
  to **sign in again**.
- **Dropbox.** Signing in lets you browse your Dropbox; the sign-in, too, lives only in the tab.

No server stands between you and the data, so chromosomix has no proxy to send a refused request
through: a host that will not answer a browser cannot be read. One example is the Aiden Lab bucket
`hicfiles.s3.amazonaws.com`, which answers only IGV's own programs.

## When a store will not load

- *Nothing has been published for … yet* — a built-in store whose catalogue is not on this copy of
  the site; the sentence says what publishes it.
- *… could not be read* — the host does not allow a cross-origin read; paste the file's text
  instead.
- *… answered with a page, not a store file* — the address leads to a web page, often a sign-in page.
- *… is not there: the host answered 404* — check the address.

More on every refusal is on [When a file will not open](/files/problems/).
