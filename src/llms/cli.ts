/**
 * `llms/cli.md`: the command line, for a model that will write commands for it.
 *
 * The usage the command prints for `--help` is carried whole (`cli/main.ts`'s
 * `USAGE`), so the page and the command cannot disagree about a flag; what is
 * written here is what the usage does not say — how to install it, how to find
 * a task's parameters, what comes out and what the exit status means — and the
 * examples, which are the README's.
 */

import { USAGE } from '../cli/main'
import { block, page, SITE } from './markdown'

/**
 * The usage, less the one dev feature it names (§29.5): the command runs every
 * task and lists every container, being a developer's tool, but this page is
 * static text, which names nothing a reader without the switch cannot open.
 */
export function publicUsage(): string {
  return USAGE.replace('|file.metacool', '')
}

export function cliPage(): string {
  return page([
    '# chromosomix command line',
    '> `chromosomix` runs the analyses of the app’s Analysis panel from a shell — insulation, compartments, ' +
      'loops, APA, P(s), virtual 4C, peaks, metaplots and two dozen more — with the same parameters and the ' +
      'same results as a run in the browser, for scripts and pipelines. It reads `.cool`, `.mcool`, `.hic`, ' +
      '`.scool`, HiC-Pro and `.pairs` maps, and bigWig, BED-like and FASTA files, from disk or by address, ' +
      'and writes TSV, BED, bedGraph and bigWig.',
    '## Install',
    block(
      [
        'node --version                 # 22.12 or later',
        'npm install -g chromosomix     # the latest release',
        'npx chromosomix@<version> …    # a pinned release, with nothing installed',
        'chromosomix --version          # the build on its first line, then Node, h5wasm and @gmod/bbi',
      ].join('\n'),
      'sh',
    ),
    'A pipeline or a methods section should pin a version. From a clone: `npm install`, then ' +
      '`npm run build:cli && npm link`.',
    '## Finding a task and its parameters',
    block(
      [
        'chromosomix tasks          # every task, its flags and their defaults',
        'chromosomix tasks --json   # the same, with every value a choice takes, every range and unit',
        'chromosomix --help         # the usage below',
      ].join('\n'),
      'sh',
    ),
    `Every task, with every parameter, is also on [the task page](${SITE}llms/tasks.md). The shape of a command:`,
    block('chromosomix <task> <map> [<map> …] [--<parameter> <value> …] --out <dir>', 'sh'),
    [
      '- **One task, one or more maps.** Each map is run on its own and its outputs are named after it, up to ' +
        'its first dot: `sample.coverage.coverage-total.tsv`. Two that would share a name keep more of theirs, ' +
        'and nothing one command writes is written over by it.',
      '- **A map** is a path or an `http(s)` address. An `.mcool` names one resolution — ' +
        '`sample.mcool::/resolutions/10000` — and one named bare is refused with the list of the resolutions ' +
        'it has. A `.pairs` is binned first and needs `--bin-size <bp>`.',
      '- **Balanced by default.** A map is read balanced wherever the file carries weights, as the app reads ' +
        'it; `--no-balance` reads the raw counts.',
      '- **A locus is the display form**: 1-based and inclusive, digits grouped or not — ' +
        '`--window IV:1,000,001-1,400,000` — as the app, IGV and samtools write one.',
      '- **Remote files are read by range** where they can be: one rung of a 7 GB `.mcool` costs that ' +
        'rung. What has to be read whole — a feature file, a workspace, a host that serves no ranges — is ' +
        'fetched into `$TMPDIR` and removed when the command ends.',
      '- **Every output records its provenance**: each TSV opens with `#` lines naming the build, the file ' +
        'and every parameter, so `head` says how a number was made.',
    ].join('\n'),
    '## Exit status',
    [
      '- `0`: every file ran.',
      '- `1`: at least one file failed; the others still ran, and stderr says which and why.',
      '- `2`: the command was refused before any file was opened — an unknown task or flag, a choice that is ' +
        'none of its values, a number that is not one, a missing input. The sentence on stderr names what the ' +
        'flag takes. Fix the command and run it again.',
    ].join('\n'),
    'Progress and notes go to stderr; `--quiet` silences progress.',
    '## Examples',
    block(
      [
        '# Insulation and its boundaries, on one resolution of an .mcool',
        'chromosomix insulation sample.mcool::/resolutions/10000 --window 10 --out results/',
        '',
        '# P(s) and its slope; compartments phased by GC content',
        'chromosomix expected sample.cool --out results/',
        'chromosomix compartments sample.cool --sequence ref.fa.gz --phaseSequence ref.fa.gz --out results/',
        '',
        '# Loops and borders by pattern, then a pileup at a loop set',
        'chromosomix chromosight sample.cool --pattern borders --out results/',
        'chromosomix apa sample.cool --pairs loops.bedpe --norm chromosight --out results/',
        '',
        '# A 4C profile from an anchor, written as the app writes a locus',
        'chromosomix fourc sample.cool --anchor IV:1,200,001-1,210,000 --out results/',
        '',
        '# Tasks over tracks, with or without a map',
        'chromosomix metaplot --tracks ATAC.bw --features peaks.narrowPeak --flank 2000 --out results/',
        'chromosomix frip sample.cool --tracks ATAC.bw,MNase.bw --features peaks.narrowPeak',
        'chromosomix peaks --signal ChIP.bw --out results/',
        'chromosomix overlap sample.cool --features peaks.bed --a peaks.bed --features tads.bed --b tads.bed',
        '',
        '# Two libraries drawn to one depth before they are compared',
        'chromosomix insulation rep1.cool rep2.cool --contacts 10M --out results/',
        '',
        '# A map read by range from where it is published',
        'chromosomix insulation https://example.org/sample.mcool::/resolutions/10000 --out results/',
        '',
        '# A 3D model from the map, as a bed3d and a PDB',
        'chromosomix reconstruct3d ecoli.mcool::/resolutions/20000 --out results/',
        '',
        '# What `pairtools stats` writes, for MultiQC',
        'chromosomix stats sample.pairs.gz --out qc/',
      ].join('\n'),
      'sh',
    ),
    '## From the app to a script',
    'Every run in the app is written to its console as the `chromosomix` command that repeats it, so a ' +
      'reader can tune a run on screen and copy the line. A saved workspace runs again over other files, ' +
      'every analysis it recorded with the parameters it recorded:',
    block('chromosomix replay workspace.chromosomix.json --over data/*.hic --out results/', 'sh'),
    '## The usage, as `chromosomix --help` prints it',
    block(publicUsage()),
  ])
}
