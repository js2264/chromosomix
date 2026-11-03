---
title: "When a file will not open"
description: "The refusals and warnings chromosomix gives when a file cannot be opened or drawn, what each one means, and what to do about it."
---

When chromosomix cannot open a file, it says which file, what state it is in and what to do.
A contact map that cannot be opened is replaced by a page with a heading naming the problem, the
message, a few lines of advice, and **open another file** (with **try again** where trying again can
help). A track that cannot be read stays a row of the Tracks card, with the reason in red under its
name.

<!-- screenshot: a refusal page for a remote map whose host blocks cross-origin reads, with its advice and buttons -->

Two ways out work for almost any problem with a file on a server: download it and drop it on the
window, where it is read from your disk; or ask whoever hosts it to serve it as
[Hosting your data](/advanced/hosting/) describes. Each entry below is named by the heading or the
words the app uses, where it has them.

## The host will not serve the file

**That host will not let this page read the file.** The host did not allow a cross-origin read
(CORS), or refused the request outright. The app runs on another address than your data, so the
host must allow `GET` and `HEAD` from other sites, accept the `Range` header, and expose the
`Content-Length` and `Content-Range` headers — the exposed headers are what is most often forgotten.
A message saying the host *serves ranges but does not expose its size* is the same fix: add both
headers to the bucket's exposed headers.

**That host does not serve byte ranges.** A request for one byte came back as something other than
a part of the file. chromosomix reads a few kilobytes at a time, so a host without ranges would mean
downloading the whole file for every look. Host the file on object storage, or download it and drop
it. GEO and SRA download links serve no ranges and no CORS, and cannot be opened where they are.

**That host is compressing the file in transit.** The host adds a `Content-Encoding`, so a range
would address the compressed bytes rather than the file. A contact map up to 128 MB as sent is then
downloaded whole and opens anyway; a larger one is refused as **Too much to download for this
operation**. Object storage serves files uncompressed by default; GitHub Pages compresses and
cannot be told not to. The desktop app asks hosts not to compress and does not meet this.

**The host answered 403 or 404.** The address names nothing the host will hand over: the object is
private, the address is wrong, or the file has moved. For a private bucket, connect it with a key
([Opening files](/files/opening/)); a refusal that follows a key says the key reached the bucket and
was rejected, and lists what to check — the region, the key's permissions, a session token that has
expired. A presigned, signed or SAS link that worked yesterday and is refused today has expired: ask
for a fresh one.

**A Google file answers 401 or 403.** A Drive file or a Cloud Storage object that is not public needs
you to sign in to Google, and the refusal offers **sign in** — or **sign in again**, once an earlier
sign-in has run out after its hour. Refused while you are signed in, the file has not been shared
with that account, or the day's Drive quota is spent. The desktop app and the single HTML file
cannot sign in to Google: open the file on the website, or download it.

**A bucket that opens files but will not list.** *… does not allow anonymous listing* means the
bucket grants `s3:GetObject` (reading files) but not `s3:ListBucket` (listing them) — a normal setup
for published data. Its files still open by address; to browse it, the owner grants
`s3:ListBucket`, or you connect it with a key that has it.

**A UCSC hub or a store that cannot be read.** A store or a hub is read by the page, so its host must
allow cross-origin reads; UCSC's own servers do not. See [Data stores](/files/stores/).

## The file is not what its name says

**This is not an HDF5 file.** A file opened as a contact map does not begin like one. It may be
compressed — a `.cool.gz` or a zip, which must be decompressed first, since a cooler is read in place
— or be a download that stopped short, or a web page saved under the file's name.

**HDF5, but not a contact map.** The file is HDF5, but not a cooler, an `.mcool` or an `.scool`.
Check you picked the right file; `h5ls` lists what is in it.

**Text, but not a table this viewer reads.** A `.txt`, `.tsv` or `.tab` whose rows no reader takes.
Tables are read tab- or space-separated, one feature to a line; a table with a header row is read
when its first three columns are a sequence, a start and an end, or when it names `chrom1`,
`start1`, `end1`, `chrom2`, `start2` and `end2`.

**This file does not match the format.** The reader stopped at the first thing the file does not do
as its format says, and the message names it — often a count or an offset the file could not hold,
ending *the file is truncated, corrupt, or not the format its first bytes claim*. Download it again.

**Dimmed in a folder.** In the Files panel, a file chromosomix cannot open is listed dimmed, with the
reason in its tooltip:

| Name | Why, and what to do |
| --- | --- |
| `.csv` | comma-separated: the tables read here are tab- or space-separated |
| `.bz2`, `.xz`, `.zst` | a compression that cannot be inflated here: recompress with gzip, or bgzip to index it |
| `.cram`, `.crai` | CRAM needs its exact reference, which is not fetched: convert with `samtools view -b` |
| `.gzi` | not used: a compressed FASTA is read whole |
| `hub.txt`, `genomes.txt`, `trackDb.txt` | a UCSC hub, which opens as a store from its `hub.txt` |
| `.tbi`, `.bai`, `.csi`, `.px2` | an index, which comes with the file it indexes |

## A contact map that cannot be read

**Variable-bin file.** chromosomix reads maps whose bins are one fixed size. A fragment-level or
contig-level cooler, a fragment-level HiC-Pro map, and the fragment resolutions of a `.hic` are not
read. Bin the contacts at a fixed size — `cooler cload pairs` does it from the pairs — and open that.

**A version of `.hic` outside 7 to 9.** Versions before 7 predate the index chromosomix reads by.
Convert the file with `hic2cool`, or run Juicer Tools `pre` again.

