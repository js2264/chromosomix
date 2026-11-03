---
title: "Tracks and features"
description: "The 1D files chromosomix draws beside a contact map or in its genome browser — signal, intervals, gene models, variants, reads, methylation, charts, ideograms and splice junctions — and how each is read."
---

A track is anything laid along the genome. Drop one on an open map and it is drawn beside the map,
on any of its four edges; open one with no map and chromosomix opens the 1D browser over the genome
the file describes ([The genome browser](/browse/genome-browser/)). Each track is a row of the
**Tracks** card in the Annotations panel, whose **Load a track** zone takes a drop or a click.

<!-- screenshot: the Tracks card with a bigWig, a GTF and a BAM loaded, and the lanes they draw under a yeast map -->

A file is told by what is in it, not only by its name, so a `.txt` of peaks or a headed `.tsv` of
calls opens as what it is. A track's sequences are matched to the map's even when the two spell
them differently (`chr1` against `1`, see [Reference sequences](/files/sequences/)), and the row
says when they do not all match: *10 of 16 sequences matched; nothing is drawn on XI, XII, …*.

| Kind | Formats | Drawn as |
| --- | --- | --- |
| Signal | bigWig, bedGraph, wig | a value track |
| Intervals | BED, narrowPeak, broadPeak, gappedPeak, bigBed | features |
| Gene models | GTF, GFF3, genePred, genePredExt, refFlat, bigGenePred | transcripts with their exons |
| Variants | VCF | the variants somebody called |
| Reads | BAM, with its `.bai` or `.csi` | depth, and the reads themselves |
| Methylation | bedMethyl, bigMethyl | percentage modified |
| Charts | barChart, bigBarChart | a small bar chart on each feature |
| Ideograms | cytoBand, cytoBandIdeo | each chromosome's bands |
| Splice junctions | STAR's `SJ.out.tab`, a junctions BED, leafcutter's `.junc` | arcs with read counts |
| Lengths | `chrom.sizes` | the genome itself |

Pairs of loci — BEDPE, interact, longrange — are on [Interactions](/files/interactions/), and FASTA
and `.2bit` on [Reference sequences](/files/sequences/).

## Signal: bigWig, bedGraph and wig

A **bigWig** is read by range, from your disk or by address: each view reads the window on screen
at the file's own zoom level for that width, which is what makes ten bigWigs over a whole genome
cheap.

A **bedGraph** and a **wig** are the same kind of track written as text. They are read whole, and
the summary for a window is worked out when the window is drawn. A bedGraph is recognised strictly
— exactly four columns, the fourth a number on every row, or a `track type=` line saying so — so a
BED with a name column is never mistaken for one; a wig is recognised by its `fixedStep` or
`variableStep` lines, and its 1-based positions are read as such.

All three draw as a value track, with its own limits, colour and style, and can share an axis with
other tracks; see [The genome browser](/browse/genome-browser/).

## Intervals: BED and bigBed

A **BED** of 3, 4, 5, 6, 9 or 12 columns, a **narrowPeak**, **broadPeak** or **gappedPeak**, and a
table with a header row whose first three columns are a sequence, a start and an end all open as
features. A BED12 draws its blocks as exons, its thick span thicker. A BED is drawn beside the map,
never on it.

A **bigBed** is read whole, once, and drawn exactly as the BED it holds. Past a million intervals it
is cut off, and says so. A bigBed whose own schema says it is something more — a bigGenePred, a
bigBarChart, a bigMethyl or a bigInteract — is read as that.

## Gene models: GTF, GFF3 and genePred

**GTF** and **GFF3** are read as transcripts assembled from their exon and CDS rows: the coding span
drawn thick and the untranslated ends thin, the stop codon counted as coding, as in UCSC's tables.
A bacterial GFF3 from Prokka, Bakta or DFAST, whose rows name no parent, is read a feature per row,
under its `locus_tag` and its gene symbol. Rows that describe a whole sequence (`region`, `source`)
are left out.

