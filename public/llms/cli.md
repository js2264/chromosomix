# chromosomix command line

> `chromosomix` runs the analyses of the app’s Analysis panel from a shell — insulation, compartments, loops, APA, P(s), virtual 4C, peaks, metaplots and two dozen more — with the same parameters and the same results as a run in the browser, for scripts and pipelines. It reads `.cool`, `.mcool`, `.hic`, `.scool`, HiC-Pro and `.pairs` maps, and bigWig, BED-like and FASTA files, from disk or by address, and writes TSV, BED, bedGraph and bigWig.

## Install

```sh
node --version                 # 22.12 or later
npm install -g chromosomix     # the latest release
npx chromosomix@<version> …    # a pinned release, with nothing installed
chromosomix --version          # the build on its first line, then Node, h5wasm and @gmod/bbi
```

A pipeline or a methods section should pin a version. From a clone: `npm install`, then `npm run build:cli && npm link`.

## Finding a task and its parameters

```sh
chromosomix tasks          # every task, its flags and their defaults
chromosomix tasks --json   # the same, with every value a choice takes, every range and unit
chromosomix --help         # the usage below
```

Every task, with every parameter, is also on [the task page](https://chromosomix.app/llms/tasks.md). The shape of a command:

```sh
chromosomix <task> <map> [<map> …] [--<parameter> <value> …] --out <dir>
```

- **One task, one or more maps.** Each map is run on its own and its outputs are named after it, up to its first dot: `sample.coverage.coverage-total.tsv`. Two that would share a name keep more of theirs, and nothing one command writes is written over by it.
- **A map** is a path or an `http(s)` address. An `.mcool` names one resolution — `sample.mcool::/resolutions/10000` — and one named bare is refused with the list of the resolutions it has. A `.pairs` is binned first and needs `--bin-size <bp>`.
- **Balanced by default.** A map is read balanced wherever the file carries weights, as the app reads it; `--no-balance` reads the raw counts.
- **A locus is the display form**: 1-based and inclusive, digits grouped or not — `--window IV:1,000,001-1,400,000` — as the app, IGV and samtools write one.
- **Remote files are read by range** where they can be: one rung of a 7 GB `.mcool` costs that rung. What has to be read whole — a feature file, a workspace, a host that serves no ranges — is fetched into `$TMPDIR` and removed when the command ends.
- **Every output records its provenance**: each TSV opens with `#` lines naming the build, the file and every parameter, so `head` says how a number was made.

## Exit status

- `0`: every file ran.
- `1`: at least one file failed; the others still ran, and stderr says which and why.
- `2`: the command was refused before any file was opened — an unknown task or flag, a choice that is none of its values, a number that is not one, a missing input. The sentence on stderr names what the flag takes. Fix the command and run it again.

Progress and notes go to stderr; `--quiet` silences progress.

## Examples

```sh
# Insulation and its boundaries, on one resolution of an .mcool
chromosomix insulation sample.mcool::/resolutions/10000 --window 10 --out results/

# P(s) and its slope; compartments phased by GC content
chromosomix expected sample.cool --out results/
chromosomix compartments sample.cool --sequence ref.fa.gz --phaseSequence ref.fa.gz --out results/

# Loops and borders by pattern, then a pileup at a loop set
chromosomix chromosight sample.cool --pattern borders --out results/
chromosomix apa sample.cool --pairs loops.bedpe --norm chromosight --out results/

# A 4C profile from an anchor, written as the app writes a locus
chromosomix fourc sample.cool --anchor IV:1,200,001-1,210,000 --out results/

# Tasks over tracks, with or without a map
chromosomix metaplot --tracks ATAC.bw --features peaks.narrowPeak --flank 2000 --out results/
chromosomix frip sample.cool --tracks ATAC.bw,MNase.bw --features peaks.narrowPeak
chromosomix peaks --signal ChIP.bw --out results/
chromosomix overlap sample.cool --features peaks.bed --a peaks.bed --features tads.bed --b tads.bed

# Two libraries drawn to one depth before they are compared
chromosomix insulation rep1.cool rep2.cool --contacts 10M --out results/

# A map read by range from where it is published
chromosomix insulation https://example.org/sample.mcool::/resolutions/10000 --out results/

# A 3D model from the map, as a bed3d and a PDB
chromosomix reconstruct3d ecoli.mcool::/resolutions/20000 --out results/

# What `pairtools stats` writes, for MultiQC
chromosomix stats sample.pairs.gz --out qc/
```

## From the app to a script

Every run in the app is written to its console as the `chromosomix` command that repeats it, so a reader can tune a run on screen and copy the line. A saved workspace runs again over other files, every analysis it recorded with the parameters it recorded:

```sh
chromosomix replay workspace.chromosomix.json --over data/*.hic --out results/
```

## The usage, as `chromosomix --help` prints it

```
chromosomix — the Analysis panel, from a shell

  chromosomix tasks [--json]
      Every task, its id, and the parameters it takes. With --json, the same
      as one JSON document: every value a choice takes, every range and unit,
      what each input reads and what each task writes.

  chromosomix <task> <file.cool|file.mcool|file.hic|file.pairs.gz> [...]
      Run one task over one or more files. Each file's outputs are named after
      it, up to its first dot: sample.coverage.coverage-total.tsv. Two files
      that would share a name keep more of theirs — HCT116.rep1 and
      HCT116.rep2, then dirA_sample and dirB_sample — and nothing one command
      writes is written over by it.

      --out <dir>          where to write (default: .)
      --window <chr:a-b>   a window rather than the whole file, 1-based and
                           inclusive as the app, IGV and samtools write it,
                           digits grouped or not: chrIV:1,000,001-1,400,000
      --no-balance         read the raw counts. A map is read balanced wherever
                           the file carries weights, as the app reads it
      --features <file>    a feature or loop file a task needs, read as the app
                           reads it: BED, narrowPeak, GTF, genePred, VCF,
                           cytoBand, barChart, junctions, bedpe, interact,
                           longrange
      --sequence <ref.fa>  a reference, for a task that reads residues (motif,
                           restriction, and pairsqc's digest) or phases by GC
                           content (compartments). Gzipped or not; read by
                           range where its .fai is beside it, or a .2bit
      --pairs <file>       a BEDPE, interact or longrange, for an off-diagonal
                           pileup. Note this is a *feature* table and not a
                           contact list — a .pairs file to bin is a positional
                           argument, and takes --bin-size below. pairsqc's own
                           --pairs is the exception: the contact list a matrix
                           was made from, read for its records
      --against <file>     another contact map, for a task that compares two
                           (hicrep). Repeat it for a third
      --value <column>     the score column to read, for a file that carries
                           more than the count (default: count)
      --origin <name:pos>  where a sequence's replication origin is, 1-based,
                           as the Origin and terminus task reports it; repeat
                           or separate with commas
      --circular <name>    a sequence to read as a circle (a plasmid); repeat
                           or separate with commas
      --cell <name>        a cell of an .scool to sum into the map; repeat or
                           separate with commas. Default: every cell
      --contacts <n>       draw the map to n contacts before the task reads it:
                           below the file's own total, an exact subsample
                           (cooltools random-sample --count n --exact); above
                           it, an oversample through Boost-HiC. Takes 10M,
                           23,000,000 or 2.5e7; --against maps are drawn to it
                           too. The same seed as the app, so the same pixels
      --coarsen <bp>       read the map at this bin size, a whole number of the
                           file's own bins summed along each sequence — what
                           the app does at a resolution you added (3 kb*).
                           Counts sum exactly; a bin's weight is the harmonic
                           mean of its bins' weights. --against maps are summed
                           to it too
      --bin-size <bp>      required for a .pairs input, which states no
                           resolution of its own; ignored for every other format
      --rungs <n>          how many ladder resolutions to build from it
                           (1-2-5 series from the base). Default 1
      --threads <n>        threads for a task that shares its work —
                           pastis-NB's MDS start and likelihood in
                           reconstruct3d. Default 1, so a time is one core's;
                           the results are the same bits on any number
      --quiet              no progress on stderr
      --<param> <value>    any parameter the task takes; see `tasks`. A choice
                           is one of its values and a number is a number: any
                           other is refused before a file is opened, with the
                           values it takes. A locus (fourc's --anchor, the 3D
                           tasks' --region and --locus) is read as --window is.
                           A task that reads tracks (metaplot, trackcorr, frip,
                           groupsignal) takes them as --tracks <file.bw>,
                           repeated or comma-separated: a bigWig, a bedGraph, a
                           wig, or a FASTA read as GC content
      --<switch>           a parameter that is on or off, which takes no value
                           after it: --derivative turns one on, and
                           --derivative=false or --no-derivative turns it off

  chromosomix <task> --tracks <file.bw> --features <file.bed> [...]
      A task that reads tracks and no matrix (metaplot, trackcorr, frip,
      groupsignal, overlap, motif, composition, oriter), run with no contact map
      at all — what a 1D browser session runs. The assembly is what the tracks
      and references declare.

  chromosomix circular <file.mcool::/resolutions/<bp>> [...]
      Which sequences join their own ends: the junction test the app runs when
      a map is first opened, as a table on stdout — sequence, length, score,
      and yes or no where it could be decided: a sequence needs 50 bins at the
      resolution read. The names to hand every other run as --circular.

  chromosomix boost <file.mcool::/resolutions/<bp>> [...]
      The boosted map of each sequence: what an oversample (--contacts above
      the file's own total) draws the sequence's new contacts from — the bins
      the outlier filter keeps, and the boosted map over them in SCN units.
      One square TSV per sequence, rows and columns named by each kept bin's
      start, into --out.
      --sequences <a,b>    the sequences to boost. Default: every one; a
                           sequence past 3,000 bins is refused by name
      --alpha <a>          the exponent of the distances, 1/SCN^a.
                           Default: 0.2

  chromosomix stats <file.pairs.gz> [...]
      What `pairtools stats` writes for a .pairs file, counted by the pass the
      app's import makes: records mapped on both sides, on one and on neither,
      duplicates, cis and trans and cis past 1 to 40 kb, every pair type, the
      four orientations by separation and where they converge, and the
      library's size. One <name>.stats per file into --out, in pairtools' own
      format, which MultiQC and `pairtools stats --merge` read; to stdout
      without --out.

  chromosomix replay <workspace.chromosomix.json> --over <file> [...]
      Re-run every analysis recorded in a saved workspace, with the parameters
      it recorded, over the files named by --over and after the workspace —
      --over data/*.hic as a shell expands it. The workspace is what the
      app's Save button produces: every open tab in one file. A locus it
      recorded is read as --window is, as the app's form showed it; a value
      it recorded that this build cannot run is refused, before any file is.
      --tab <n>            which tab to replay, 1-based. Default: the one that
                           was in front when the workspace was saved.
      --track <file.bw>    the file behind a track the workspace recorded by
                           the app's own id. Repeat it per track
      --against <file>     the other maps a recorded hicrep compared against

  chromosomix --version
      Which build this is: chromosomix, its version and the commit it was
      built from, on the first line, as every file it writes opens with them.
      Then what the version does not fix — the Node it runs on, and the
      h5wasm and @gmod/bbi installed beside it, which read every map and track.

A file may be an http or https address — a map, or what --against,
--sequence, --tracks, --features or --pairs names. A map, a bigWig, a .2bit
and an indexed FASTA are read by range, as the app reads them, and nothing of
them is written to disk. What is read whole — a feature file, a HiC-Pro
matrix, a workspace, or any file whose host serves no range — is fetched into
$TMPDIR, with its progress on stderr, and removed when the command ends.
```
