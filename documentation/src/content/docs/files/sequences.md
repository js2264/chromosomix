---
title: "Reference sequences"
description: "chromosomix reads FASTA and .2bit reference sequences, matches chromosome names that differ between files, and lets you declare which sequences are circular."
---

A reference sequence is the assembly itself: every sequence, its exact length, and its bases.
Beside a map it draws a sequence lane of GC content; in the 1D browser it draws the bases once a
base has a pixel to itself, with the six reading frames on request
([The genome browser](/browse/genome-browser/)). It is what the sequence tasks read —
[Find a motif](/analyses/motif/), [Base composition](/analyses/composition/),
[Restriction sites](/analyses/restriction/), [Origin and terminus](/analyses/oriter/) — and what
colours a BAM's mismatches.

Open a FASTA or a `.2bit` with no map and it opens the 1D browser over its genome, with nothing else
needed.

## FASTA

A FASTA (`.fa`, `.fasta`, `.fna` or `.fas`) is read one of two ways, by its size:

- **Under 64 MB** — a yeast genome, a fly's — it is read whole and held, `.fai` or not: every zoom
  draws GC content, every pan is free, and the tasks read it in memory.
- **Over 64 MB, with its index** — the `.fai` that `samtools faidx` writes, dropped beside it, at
  `<address>.fai` on a server, or named with `#index=<address>` — it is read by range. The genome is
  on screen as soon as the index has arrived, and only the windows a lane asks for are read. The
  lane's summary ends *read by range from its index*.

A sequence read by range gives up what needed all of it in memory. Its GC lane draws nothing over a
window wider than 4 Mb, and says *GC under 4 Mb, letters at base resolution — zoom in*; the Origin
and terminus task declines it; and a BAM's mismatches are coloured only from the stretch the
sequence lane last drew. The motif search and base composition read it a piece at a time, and say
what that will cost before they run.

Over 64 MB with no index, a FASTA is read whole up to 300 MB, and refused above that by a sentence
naming its size and the command that indexes it:

```sh
samtools faidx genome.fa
```

A gzipped or bgzipped FASTA is read whole whatever its size, and refused past 300 MB: indexing a
compressed FASTA needs a `.gzi`, which chromosomix does not read. Decompress it and index it, or use
a `.2bit`.

## .2bit

UCSC's `.2bit` is read by range, and it is one file: its index is its own first kilobyte, so there
is no second file to forget to publish. It is also a quarter of the size of the same FASTA — hg38 is
3.1 GB of FASTA and 800 MB of `.2bit`. An assembly hub's genome is a `.2bit`, which is how a hub's
tracks get their sequence ([Data stores](/files/stores/)).

A `.2bit` is read by range as an indexed FASTA is, with the same limits. Its gaps are read as runs
of `N`, not as whatever bases the file packed under them; soft-masking is not shown, every base
being drawn in capitals. Refused: a version-1 `.2bit`, the variant for files over 4 GB (convert it
with `twoBitToFa` and `faToTwoBit`); a file declaring more than 100,000 sequences; and one that ends
part-way through, which says it is truncated.

## One genome, many names

Two files of one genome rarely agree on its names. UCSC writes `chr1` where Ensembl and many `.hic`
files write `1`; a yeast cooler writes `chrI` and the `chrom.sizes` beside it may write `01`.
chromosomix matches them for you wherever a name is asked for — a track loaded on a map, a second
map in a deck, a 3D model, a name typed in the locus box — once the file's own spelling has been
tried and failed.

| Rule | Example |
| --- | --- |
| the same name | `chr1` = `chr1` |
| another case | `Chr1` = `chr1` |
| the same accession, undecorated | `ref\|NC_001133\|` = `NC_001133` |
| the `chr` prefix | `chr1` = `chrom1` = `chromosome_1` = `1` |
| leading zeros | `01` = `1` |
| Roman numerals | `chrXII` = `12` |
| an organelle spelled another way | `chrM` = `MT` = `MtDNA` = `NC_012920.1` |
| the accession | `NC_000001.11` = `chr1`; `chrUn_GL000220v1` = `GL000220.1` |
| another version of the accession | `NC_000001.10` ≈ `NC_000001.11` — offered, and flagged |