**genePred**, **genePredExt** and **refFlat** — every UCSC table download (`refGene`, `ncbiRefSeq`,
`knownGene`), and the `refFlat` RNA-seq pipelines take — open as the same gene models, with or
without the leading `bin` column of a database dump. A **bigGenePred** is read as the BED12 it is
and drawn as a gene model.

You can load several gene models. The star on a gene model's row marks the one the locus box
searches when you type a gene's name.

## Called variants: VCF

A **VCF** opens as a lane of the variants somebody called. A substitution is drawn in the colour of
the base it changes to — the colours the sequence lane and a BAM's mismatches use — and an
insertion, a deletion or a symbolic allele (`<DEL>`, `<DUP>`) in grey, as wide as it is: a symbolic
allele's size is read from its `INFO/END` or `INFO/SVLEN`. Click a variant for its card: `REF>ALT`,
its type, `QUAL`, `filter`, and the `AF`, `DP` and `SVTYPE` of its `INFO`.

- A VCF whose header has `##contig` lines opens the 1D browser on its own chromosomes, at their
  exact lengths.
- Sample columns are counted, not drawn: the lane's summary says, for example,
  *1,284 variants · 2,504 samples not drawn*.
- A bgzipped VCF with its `.tbi` is read only for the sequences the map holds.
- A VCF is read as text into memory, so the whole-genome calls of one human sample are too large
  to open; split by chromosome, they open. A BCF is not read: `bcftools view` writes the VCF.

## Reads: BAM

A **BAM** opens as two rows, both read from the window on screen:

- **depth**, under the file's name, is a value track like a bigWig, beside a map or in the browser.
  A bin holds the mean depth: a deletion counts as covered and a skipped intron does not, secondary
  and supplementary alignments are left out, and duplicates are kept unless you switch on **hide
  duplicates**.
- **reads**, as *name · reads*, is the pile of individual reads, drawn in the 1D browser only, where
  a read has bases to be drawn along.

<!-- screenshot: a BAM's depth and reads rows in the 1D browser, with mismatches coloured and a read's card open -->

**min MAPQ** and **hide duplicates** apply to both rows; the colouring, the layout of pairs and
**split reads** to the pile alone. Where the reads disagree with the reference they are coloured,
from the reads' own `MD` or `=`/`X` codes, or from a FASTA open in the same tab. Base modifications
come from the `MM` and `ML` tags a nanopore or PacBio basecaller writes: **colour by** → *base
modification* on the pile, and **% modified** on the depth row. A spliced library draws the introns
its reads skip as arcs over the depth (**junction arcs**, from two reads by default).

**The index.** A `.bai` or `.csi` beside the BAM is read once, and every window's reads are then
read directly. Without one, the reads are found by searching the sorted file, a handful of small
reads a window; the row's summary says *reads located by search*, and windows are answered one at a
time, up to 4 Mb. A remote BAM's index is looked for at `<address>.bai`; where it lives elsewhere,
add `#index=<address of the .bai>`.

**Zoomed out.** A BAM has no summary to draw from, so a window too deep to read draws nothing and
says why — *12.4 MB of reads — zoom in* — and so does a pile asked for over too wide a window.

**Refused.** A BAM must be sorted by coordinate. One sorted by read name, or a Hi-C pipeline's
alignment file, which is in read-pair order, is refused with the commands that sort and index it:

```sh
samtools sort -o sorted.bam reads.bam
samtools index sorted.bam
```

For Hi-C, the `.pairs` or the contact map is the file to open. CRAM is not read: convert it with
`samtools view -b`.

## Methylation: bedMethyl and bigMethyl

A **bedMethyl** — what `modkit pileup` writes, or the older ENCODE WGBS spelling — and a
**bigMethyl** open as a track of percentage modified, one value per base, on an axis of 0 to 100 to
begin with. Where a file holds several modifications over the same bases, 5mC and 5hmC say, the
commonest is drawn and the lane's summary lists every code in the file with its count of rows.
Codes are named as the SAMtags specification names them: `m` 5mC, `h` 5hmC, `a` 6mA, and so on. A
row with no reads under it is left out rather than drawn as 0 %.

## Charts: barChart and bigBarChart

