---
title: "Your first map"
description: "A first session on public data: open a 4DN Hi-C map, move around it, change its resolution and normalisation, add a track, run insulation and share a link."
---

A first session on public data; you need a recent browser and a network connection. The map is in
situ Hi-C of K562 cells from the 4D Nucleome project (4DN), `4DNESC23ZYOF` (Belaghzal et al. 2021):
about 187 million contacts on GRCh38, in a 1.9 GB `.mcool` read by range. The
[guided tutorial](/start/tutorial/) plays the same session in the app.

## Open the app

Go to <https://chromosomix.app/>. The landing page opens files from your disk or a URL
(**Load files**), a folder, bucket, Google Drive or Dropbox (**Connect a local or remote folder**), or
a catalogue of published data (**Connect to a data store**). Under *Just looking?*,
**Human Hi-C data** opens K562 at the MYC locus with its tracks; each example's `?` says what it
opens.

![The landing page: play the tutorial under New here?, Load files with its drop area and URL box, the four buttons that connect a folder, a bucket, Google Drive or Dropbox, and the data store tiles with the pointer on 4DN open data.](../../../assets/screens/start/landing.webp)

## Open a map from the 4DN store

1. Under **Connect to a data store**, press **4DN open data**. The store drawer opens.
2. In its search box, type `4DNESC23ZYOF`.
3. On the set's heading, press **open with its tracks**. The map opens with 4DN's own compartment
   eigenvector (E1), insulation score and boundaries.

It opens on the **Chromosomes** table, beside the **General** panel, which describes the file.

A map on a server is read a piece at a time, and opening one means reading a few dozen small pieces
one after another. The app remembers which pieces a map needed, so the next time you open the same
map in this browser it asks for all of them at once and the map opens sooner. **Human Hi-C data**
and **Comparing data** come with their lists, so they open quickly the first time too.