**This is half of a contact map.** A HiC-Pro `.matrix` opened without its `_abs.bed`. Drop the two
together, connect the folder they are in and pick the matrix there, or name the bed with
`<matrix>#bins=<bed>` ([Contact maps](/files/contact-maps/)).

**A `.pairs` with a header problem.** The import needs:

- a first line `## pairs format` — a headerless contact list can be given one with
  `pairtools header generate`, or binned with `cooler cload pairs`;
- `#chromsize:` lines — the sizes cannot be guessed from the records; add them with
  `pairtools header generate --chroms-path <chrom.sizes>`;
- two chromosome columns and two position columns, as its `#columns:` line names them.

**Incomplete file.** A bgzipped `.pairs` that stops part-way through: every record that arrived is
drawn, and the note says the rest of the file was never there. A copy that finished downloading
fixes it.

**Selection too large to draw.** The block asked for would need more memory than a browser tab can
be given. Look at the whole sequences rather than their bins, narrow the range, or pick a coarser
resolution. Where the limit is only an estimate for this machine, **load anyway** reads it all the
same, at the risk of the tab running out of memory.

**Unknown sequence**, and **That range does not parse.** A typed locus names no sequence of this
file, or does not read as one. A locus is a sequence, or `sequence:start-end`, 1-based and
inclusive as IGV and samtools write it, with or without thousands separators and `k`, `M` or `G`;
the end must not come before the start, and neither may fall outside the sequence. A window typed
across a sequence's end is allowed only on a sequence declared circular
([Reference sequences](/files/sequences/)).

Two opens are questions rather than refusals: a remote `.scool`, which asks whether to download it
whole or read it in small pieces, and a HiC-Pro matrix over 200 MB, which says what reading it whole
will cost. Both are described on [Contact maps](/files/contact-maps/).

## An index that is missing or unusable

**A BAM with no index** is not refused: its reads are found by searching the sorted file, and its
row says *reads located by search*. Two things stop that. A BAM whose length the host will not say
cannot be searched: publish its index beside it, or name it with `#index=<address of the .bai>`. And
a BAM that is not sorted by coordinate — sorted by name, or a Hi-C pipeline's alignment file in
read-pair order — is refused; where its header did not say so, the refusal names two places in the
file that show it. Sort and index it:

```sh
samtools sort -o sorted.bam reads.bam
samtools index sorted.bam
```

For Hi-C, the `.pairs` or the contact map is the file to open.

**A FASTA over 300 MB with no index** is refused, by a sentence naming its size: index it with
`samtools faidx genome.fa` and drop the `.fai` with it, or publish it beside the FASTA. A gzipped
FASTA cannot be read by range at all, so past 300 MB it is refused whatever sits beside it:
decompress and index it, or use a `.2bit`.

**A missing `.tbi` or `.px2`, or a damaged `.tbi`,** costs only time: the file is read whole
instead.

## Too large to read whole

- **Text.** A browser cannot hold much more than half a gigabyte of text. A whole-genome human VCF
  is past that; split by chromosome, it opens. A bgzipped text file with its `.tbi` reads only the
  sequences the map holds ([Tracks and features](/files/tracks/)).
- **A bigBed past a million intervals** is cut off at the millionth, and says so.
- **A HiC-Pro matrix past about 250 million pixels** is not a browser tab's job: convert the two
  files to a `.cool` with `cooler load -f coo`.
- **A whole download past about 2 GB** — a remote `.scool` you chose to download whole — is more
  than a tab can hold: download the file yourself and drop it, and it is read from your disk.

## A track that draws nothing

- *No sequence in this file matches the map (0 of 16)* — every naming convention was tried, so the
  file is likely about another genome.
- *10 of 16 sequences matched; nothing is drawn on …* — the file covers part of the map. Check it
  was made against the same assembly.
- *Matched across two naming conventions, but the sequences are different lengths* — two assembly
  versions look like this: the coordinates land, but may not mean the same place.
- A lane that says *zoom in* has a reason not to draw at this width: *GC under 4 Mb, letters at base
  resolution — zoom in* for a sequence read by range, *12.4 MB of reads — zoom in* for a BAM, *zoom
  in to see reads* for a lane too short or too far out for its reads.

## A 3D model that is refused

- *A version-1 g3d* — rewrite it with `g3dtools load` over the original text.
- *A PDB says where each bead is in space and not where it is on the genome* — a PDB from pastis or
  another solver: write its coordinates beside their bins as a bed3d.
- *The lines that said where each one is on the genome are gone* — a PDB chromosomix wrote, saved
  again by PyMOL: open the file chromosomix wrote, or its bed3d.

See [3D models](/files/structures/).

## A file that was open yesterday

- **A local file after a reload.** A link or a restored tab cannot reopen a file from your disk on
  its own. Where the browser kept permission, the page offers **allow access to** the file; otherwise
  drop the same file again and the view comes back.
- **A connected folder** whose permission lapsed shows **reconnect** in the Files panel.
- **A folder listing that stops** at *Only the first 1,000 entries of … are listed*: open a
  sub-folder, or open the file by its address.

## In other copies of chromosomix

- **The single HTML file** opens local files only: it has no server behind it, so the browser
  refuses every network read. Use the website for remote files and stores.
- **The desktop app** cannot sign in to Google; public Drive links still open there.
- **A copy built by somebody else** without a Google client id or a Dropbox app key offers no
  sign-in on its landing page, and its Connect dialog says why; ask its maintainer, or use the
  website.

See [Web, desktop or one file](/start/where-to-run/).

## Something else

**Something went wrong** is the heading for a failure that is none of the above. Try again, and if it
persists, copy the message under the heading into a report — [Source code and contributing](/contributing/)
says where to send it.
