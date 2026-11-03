---
title: "Opening files"
description: "Every way to open a file in chromosomix — from your disk, by its address, from a connected folder, Google Drive, Dropbox or a data store — and what is read, and when."
---

chromosomix reads your files where they are. A file on your disk is read in place by the page,
a few kilobytes at a time; a file on a server is read by byte range from its address. Nothing is
uploaded, and nothing has to be converted first.

This page is about getting files in. What each format becomes is on its own page:
[contact maps](/files/contact-maps/), [tracks and features](/files/tracks/),
[interactions](/files/interactions/), [reference sequences](/files/sequences/) and
[3D models](/files/structures/).

## Drop or choose files

On the landing page, under **Load files**, drop files on the area that reads **Drop genomic files
here**, or click it to choose them in your system's dialog. Several files can go at once.

<!-- screenshot: the landing page, with Load files and its URL box, the Connect a local or remote folder buttons and the data store tiles -->

Once a tab has something open, drop files anywhere on the window. To add one from a dialog
instead, press the **+** in the header, **Add a file to this tab**. To replace what the tab holds,
click the file's name at the start of the breadcrumb: it opens **Open a file**, and what you
choose there takes the tab's place. In the desktop app, **File → Open…** (<kbd>Ctrl</kbd>
<kbd>O</kbd>, or <kbd>⌘</kbd> <kbd>O</kbd> on a Mac) goes back to the drop area.

A file is told by its name first and its bytes second, so a `.txt` or a `.tsv` holding a format
chromosomix reads opens too.

## Open a file by its address

Under the drop area, behind the rule that reads **or a URL**, paste the file's address and press
**open** (or <kbd>Enter</kbd>). The host has to serve byte ranges and allow a cross-origin read:
S3, Google Cloud Storage, Cloudflare R2, Azure and most static web servers do, once they are set up
as [Hosting your data](/advanced/hosting/) describes.

Some addresses are rewritten into the form that can be read:

| You paste | It is read as |
| --- | --- |
| a Dropbox share link, `https://www.dropbox.com/…` | the same file on Dropbox's content host, with no sign-in |
| a Google Drive file link, `https://drive.google.com/file/d/<id>/…` | the file through the Drive API; a public file opens without signing in |
| `gs://bucket/object` | the public address Google Cloud Storage gives it |
| `s3://bucket/key` | the bucket's own address, or the address of a bucket you connected |

The address bar then carries the form that works, so a link copied from it opens for a colleague
too, as long as they can reach the file.

Two things can follow an address:

- `::/resolutions/<bin size>` opens one resolution of a multi-resolution file:
  `https://example.org/sample.mcool::/resolutions/10000`.
- `#index=<address>` says where a file's index is when it is not beside the file under the usual
  name — a presigned BAM, say, whose `.bai` has a signature of its own. A HiC-Pro matrix takes
  `#bins=<address>` for its bin file ([Contact maps](/files/contact-maps/)).

A link to the app can name a file as well, `https://chromosomix.app/#uri=<address>`, with the place
to open it at: see [Link keys](/reference/links/). A presigned link opens and works until it
expires, which makes it good for sharing today and not for a paper
([Data stores](/files/stores/) has more on links that expire).

:::caution[GEO and SRA]
Download links from GEO and SRA serve no byte ranges and no CORS, so they cannot be opened where
they are. Download the file and drop it, or serve a copy from a bucket.
:::

## Connect a folder

When you will open one file after another from the same place, connect the place rather than
naming files one by one. The landing page's **Connect a local or remote folder** row has four
buttons, and the command palette has the same command.

<!-- screenshot: the Files panel listing a connected folder, with a .bam beside its dimmed .bai -->