The rules are built never to match two different sequences quietly:

- **The whole list decides.** `X` is chromosome ten in a file that also counts `IX` and `XI`, as
  budding yeast does, and the sex chromosome in one whose numerals stop at `V`, as *C. elegans*'s
  do; a list that numbers chromosomes both ways — a host with a yeast spike-in — keeps `X` as the
  sex chromosome. A bare number in a list longer than any genome's set of chromosomes — an
  assembler's contigs `1`, `2`, `3`… — is an id, and matches only as spelled.
- **Not equated:** a chromosome arm and its chromosome (*Drosophila*'s `2L` and `2R` are not `2`);
  a patch or one parent's copy and the chromosome (`_random`, `_alt`, `_fix`, `_hap1`, `_maternal`);
  a linkage group (`LG`) and a chromosome number; and a name that follows no convention, which
  matches only exactly.
- **Lengths check the match.** Where two matched sequences have different lengths — hg19's `chrM`
  and hg38's — the match is reported rather than taken quietly: *Matched across two naming
  conventions, but the sequences are different lengths…*. Two assembly versions look exactly like
  this.

When a match was made, chromosomix says so. A map in a deck that answered a name it does not write
prints a line under its heading, such as *“chrIV” read as “IV”, by the chr prefix*. A track's row
reports how many of its sequences the map has; where none match, it says
*No sequence in this file matches the map (0 of 16)* — every convention was tried, so the file is
likely about another genome.

## Circular sequences

A `.cool` cannot say that a sequence joins its own ends, so a bacterial chromosome, a plasmid or a
mitochondrion arrives looking like a short linear chromosome, with the contacts that join its last
bin to its first in the far corner of the map. You declare which sequences are circles, and the
first time a file is opened, chromosomix proposes them.

<!-- screenshot: the Chromosomes table of a bacterial map, with the circular and origin columns and a sequence ticked -->

**Where.** The **Chromosomes** table has a **circular** column of tick boxes, a sequence to a row,
and an **origin** column beside it. A declared sequence wears a `↻` in the General panel's
Sequences card. A genome opened from a FASTA or from tracks has the same two columns on its own
Chromosomes table, and a map opened over it takes what was declared there.

**Proposed on first open.** Each of a file's 50 longest sequences that has at least 50 bins is
tested once: the contacts across its two ends are compared with those along the diagonal at the
same separation, which is about 1 on a circle and about 0 on a line. A sequence scoring 0.2 or more
is ticked, and a banner names it and says where to untick it; the tick's tooltip quotes the score.
The test only ever adds ticks, and only on a file's first open, so a sequence you untick stays
unticked. A small circle read at a coarse resolution may be left for you to tick.

**What a tick changes.**

- A window can be typed across the junction — `chrom:2,900,000-100,000` on a 3 Mb circle is the
  200 kb that span it — and is read round the circle.
- The map offers **ori**, which frames the whole circle with its origin in the middle, the two arms
  running out to the corners; and **arms**, which takes the observed-over-expected along both arms
  rather than along the diagonal alone. See [Reading a contact map](/browse/contact-maps/).
- The analyses measure separation the short way round, with no setting of their own to remember:
  P(s), insulation, the directionality index, the HiC score, the scalogram, compartments, and the
  tasks that read from the origin. Chromosight and the observed-over-expected map do not.

**The origin** is a sequence's first base until another is set. Type a 1-based position into the
**origin** column, or let [Origin and terminus](/analyses/oriter/) place it; a position you typed
is never overwritten by the task.

Declarations are kept with the file and in a saved workspace, not in a link. From the command line,
`chromosomix circular <map>` runs the same test and prints a table, and `--circular <name>` and
`--origin <name:pos>` declare them for a run — see [Command line](/reference/command-line/).
