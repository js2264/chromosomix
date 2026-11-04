---
title: "In a pipeline"
description: "Run chromosomix tasks from Snakemake, Nextflow or CI with a pinned release, and collect their quality control with MultiQC."
---

A `chromosomix` command runs over many maps, names its outputs in advance and reports failure in its exit status.

## Pin the release

Install the release you checked your results with:

```sh
npm install -g chromosomix@<version>
```

or call it through `npx` in each step (Node.js 22.12 or later):

```sh
npx chromosomix@<version> insulation sample.cool --out results/
```

Keep the four lines of `chromosomix --version` in the log ([Installing the command line](/cli/install/)).

## Know the file names before the run

Outputs are named by a fixed rule ([Running a task](/cli/running/)):

```text
<out>/<stem>.<task>.<output>.<format>
```

- The stem is the map's file name up to its first dot, plus the resolution you named: `maps/wt.mcool::/resolutions/10000` writes `wt_10000.…`. Name samples without dots: `HCT116.rep1.mcool` would be `HCT116_10000`.
- The `<output>` is fixed by the task and its parameters: insulation's score at a 10-bin window is `insulation-w10`. One run on one map, without `--quiet`, prints them all.
- Maps that would share a stem keep more of their names (`HCT116.rep1`, `HCT116.rep2`).
- Some results, such as insulation's boundaries and domains, are written only when there is something in them: declare the files always written.

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

`--quiet` keeps progress out of the log, but not notes and failures.

## A Nextflow process

The [Map report](/analyses/mapreport/) of every map, then one MultiQC report over them:

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

The map report reads P(s), coverage and cis and trans at the resolution you name, and counts the library and its resolutions from the file's finest one.

## MultiQC

### The map report's sections

A map report writes `<stem>.mapreport.report.html` and four files MultiQC collects by their `_mqc` suffix, with the map's stem as the sample name:

| File | In MultiQC |
| --- | --- |
| `<stem>.mapreport.summary_mqc.tsv` | columns of the General Statistics table: the contacts; the cis, trans and cis ≥ 10 kb shares; the finest bin; the median contacts per finest bin; and the count 80 % of finest bins reach |
| `<stem>.mapreport.resolutions_mqc.tsv` | *Resolutions, coarsest to finest*: the ladder as a table, a row per bin size |
| `<stem>.mapreport.resolution_mqc.json` | *Contacts per bin, by bin size*: the count at least 80 % of bins hold, against the bin size |
| `<stem>.mapreport.ps_mqc.json` | *Contact probability P(s)* |

The sections give numbers, not verdicts: nothing is coloured pass or fail.

### What `pairtools stats` writes, from a `.pairs`

`chromosomix stats` counts a contact list as `pairtools stats` does, in pairtools' own format, which MultiQC and `pairtools stats --merge` read:

```sh
chromosomix stats sample.pairs.gz --out qc/    # writes qc/sample.stats
chromosomix stats sample.pairs.gz > sample.stats
```

These are the counts of the app's **Pairs statistics** card, whose **save .stats** button writes the same file. It is the one file the command writes without a `#` header.

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

```sh
chromosomix mapreport maps/*.cool --out qc/
multiqc qc/
```

An `.mcool` needs its resolution after each name, which the shell can add:

```sh
chromosomix insulation $(printf '%s::/resolutions/10000 ' maps/*.mcool) --out results/
```

Maps run one after another; one that fails does not stop the rest. Maps at addresses are read by range, or downloaded one at a time.

## Exit statuses in CI

Any status but `0` fails a Snakemake, Nextflow or CI step:

- `1`: at least one map failed, and the others wrote their files. The `failed:` lines on stderr say why.
- `2`: the command was refused before any file was opened — an unknown task or flag, a value a parameter cannot take, a missing input, a file every run needs that could not be had — and stderr says why.