A connected place appears in the **Files** panel at the left edge of the window, listed one level
at a time: open a sub-folder to see inside it. Click a file's name to open it, or use the two marks
on its row — **+** adds it to the tab in front, and the window mark beside it opens it in a tab of
its own. A row can also be dragged onto the map, exactly as a file from your desktop is
([below](#several-files-at-once)).

- A listing stops at 1,000 entries and says so: open a sub-folder, or open the file by its address.
- A file chromosomix cannot open is listed dimmed, with the reason in its tooltip. An index is
  dimmed too, because it comes with the file it indexes: pick the `.bam` and its `.bai` comes with
  it.

### A folder on this machine

**choose a folder…** opens your system's folder picker. The folder is read in place, and nothing in
it is sent anywhere. How long it stays connected depends on how you run chromosomix:

- In the desktop app, the single HTML file, or the site installed as an app from Chrome or Edge,
  the folder stays connected across restarts, and a workspace saved there remembers which of your
  files came from it, so reopening the workspace finds them again.
- In an ordinary browser tab the button reads **choose a folder (this visit)…**: the folder is
  connected until you close the page, and nothing about it is kept.
- Firefox and Safari have no folder picker. What they hand over is a snapshot of the file list for
  this visit, which does not update when files are added and does not survive a reload.

A kept folder whose permission has lapsed stays in the Files panel with a **reconnect** button.

### A bucket

**connect a bucket…** opens a short form: a **name** of your choosing, the **URL** of the prefix
(`https://bucket.s3.amazonaws.com/prefix/` or `s3://bucket/prefix/`), and, under **additional
settings**, the **region**, **access key ID**, **secret key** and **session token** of a private
bucket. Press **connect this bucket**: the listing that appears is the test.

- A public bucket needs only its URL. Browsing it needs `s3:ListBucket` granted to everyone in the
  bucket's policy, which many published buckets do not grant; its files still open by address.
- A key is kept in this browser and sent only with requests under its prefix. It is listed, and can
  be forgotten, under **What this browser is remembering** in the command palette
  (<kbd>Ctrl</kbd> <kbd>P</kbd>, or <kbd>⌘</kbd> <kbd>P</kbd>). Give it read access to that prefix
  and nothing more.
- Any store that answers S3's listing request works: S3, R2, MinIO, and Google Cloud Storage's XML
  interface once the bucket has a CORS policy.

## Google Drive and Dropbox

A share link to a single Drive or Dropbox file opens like any address: paste it into the URL box.
To browse your own Drive or Dropbox, sign in from the landing page's **sign in to Google…** or
**sign in to Dropbox…**:

- **Google Drive.** Press **sign in to Google**. Once you are signed in, the same pane asks for a
  **name** and a **folder link or id** — the address bar of the folder open in Drive, a shared
  drive included — and **connect this folder** lists it in the Files panel. Leave the link empty
  for all of My Drive. Signing in also opens Drive files and Google Cloud Storage objects that are
  not public.
- **Dropbox.** Press **sign in to Dropbox**. Dropbox opens in a new tab and shows a code: paste it
  into **code**, press **finish**, then **browse my Dropbox**. A file opened from it is read through
  a temporary link that lasts four hours, which is also what the address bar carries.

A sign-in lasts as long as the tab. Its token is held in the tab's memory, never written down, and
expires on its own — about an hour after a Google sign-in. Google's `drive.readonly` is read access
to all of your Drive, not to one folder. Drive also slows ranged reads down, so it is a host
chromosomix reads rather than one to keep large maps on.

The desktop app cannot sign in to Google, its window having no web address to register, though
public Drive links still open there; Dropbox works in both. The single HTML file reaches neither.

## Data stores

Under **Connect to a data store**, each tile opens a catalogue of somebody's files in a drawer down
the left of the window: the lab's own data, IGV's genomes, 4DN, ENCODE, DNA Zoo, Roadmap, any UCSC
track hub, or a store a lab publishes. Its rows open with the same two marks as a folder's. See
[Data stores](/files/stores/).

## Indexes and other companion files

Some files come with a second one that makes them faster to read, or readable at all. Drop the two
together, or pick the file from a connected folder with its companion beside it, and they are
paired by name.

| Companion | For | Without it |
| --- | --- | --- |
| `.bai` or `.csi` | a BAM | the reads are found by searching the sorted file, one window of up to 4 Mb at a time |
| `.tbi` | a bgzipped text file — `.bed.gz`, `.gtf.gz`, `.vcf.gz`… | the whole file is read |
| `.fai` | a FASTA over 64 MB | the FASTA is read whole up to 300 MB, and refused above |
| `.px2` | a `.pairs.gz` | the import cannot know beforehand how many records are coming, and counts bytes rather than records |
| `<prefix>_<res>_abs.bed` | a HiC-Pro `.matrix` | there is no map: the bed is the matrix's coordinates |

Both names `samtools index` writes are paired, `reads.bam.bai` and `reads.bai`. For a file on a
server, the index is looked for at the file's own address with the index's extension added —
`<address>.bai`, `<address>.tbi`, `<address>.fai`. Where it is somewhere else, add
`#index=<its address>` to the file's address. A `.gzi` is not used.

## Several files at once

Select several files and drop them together, and chromosomix decides what each one is:

1. A saved workspace (`.chromosomix.json`) among them opens first, and the other files are taken
   as the ones it names.
2. Otherwise a contact map takes the tab, and every other contact map opens beside it, in the order
   you selected them, as maps that pan and zoom together — see
   [Maps side by side](/browse/deck/).
3. With no map, the first track or sequence opens the 1D browser over the genome it describes
   ([The genome browser](/browse/genome-browser/)).
4. Everything else is drawn as a track on what opened, and a 3D model in a cell of its own beside
   it.

Indexes are paired with their files first, so a `.bam` and its `.bai` dropped on an empty window
open as one.

Dropped on a tab that already holds something, a file adds to it rather than replacing it: a
contact map comes up beside the one there, and anything else joins the tracks. To put a file in a
particular place, drag it there — the targets light up as you drag:

| Drop it on | And it becomes |
| --- | --- |
| a strip along the map — **above the map**, **below the map**, **left of the map** or **beside the map** | a track in that stack |
| the middle of a map, **on this map** | an overlay on that map alone, or a track on its usual edge |
| the Tracks card | a track |
| the Structures card | a 3D model |
| the Contact maps card's **Load a map into the lower triangle** | the second map of one square ([Comparing two maps](/browse/comparing/)) |
| an empty cell, or an edge of the deck | a cell of its own |
| a file box in an analysis form | that run's input, without opening it |

To replace the tab's file instead, use **Open a file** from the breadcrumb, **Open a different
file** in the command palette, or a **New tab**.

## What is read, and when

Opening a file reads only what its first picture needs. The rest is read when you look at it, and
kept, so going back to a place you have seen costs nothing. The status bar's **read** counts the
requests and bytes.

| File | What is read |
| --- | --- |
| `.cool`, `.mcool`, `.hic` | a few kilobytes to open, then the block each view needs |
| a HiC-Pro matrix | the whole matrix, once, when it opens |
| `.pairs` | every record, once, when it is imported; afterwards the map is in memory |
| `.scool` on a server | you are asked first: the whole file, or about a thousand small reads |
| bigWig | the window on screen, at the file's own zoom level for that width |
| bigBed | the whole file, once |
| BED, GTF, GFF3, bedGraph, VCF and other text | the whole file — or, bgzipped with a `.tbi`, only the sequences the map holds |
| BAM | the reads under the window on screen |
| FASTA | the whole file under 64 MB; above that, with its `.fai`, the window on screen |
| `.2bit` | its index, then the window on screen |
| a 3D model | a text model whole; a binary g3d its header and one block |

When a map opens with tracks, the map is drawn first and its tracks are read after it, so the
picture you asked for does not wait behind a large annotation file.

Nothing is sent anywhere. A local file is read on your machine by the page, and a remote one goes
from its host straight to your browser. See [Privacy](/advanced/privacy/).

## Opening the same files again

A link or a saved workspace can name a file on a server, but not a file on your disk, which only
you have. After a reload, a tab that held a local file comes back to the drop area. Chrome and Edge
may have kept permission to read it: the page then offers **allow access to** the file (or to all
of the files it remembers), and the view comes back. Otherwise, drop the same file again. See
[Sessions, workspaces and links](/browse/sessions-and-links/).

## Which copy can open what

| | Your disk | Addresses | Folders on this machine | Buckets, Drive, Dropbox | Data stores |
| --- | --- | --- | --- | --- | --- |
| the website | yes | yes | for this visit, or kept when installed as an app | yes | yes |
| the desktop app | yes | yes | kept | buckets and Dropbox; public Drive links | yes |
| the single HTML file | yes | no | kept, where the browser has a folder picker | no | no |

The single HTML file opens local files only: it has no server behind it, so the browser refuses
every network read. See [Web, desktop or one file](/start/where-to-run/).
