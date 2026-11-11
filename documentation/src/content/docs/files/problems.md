---
title: "When a file will not open"
description: "When chromosomix cannot open or draw a file it says why, and this page explains each refusal and what to do about it."
---

When chromosomix cannot open a file, it says why and what to do. A contact map is replaced by a page
naming the problem, with advice, **open another file** and, where it can help, **try again**. A
track stays on the Tracks card, the reason in red under its name.

![The page that replaces a zebra finch .hic on GenomeArk's public bucket, which allows no cross-origin read: the heading That host will not let this page read the file, the message naming the missing Access-Control-Allow-Origin, three lines of advice, What the file actually says, and open another file.](../../../assets/screens/files/cors-refusal.webp)

Two fixes work for almost any file on a server: download it and drop it on the window, or have its
host serve it as [Hosting your data](/advanced/hosting/) describes.

## The host will not serve the file

**That host will not let this page read the file.** The host refused a cross-origin read (CORS), or
the request. It must allow `GET` and `HEAD` from other sites, accept the `Range` header, and expose
`Content-Length` and `Content-Range`; *serves ranges but does not expose its size* means those two
are not exposed.

**That host does not serve byte ranges.** Host the file on object storage, or download it and drop
it. GEO and SRA download links serve neither ranges nor CORS.

**That host is compressing the file in transit.** A contact map of up to 128 MB as sent is then
downloaded whole and opens anyway; a larger one is refused as **Too much to download for this
operation**. Object storage serves files uncompressed by default; GitHub Pages always compresses.
The desktop app asks hosts not to compress, and does not meet this.

**The host would not give this file.** 404 or 410: no file at that address. 401 or 403: a file this
page may not read — private, at a wrong address, or moved. A public file must be readable by anyone.
For a private bucket, connect it with its key (**connect a bucket…**,
[Opening files](/files/opening/)); a refusal after that lists what to check. A presigned, signed or
SAS link refused after working yesterday has expired: ask for a fresh one.

**A Google file answers 401 or 403.** A private Drive file or Cloud Storage object needs a Google
sign-in: the refusal offers **sign in**, or **sign in again** after an hour. Refused while signed
in, the file is not shared with that account, or the day's Drive quota is spent.

**A bucket that opens files but will not list.** *… does not allow anonymous listing*: the bucket
grants `s3:GetObject` but not `s3:ListBucket`. Its files still open by address; to browse it, the
owner grants `s3:ListBucket`, or you connect it with a key that has it.

**A UCSC hub or a store that cannot be read.** Its host must allow cross-origin reads; UCSC's own
servers do not ([Data stores](/files/stores/)).

## The file is not what its name says

**This is not an HDF5 file.** The file may be a compressed cooler (a `.cool.gz` or a zip: decompress
it), a download cut short, or a web page saved under the file's name.

**HDF5, but not a contact map.** Not a cooler, an `.mcool` or an `.scool`. Check you picked the
right file; `h5ls` lists what it holds.

**Text, but not a table this viewer reads.** Tables are tab- or space-separated, one feature per
line. A headed table needs a sequence, a start and an end as its first three columns, or columns
named `chrom1`, `start1`, `end1`, `chrom2`, `start2` and `end2`.

**This file does not match the format.** The message names where the file breaks its format, often
ending *the file is truncated, corrupt, or not the format its first bytes claim*. Download it again.

**Dimmed in a folder.** The Files panel's tooltip says why:

| Name | Why, and what to do |
| --- | --- |
| `.csv` | comma-separated: the tables read here are tab- or space-separated |
| `.bz2`, `.xz`, `.zst` | a compression that cannot be inflated here: recompress with gzip, or bgzip to index it |
| `.cram`, `.crai` | CRAM needs its exact reference, which is not fetched: convert with `samtools view -b` |
| `.gzi` | not used: a compressed FASTA is read whole |
| `hub.txt`, `genomes.txt`, `trackDb.txt` | a UCSC hub, which opens as a store from its `hub.txt` |
| `.tbi`, `.bai`, `.csi`, `.px2` | an index, which comes with the file it indexes |

## A contact map that cannot be read

**Variable-bin file.** A fragment-level cooler or HiC-Pro map is refused, and a `.hic`'s fragment
resolutions are not offered: bin the contacts at a fixed size with `cooler cload pairs`.

**This is a version … .hic file.** Only versions 7, 8 and 9 are read: convert it with `hic2cool`, or
run Juicer Tools `pre` again.

**This is half of a contact map.** A HiC-Pro `.matrix` needs its `_abs.bed`: drop both, pick the
matrix from a connected folder holding both, or name the bed with `<matrix>#bins=<bed>`.

**A `.pairs` with a header problem.** The import needs a first line `## pairs format` (give a
headerless contact list one with `pairtools header generate`, or bin it with `cooler cload pairs`),
`#chromsize:` lines (`pairtools header generate --chroms-path <chrom.sizes>` adds them), and two
chromosome and two position columns, as its `#columns:` line names them.

**Incomplete file.** A bgzipped `.pairs` cut off part-way is drawn from the records that arrived; a
complete download fixes it.

**Selection too large to draw.** Show whole sequences rather than bins, narrow the range, or pick a
coarser resolution. Where the limit is an estimate for this machine, **load anyway** reads it
regardless, at the risk of the tab running out of memory.

**Unknown sequence**, **That range does not parse.** A locus is a sequence, or `sequence:start-end`,
1-based and inclusive as in IGV and samtools, with or without thousands separators and `k`, `M` or
`G`, its end not before its start and both inside the sequence. Only a sequence declared circular
takes a window across its end ([Reference sequences](/files/sequences/)).

A `.pairs` file, a remote `.scool` and a HiC-Pro matrix over 200 MB ask a question before opening
rather than refuse ([Contact maps](/files/contact-maps/)).

## An index that is missing or unusable

**A BAM with no index** is read by searching the sorted file (*reads located by search*), unless its
host will not say its length: publish its index beside it, or name it with
`#index=<address of the .bai>`. A BAM not sorted by coordinate — sorted by name, or a Hi-C
pipeline's alignment file in read-pair order — is refused. Sort and index it, or, for Hi-C, open the
`.pairs` or the contact map instead:

```sh
samtools sort -o sorted.bam reads.bam
samtools index sorted.bam
```

**A FASTA over 300 MB with no index** is refused: index it with `samtools faidx genome.fa` and keep
the `.fai` beside it. A gzipped FASTA past 300 MB is refused whatever sits beside it: decompress and
index it, or use a `.2bit`.

**A missing `.tbi` or `.px2`, or a damaged `.tbi`,** costs only time: the file is read whole.

## Too large to read whole

- **Text** past about half a gigabyte, such as a whole-genome human VCF: split it by chromosome
  ([Tracks and features](/files/tracks/)).
- **A bigBed past a million intervals** is cut off at the millionth, and says so.
- **A HiC-Pro matrix past about 250 million pixels**: convert it with
  `cooler load -f coo --one-based <abs.bed> <matrix> out.cool` and open that.
- **A whole download past about 2 GB**, such as a remote `.scool`: download the file yourself and
  drop it.

## A track that draws nothing

- *No sequence in this file matches the map (0 of 16)*: every naming convention failed, so the file
  is likely about another genome.
- *10 of 16 sequences matched; nothing is drawn on …*: the file covers part of the map. Check it was
  made against the same assembly.
- *Matched across two naming conventions, but the sequences are different lengths*: two assembly
  versions look like this; the coordinates land, but may not mean the same place.
- A lane that says *zoom in* will not draw at this width: *GC under 4 Mb, letters at base resolution
  — zoom in* for a sequence read by range, *12.4 MB of reads — zoom in* for a BAM, *zoom in to see
  reads* for a lane too short or too far out for its reads.

## A 3D model that is refused

- *A version-1 g3d*: rewrite it with `g3dtools load` over the original text.
- *A PDB says where each bead is in space and not where it is on the genome*: a solver's PDB. Write
  its coordinates beside their bins as a bed3d.
- *The lines that said where each one is on the genome are gone*: a chromosomix PDB saved again by
  PyMOL. Open the file chromosomix wrote, or its bed3d.

## A file that was open yesterday

- **A local file** does not reopen from a link or a restored tab on its own: where the browser kept
  permission, press **allow access to** the file; otherwise drop it again.
- **A connected folder** whose permission lapsed shows **reconnect** in the Files panel.
- **A folder listing that stops** at *Only the first 1,000 entries of … are listed*: open a
  sub-folder, or open the file by its address.

## In other copies of chromosomix

- **The single HTML file** opens local files only; use the website for remote files and stores.
- **The desktop app** cannot sign in to Google; public Drive links still open there.
- **A copy built by somebody else** without a Google client id or a Dropbox app key offers no
  sign-in, and its Connect dialog says why: ask its maintainer, or use the website.

## Something else

**Something went wrong** heads any other failure. Try again; if it persists, report it on
[the project's GitHub issues](https://github.com/js2264/chromosomix/issues) with the message under
the heading.
