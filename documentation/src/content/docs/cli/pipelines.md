---
title: "In a pipeline"
description: "Run chromosomix tasks from Snakemake, Nextflow or CI with a pinned release, and collect their quality control with MultiQC."
---

The command line is made for batches: a task runs over many maps in one command, its outputs are named in advance, every table says how it was made, and the exit status says whether anything failed. This page is how to put it in a workflow.

## Pin the release

A pipeline should run the release you checked your results with. Either install it where the pipeline runs:

```sh
npm install -g chromosomix@<version>
```

or call it through `npx` in each step, which runs that release without installing anything; the step needs Node.js 22.12 or later:

```sh
npx chromosomix@<version> insulation sample.cool --out results/
```

Keep `chromosomix --version` in the pipeline's log. Its first line is the release and the commit; the lines after it are the Node.js and the two libraries that read every map and track, which npm settles at install time ([Installing the command line](/cli/install/)). Every table a run writes opens with the release too, as `# chromosomix <version> cli`.

## Know the file names before the run

A workflow manager wants a step's outputs named before it runs, and the command names them by a fixed rule:

```text
<out>/<stem>.<task>.<output>.<format>
```

The stem is the map's file name up to its first dot, with the resolution after it where you named one: `maps/wt.mcool::/resolutions/10000` writes `wt_10000.…`. So name your samples without dots, or the stem stops at the first one: `HCT116.rep1.mcool` would be `HCT116_10000`. The `<output>` is fixed by the task and its parameters — insulation's score at a 10-bin window is `insulation-w10` — and a run that is not `--quiet` says `wrote` and the path for each file, so one run on one map lists them all. [Running a task](/cli/running/) has the whole rule.

A few results are written only when there is something in them: insulation's boundaries and domains, for instance, only where a boundary was called. Declare the files that are always written, such as a score's TSV, bedGraph and bigWig.

## A Snakemake rule

Insulation at 10 kb on each sample's `.mcool`, its score as a bigWig:

```python
CHROMOSOMIX = "0.19.0"  # the release your results were checked with
SAMPLES = ["wt", "ko"]

rule all:
    input:
        expand("results/{sample}_10000.insulation.insulation-w10.bw", sample=SAMPLES),

rule insulation:
    input:
        "maps/{sample}.mcool",
    output:
        tsv="results/{sample}_10000.insulation.insulation-w10.tsv",
        bedgraph="results/{sample}_10000.insulation.insulation-w10.bedGraph",
        bigwig="results/{sample}_10000.insulation.insulation-w10.bw",
    params:
        release=CHROMOSOMIX,
    log:
        "logs/insulation/{sample}.log",
    shell:
        "npx chromosomix@{params.release} insulation {input}::/resolutions/10000 "
        "--window 10 --out results/ --quiet 2> {log}"
```

`--quiet` keeps the progress out of the log; the task's notes and any failure still go to it.

## A Nextflow process

The [Map report](/analyses/mapreport/) of every map, then one MultiQC report over all of them:

```groovy
params.maps = 'maps/*.mcool'
params.resolution = 10000
params.chromosomix = '0.19.0'

process MAPREPORT {
    tag "${map.simpleName}"

    input:
    path map

    output:
    path '*.mapreport.report.html', emit: report
    path '*_mqc.*', emit: multiqc

    script:
    """
    npx chromosomix@${params.chromosomix} mapreport ${map}::/resolutions/${params.resolution} --out . --quiet
    """
}

process MULTIQC {
    publishDir 'results', mode: 'copy'

    input:
    path sections

    output:
    path 'multiqc_report.html'

    script:
    """
    multiqc .
    """
}

workflow {
    MAPREPORT(Channel.fromPath(params.maps))
    MULTIQC(MAPREPORT.out.multiqc.collect())
}
```

The map report reads the resolution you name for P(s), coverage and cis and trans, and counts the library and its resolutions from the file's finest one.

## MultiQC

### The map report's sections

Beside its own one-page HTML report, `<stem>.mapreport.report.html`, a map report run from the command line writes four files that MultiQC collects by their `_mqc` suffix, each under the map's stem as its sample name:

| File | In MultiQC |
| --- | --- |
| `<stem>.mapreport.summary_mqc.tsv` | columns of the General Statistics table: the contacts; the cis, trans and cis ≥ 10 kb shares; the finest bin; the median contacts per finest bin; and the count 80 % of finest bins reach |
| `<stem>.mapreport.resolutions_mqc.tsv` | *Resolutions, coarsest to finest*: the ladder as a table, a row per bin size |
| `<stem>.mapreport.resolution_mqc.json` | *Contacts per bin, by bin size*: the count at least 80 % of bins hold, against the bin size |
| `<stem>.mapreport.ps_mqc.json` | *Contact probability P(s)* |

Run over a hundred libraries, that is one MultiQC report with a row each. The sections give numbers and no verdict: nothing is coloured as a pass or a fail, and where to cut is yours to decide.

### What `pairtools stats` writes, from a `.pairs`

`chromosomix stats` counts a contact list as `pairtools stats` does, by the same pass the app's import makes, and writes it in pairtools' own format — which MultiQC and `pairtools stats --merge` read as theirs:

```sh
chromosomix stats sample.pairs.gz --out qc/    # writes qc/sample.stats
chromosomix stats sample.pairs.gz > sample.stats
```

Without `--out` it writes to stdout. It counts the records mapped on both sides, on one and on neither; the duplicates; cis and trans, and cis past 1 to 40 kb; every pair type; the four orientations by separation and where they converge; and the library's size. These are the counts the app shows in the **Pairs statistics** card when it imports the same file, whose **save .stats** button writes them in the same format. It is the one file the command writes without `#` lines over it, since pairtools' reader takes nothing else; stderr says where it came from, with a line of the main shares.

A Snakemake rule for it:

```python
rule pairs_stats:
    input:
        "pairs/{sample}.pairs.gz",
    output:
        "qc/{sample}.stats",
    params:
        release=CHROMOSOMIX,
    shell:
        "npx chromosomix@{params.release} stats {input} > {output}"
```

## Many maps in one command

One command takes as many maps as you give it, and runs each on its own:

```sh
chromosomix mapreport maps/*.cool --out qc/
multiqc qc/
```

An `.mcool` needs its resolution after each name, which the shell can add:

```sh
chromosomix insulation $(printf '%s::/resolutions/10000 ' maps/*.mcool) --out results/
```

The maps run one after another, and a map that fails does not stop the rest. Two maps that would share a stem keep more of their names (`HCT116.rep1`, `HCT116.rep2`), and nothing one command writes is written over by it. A batch over addresses reads each map by range, or holds one downloaded copy at a time.

## Exit statuses in CI

| Status | Meaning | What to do |
| --- | --- | --- |
| `0` | every map ran | — |
| `1` | at least one map failed; the others ran and wrote their files | read the `failed:` lines on stderr, which say why |
| `2` | the command was refused before any file was opened — an unknown task or flag, a value a parameter cannot take, a missing input, or a file every run needs that could not be had | fix the command; the sentence on stderr names what the flag takes |

Any status but `0` fails a step in Snakemake, Nextflow or a CI job. A mistyped flag costs a second, not an hour: it is refused with status 2 before the first map is read.