![The Chromosomes table of 4DN's K562 map, a row per chromosome with its length, beside the General panel, whose File card gives its bin size, 25 kb as it opens, and a sum of 186,956,649 contacts, and whose Sequences card lists its chromosomes.](../../../assets/screens/start/chromosomes.webp)

## Pick a resolution and open a chromosome

1. At the end of the bar above the table, choose **250 kb** in the box beside the slider (or click
   its slot). Until you pick one, a map is read at the resolution of the screen and finer as you zoom,
   which is what the ticked **refine on zoom** beside it means; a pick takes over from it, and the
   tick shows unticked.
2. In the Chromosomes table, press **chr15**.

The blank square at the start is the short arm, with no unique sequence for reads to map to; the
checkerboard off the diagonal is the long arm's compartments.

## Move around

- **Drag** pans, the **wheel** or a pinch zooms, **double-click** fits the picture. After a click on
  the map, the arrow keys pan it; <kbd>0</kbd> fits it from anywhere.
- To open a stretch rather than enlarge it, hold <kbd>⌥ Option</kbd> (<kbd>Alt</kbd> on Windows and
  Linux) and drag a box across it; add <kbd>⇧ Shift</kbd> to keep it on the diagonal.
- Or type a place, `chr15:30,000,001-60,000,000`, and press **go**. Coordinates are 1-based and
  inclusive, as in IGV and UCSC.
- Beside **go**, two arrows move half a window, and `10×`, `3×`, `3×`, `10×` zoom out or in.
- The trail above the map (the file, **Chromosomes**, chr15, the window) and the header's back
  button take you back up; in a window of one chromosome, a click on the map opens it whole.

[Moving around](/browse/navigating/) has every gesture and key.

## Change the resolution

Open chr15 from 30 to 60 Mb and choose **5 kb**. Closer in, at `chr15:38,100,001-50,025,000`, the
squares along the diagonal are domains, mostly nested, and the dots at their corners are loops.

A window too wide for the resolution picked, 8,192 bins a side, is drawn coarser, and the
line under the title says so; zoom in and it is drawn at the one picked. <kbd>-</kbd> and <kbd>+</kbd>
step coarser or finer.

![chr15:38,100,001-50,025,000 at 5 kb, balanced on a log10 scale, with 4DN's compartment eigenvector, insulation score and boundaries drawn under the map.](../../../assets/screens/start/chr15-5kb.webp)

## Change the normalisation

On the **Map** card of the **Aesthetics** panel:

- **score**: this file opens **balanced**, from its own weights; *counts* is the raw counts, coverage
  bias included. *VC*, *VC √* and *ICE* are computed in the page; *expected* is the decay with
  distance alone; *correlation*, the plaid compartments are called from.
- **O/E** (<kbd>E</kbd>) divides each pixel by what its distance predicts: red is more contact than
  that, blue less.
- **smooth** averages neighbours: *3 × 3* evens out the sparse pixels of 5 kb.
- **transform**, **colours** and the two clip boxes set the colour scale.

O/E and smoothing change the picture, not what an analysis reads.
[Reading a contact map](/browse/contact-maps/) explains each score.

## Add a track

To add ENCODE's CTCF ChIP-seq of K562, press **+** in the header (*Add a file to this tab*), paste
this address under *or a URL*, and press **open**:

```text
https://encode-public.s3.amazonaws.com/2020/09/26/85161a5a-d6b5-49d2-bc0a-db0b217ff0d5/ENCFF979PWH.bigWig
```

It is drawn under the map; its row on the **Tracks** card of the **Annotations** panel
(<kbd>2</kbd>) sets its colour, height, range and edge. A file from your disk can be dropped on the
window, on an edge of the map or on **Load a track** ([Tracks and features](/files/tracks/)).

## Run an analysis: insulation

Insulation scores how much contact crosses each bin; its dips are domain boundaries.

1. Open the **Analysis** panel (<kbd>4</kbd>): **2D tasks** read the map, **3D tasks** model it,
   **1D tasks** read tracks.
2. Under **2D tasks**, press **Diamond insulation**. Its drawer opens.
3. It runs on every chromosome by default: in its list of sequences, press **none**, then tick
   **chr15**.
4. Keep the other defaults (a window of 10 bins, 50 kb at 5 kb) and press **run**.

The row says **running**, then **done**, while the map stays live. Close the drawer (<kbd>Esc</kbd>)
to see the score, its boundaries and its domains, each a row of the Tracks card; the score's row
saves it as a bigWig.

![chr15:38,100,001-50,025,000 at 5 kb after Diamond insulation, its row on the Analysis panel saying done: the computed insulation score and the boundaries it called drawn left of the map, the domains as corners along the diagonal, and 4DN's tracks and ENCODE's CTCF signal under the map.](../../../assets/screens/start/insulation.webp)

The console (<kbd>Ctrl</kbd> and the key left of <kbd>1</kbd>, Control on a Mac too) shows the run
as the `chromosomix` command that repeats it. [Diamond insulation](/analyses/insulation/) explains the
settings and the result.

## Share a link

Press *Share this tab as a link* in the header: the **Share this tab** dialog opens with the link
copied. It holds the whole tab — view, tracks, marks, bookmarks — so no server keeps it and it never
expires; as these files are public, anyone who opens it sees what you see. A computed track comes
back with **recompute**.

**shorten with is.gd** sends the link, file address included, to that third-party service.
*Save every tab as a file* (<kbd>Ctrl</kbd>+<kbd>S</kbd>, <kbd>⌘</kbd><kbd>S</kbd> on a Mac) keeps
every tab ([Sessions, workspaces and links](/browse/sessions-and-links/)).

## Next

- [Opening files](/files/opening/): your own files.
- [Maps side by side](/browse/deck/): several maps at once.
- [A tour of the window](/start/window/): the rest of the screen.
- [Analyses](/analyses/): the other tasks.