UCSC's **barChart** gives each feature a vector of values — expression across tissues or
conditions — and each is drawn as a small bar chart where there is room, and as one box in the
colour and height of its top category where there is not. The categories' names and colours come
from the file's `track` line (`barChartBars`, `barChartColors`). A **bigBarChart** opened on its own
has no such line, so its categories are numbered.

Every chart on a lane shares one ceiling, the file's `maxLimit` or its largest value. **scale each
chart** draws each against its own tallest bar instead, and typed limits put the lane on a fixed
axis, which is how two files are compared. Click a feature for its whole chart, a row per category.

## Ideograms: cytoBand

A **cytoBand** or **cytoBandIdeo** draws each chromosome as its Giemsa bands, pinched at the
centromere and narrowed along a stalk, in the stains UCSC and IGV use. The line under the lane names
the bands in the window (`Xq27.3 – q28`), a click names a band as a cytogeneticist would (`Xq28`),
and the locus box finds bands by name beside genes.

A cytoBand whose bands tile every chromosome declares the genome: UCSC's `hg19_cytoBand.txt` alone
opens the browser over hg19's sequences at their exact lengths.

## Splice junctions

Junctions are drawn as a sashimi plot's arcs, from the end of one exon to the start of the next,
each labelled with its read count. Three files are read:

| File | Written by | Recognised by |
| --- | --- | --- |
| `SJ.out.tab` | STAR | its nine integer columns |
| a junctions BED12 | regtools, TopHat, Portcullis | `junc` or `sj` in its name, a TopHat `track` line, or `JUNC…` row names |
| `.junc` | leafcutter | its name |

What else a file says — STAR's multi-mapping reads, motif, *annotated* and overhang, or a BED's
anchors — is on each junction's card and can colour the lane, so colouring by *annotated* maps novel
splicing. A file with junctions on both strands splits the lane, forward arcs above its middle and
reverse arcs below. The lane's lower limit is a filter, like a sashimi plot's minimum junction
coverage. A spliced BAM draws its own arcs, from the reads ([above](#reads-bam)).

## Lengths: chrom.sizes

A **chrom.sizes** — two columns, a name and a length, as UCSC writes it, or a `.genome` file of the
same shape — declares a genome. Opened on its own, it starts the 1D browser on those sequences.
Dropped on a browser that was started from a feature file, whose lengths could only be guessed from
its furthest feature (the Genome card then says *inferred (rounded up)*), it gives the real ones.

## Reading part of a large text file

Text formats — BED, GTF, GFF3, bedGraph, VCF and the rest — are read whole. Bgzipped and indexed with
tabix, a text file is read only for the sequences the open map holds: a human GTF beside a map of
one chromosome reads about a twentieth of the file.

```sh
sort -k1,1 -k2,2n peaks.bed | bgzip > peaks.bed.gz
tabix -p bed peaks.bed.gz
```

Keep the `.tbi` beside the file, drop the two together, or name it with `#index=<address>`. The
index is only ever a saving: a plain `.gz`, a bgzipped file without one, and an index that is
missing, damaged or for another assembly all fall back to reading the whole file — and so does an
index that would save less than a fifth of it.

A browser cannot hold much more than half a gigabyte of text, so a larger file cannot be read
whole: index it, or split it by chromosome.

## The file's own columns

**Colouring by a column.** A feature lane is coloured by strand to begin with. Its settings'
**colour by** offers the file's other columns too — a GTF's `biotype` and `source`, a narrowPeak's
`signal`, a VCF's `QUAL`, `filter` and `SVTYPE`, a BED's name column — as categories in a fixed
palette, commonest first, or, for numbers, a colour ramp over the file's whole range, which does
not change as you pan. Names that are exactly `A` and `B` take the compartments' red and blue.

**The map's own columns.** A cooler keeps columns beside its pixels: at least the balancing weight
in its bins table, and whatever else the tool that wrote it added. The **Metadata annotations** card,
folded at the foot of the Annotations panel, offers them: pick a column and press **add**, and it is
drawn as a lane like any track — numbers as bars, labels as runs of colour. A column is offered
where the view on screen can show it, and its row exports it as a TSV, a row per bin or sequence as
the file wrote it.
