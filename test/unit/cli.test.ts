/**
 * The command-line runner, end to end.
 *
 * Driven through `main` with a real file on disk rather than through the pieces,
 * because every one of the interesting failures is at a seam: a parameter that
 * arrives as the string `"false"`, a task id that no longer exists, a session
 * whose recorded parameters are silently replaced by the defaults. None of those
 * is visible from a unit test of the parts, and all of them produce a batch that
 * runs to completion and is wrong.
 *
 * The fixture is a `.hic` this suite writes, which also makes the point that the
 * CLI reads whatever the app reads: nothing here mentions the container.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { cliCommandFor } from '@/analysis/cliCommand'
import { taskById } from '@/analysis/registry'
import type { AnalysisContext, AnalysisTask } from '@/analysis/types'
import { writeBigWig } from '@/analysis/write/bigwig'
import { main, readFeatureText, readPairText, recordedTasks, stemOf } from '@/cli/main'
import { typedLocusToRegion } from '@/genome/assembly'
import { writeHic, type HicRecord } from '../support/hicWriter'

let directory = ''
let sample = ''
let out = ''
const written: string[] = []
const errors: string[] = []

function records(nx: number, ny: number, intra: boolean, seed: number, boundary = -1): HicRecord[] {
  const list: HicRecord[] = []
  for (let x = 0; x < nx; x++) {
    for (let y = intra ? x : 0; y < ny; y++) {
      if ((x * 7 + y * 3 + seed) % 5 !== 0) continue
      // A boundary bin, where one is asked for, barely touches anything: its own
      // contacts and the contact across it are one read each.
      const across =
        intra && ((x < boundary && y > boundary) || x === boundary || y === boundary)
      list.push({ x, y, value: across ? 1 : Math.max(1, Math.round(100 / (1 + Math.abs(x - y)))) })
    }
  }
  return list
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'metacooler-cli-'))
  sample = join(directory, 'sample.hic')
  out = join(directory, 'out')
  const fixture = await writeHic({
    version: 9,
    chroms: [
      { name: 'chrI', length: 120_000 },
      { name: 'chrII', length: 60_000 },
    ],
    resolutions: [1000],
    records: {
      '1_1': records(120, 120, true, 1),
      '2_2': records(60, 60, true, 2),
      '1_2': records(120, 60, false, 3),
    },
    blockBinCount: 32,
  })
  await writeFile(sample, fixture.bytes)
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk))
    return true
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  if (directory !== '') await rm(directory, { recursive: true, force: true })
})

const said = (): string => written.join('')
const complained = (): string => errors.join('')

function reset(): void {
  written.length = 0
  errors.length = 0
}

describe('the surface', () => {
  it('prints usage with no arguments, and exits cleanly', async () => {
    reset()
    expect(await main([])).toBe(0)
    expect(said()).toMatch(/metacooler-run/)
    expect(said()).toMatch(/replay/)
  })

  it('lists every task with its parameters and defaults', async () => {
    reset()
    expect(await main(['tasks'])).toBe(0)
    const text = said()
    expect(text).toMatch(/^expected$/m)
    expect(text).toMatch(/--factor \(default 1\.1\)/)
    expect(text).toMatch(/^coverage$/m)
  })

  it('refuses a task it does not have, and points at the list', async () => {
    reset()
    expect(await main(['nonesuch', 'x.cool'])).toBe(2)
    expect(complained()).toMatch(/Unknown task "nonesuch"/)
    expect(complained()).toMatch(/tasks/)
  })

  it('refuses a task with no file', async () => {
    reset()
    expect(await main(['expected'])).toBe(2)
    expect(complained()).toMatch(/needs at least one file/)
  })

  it('offers the junction test beside the tasks', async () => {
    reset()
    expect(await main([])).toBe(0)
    expect(said()).toMatch(/metacooler-run circular/)
  })
})

describe('the junction test', () => {
  /** Rows of the table `circular` printed, without its `#` lines. */
  const table = (): string[][] =>
    said()
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split('\t'))

  it('reads the sequences of a map whose ends are a chromosome apart as lines', async () => {
    reset()
    expect(await main(['circular', sample, '--quiet'])).toBe(0)
    expect(said()).toMatch(/^# framing: 1000 bp$/m)
    const rows = table()
    expect(rows[0]).toEqual(['sequence', 'length', 'score', 'circular'])
    expect(rows.slice(1).map((row) => [row[0], row[1], row[3]])).toEqual([
      ['chrI', '120000', 'no'],
      ['chrII', '60000', 'no'],
    ])
  })

  it('reads a sequence whose ends are neighbours as a circle', async () => {
    // Every cell present, and each a function of the separation round the ring.
    const n = 60
    const ring: HicRecord[] = []
    for (let x = 0; x < n; x++) {
      for (let y = x; y < n; y++) {
        const d = Math.min(y - x, n - (y - x))
        ring.push({ x, y, value: Math.round(1000 / (1 + d)) })
      }
    }
    const fixture = await writeHic({
      version: 9,
      chroms: [{ name: 'ring', length: n * 1000 }],
      resolutions: [1000],
      records: { '1_1': ring },
      blockBinCount: 32,
    })
    const file = join(directory, 'ring.hic')
    await writeFile(file, fixture.bytes)
    reset()
    expect(await main(['circular', file, '--quiet'])).toBe(0)
    const [, row] = table()
    expect(row[0]).toBe('ring')
    expect(Number(row[2])).toBeCloseTo(1, 1)
    expect(row[3]).toBe('yes')
  })

  it('needs a file', async () => {
    reset()
    expect(await main(['circular'])).toBe(2)
    expect(complained()).toMatch(/circular needs at least one file/)
  })
})

describe('running a task', () => {
  it('writes a TSV per output, with the provenance the drawer writes', async () => {
    reset()
    expect(await main(['expected', sample, '--out', out, '--quiet'])).toBe(0)
    const files = await readdir(out)
    expect(files).toContain('sample.expected.ps.tsv')
    const text = await readFile(join(out, 'sample.expected.ps.tsv'), 'utf8')
    // The same `#` header the browser's export carries — same writer, so a file
    // made in a batch and a file made by clicking are comparable without anybody
    // wondering whether the difference is the tool.
    expect(text).toMatch(/^# metacooler metacooler-run/m)
    expect(text).toMatch(/^# task: expected/m)
    expect(text).toMatch(/^# framing: whole file at 1000 bp/m)
    expect(text).toMatch(/^# param factor: 1\.1$/m)
  })

  it('writes bigWig and bedGraph for a profile, as §18.7 promises', async () => {
    reset()
    expect(await main(['coverage', sample, '--out', out, '--quiet'])).toBe(0)
    const files = await readdir(out)
    expect(files).toContain('sample.coverage.coverage-total.tsv')
    expect(files).toContain('sample.coverage.coverage-total.bedGraph')
    expect(files).toContain('sample.coverage.coverage-total.bw')
    // A real bigWig, not an empty file: the magic is the same one
    // `analysis/write/bigwig.ts` round-trips through `@gmod/bbi`.
    const bytes = await readFile(join(out, 'sample.coverage.coverage-total.bw'))
    expect(bytes.readUInt32LE(0)).toBe(0x888ffc26)
  })

  it('passes a parameter through, typed the way the descriptor says', async () => {
    reset()
    expect(
      await main(['expected', sample, '--out', out, '--quiet', '--factor', '1.5', '--derivative', 'false']),
    ).toBe(0)
    const text = await readFile(join(out, 'sample.expected.ps.tsv'), 'utf8')
    // A number, not the string "1.5"; a boolean, not the string "false" — which
    // a runner would read as truthy and act on.
    expect(text).toMatch(/^# param factor: 1\.5$/m)
    expect(text).toMatch(/^# param derivative: false$/m)
  })

  it('refuses a parameter the task does not have, rather than ignoring it', async () => {
    reset()
    // The failure this prevents: a typo in a batch script that runs for an hour
    // and quietly uses the default.
    expect(await main(['expected', sample, '--out', out, '--quiet', '--windwo', '10'])).toBe(2)
    expect(complained()).toMatch(/has no parameter --windwo/)
  })

  it('draws the map to --contacts before the task reads it, and says so in the framing', async () => {
    reset()
    expect(await main(['expected', sample, '--out', out, '--quiet', '--contacts', '5k'])).toBe(0)
    const sub = await readFile(join(out, 'sample.expected.ps.tsv'), 'utf8')
    expect(sub).toMatch(/^# framing: whole file at 1000 bp.*, subsampled to 5,000 contacts \(of [\d,]+\)$/m)
    reset()
    expect(await main(['expected', sample, '--out', out, '--quiet', '--contacts', '2,000,000'])).toBe(0)
    const over = await readFile(join(out, 'sample.expected.ps.tsv'), 'utf8')
    expect(over).toMatch(/, oversampled to 2,000,000 contacts \(of [\d,]+, Boost-HiC\)$/m)
  })

  it('says on stderr what the map was drawn to, unless told to be quiet', async () => {
    reset()
    expect(await main(['expected', sample, '--out', out, '--contacts', '5k'])).toBe(0)
    expect(complained()).toMatch(/^ {2}subsampled to 5,000 contacts \(of [\d,]+\)$/m)
    reset()
    expect(await main(['expected', sample, '--out', out, '--quiet', '--contacts', '5k'])).toBe(0)
    expect(complained()).not.toMatch(/subsampled/)
  })

  it('refuses a --contacts that is not a number of contacts', async () => {
    reset()
    expect(await main(['expected', sample, '--out', out, '--quiet', '--contacts', 'lots'])).not.toBe(0)
    expect(complained()).toMatch(/--contacts: “lots” is not a number of contacts/)
  })

  it('narrows to a window, and says so in the framing', async () => {
    reset()
    expect(
      await main(['expected', sample, '--out', out, '--quiet', '--window', 'chrI:1-50000']),
    ).toBe(0)
    const text = await readFile(join(out, 'sample.expected.ps.tsv'), 'utf8')
    // In the display form of §26.1, as the app's own framing line writes it.
    expect(text).toMatch(/^# framing: chrI:1-50,000 at 1000 bp/m)
  })

  it('binds --sequences as a list, not as a string the runners ignore', async () => {
    reset()
    // The runners read this key with `Array.isArray` and fall back to *every
    // sequence* when it is anything else. It arrived as a plain string, so
    // `--sequences chrII` scanned both and reported a number from the wrong
    // one — a silent widening, which a batch script cannot see. The fixture has
    // two sequences and only one of them is asked for.
    expect(
      await main(['chromosight', sample, '--out', out, '--quiet', '--sequences', 'chrII']),
    ).toBe(0)
    // One sequence scanned, not two. The fixture has chrI and chrII, and the
    // note counts what the run actually looked at.
    expect(complained()).toMatch(/on 1 sequence\b/)
    expect(complained()).not.toMatch(/on 2 sequences/)
  })

  it('writes a called interval set as BED beside its TSV', async () => {
    reset()
    // The drawer has carried a BED button beside every called interval set
    // since there were any; the shell wrote only the TSV, so a boundary set
    // called in a batch came out as a table with a provenance header — readable,
    // and not what bedtools takes.
    //
    // On a map with a boundary to call. The sample's cells repeat every five
    // bins, so every diamond holds the same ones and the track is flat — and
    // cooltools calls no minimum on a flat track.
    const bounded = join(directory, 'bounded.hic')
    const fixture = await writeHic({
      version: 9,
      chroms: [
        { name: 'chrI', length: 120_000 },
        { name: 'chrII', length: 60_000 },
      ],
      resolutions: [1000],
      records: {
        '1_1': records(120, 120, true, 1, 60),
        '2_2': records(60, 60, true, 2, 30),
        '1_2': records(120, 60, false, 3),
      },
      blockBinCount: 32,
    })
    await writeFile(bounded, fixture.bytes)
    expect(
      await main(['insulation', bounded, '--out', out, '--quiet', '--prominence', '0']),
    ).toBe(0)
    const bed = await readFile(join(out, 'bounded.insulation.insulation-boundaries.bed'), 'utf8')
    const rows = bed.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const [contig, start, end] = row.split('\t')
      expect(contig).toMatch(/^chr/)
      expect(Number(end)).toBeGreaterThan(Number(start))
    }
  })

  it('writes a reconstructed model as a bed3d, coordinates and all', async () => {
    reset()
    // §25.7: *a model leaves as a bed3d*, from the button, from the drawer's
    // result, and from the export road a computed row shares with called
    // intervals — which is this one. A model is an interval set whose rows carry
    // three coordinates each, and BED6 has nowhere to put them: the shell wrote
    // `chrom start end region_1 0 .` per bin, which is the assembly back with the
    // one thing the run computed dropped, beside a TSV whose every row was blank.
    expect(
      await main(['reconstruct3d', sample, '--out', out, '--quiet', '--iterations', '5']),
    ).toBe(0)
    const files = await readdir(out)
    expect(files).toContain('sample.reconstruct3d.reconstructed-model.bed3d')
    // And not as a BED beside it: one file per output per format, and a model's
    // format is the one that holds it.
    expect(files).not.toContain('sample.reconstruct3d.reconstructed-model.bed')
    const text = await readFile(
      join(out, 'sample.reconstruct3d.reconstructed-model.bed3d'),
      'utf8',
    )
    expect(text).toMatch(/^# metacooler .*bed3d: chrom start end x y z/m)
    const rows = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
    expect(rows.length).toBeGreaterThan(0)
    let moved = 0
    for (const row of rows) {
      const columns = row.split('\t')
      expect(columns.length).toBe(6)
      const [contig, start, end, x, y, z] = columns
      expect(contig).toMatch(/^chr/)
      expect(Number(end)).toBeGreaterThan(Number(start))
      for (const coordinate of [x, y, z]) expect(Number.isFinite(Number(coordinate))).toBe(true)
      if (Number(x) !== 0 || Number(y) !== 0 || Number(z) !== 0) moved += 1
    }
    // A file of zeroes would satisfy every check above and hold no model.
    expect(moved).toBeGreaterThan(0)
  })

  it('reads a model it wrote back in as a structure, for the tasks that read one', async () => {
    reset()
    // The chain a bacterial figure is: model the map, then read the model as
    // tracks — radial position against the compartments. `--features` read the
    // bed3d as a BED, keeping its intervals and dropping its coordinates, so
    // Spatial tracks refused the row it had just been handed.
    const where = join(directory, 'spatial')
    expect(
      await main(['reconstruct3d', sample, '--out', where, '--quiet', '--iterations', '5']),
    ).toBe(0)
    const model = join(where, 'sample.reconstruct3d.reconstructed-model.bed3d')
    expect(
      await main(['spatialtracks', sample, '--features', model, '--structure', model, '--out', where, '--quiet']),
    ).toBe(0)
    expect(complained()).not.toMatch(/not a structure/)
    expect((await readdir(where)).some((name) => /structure-radial.*\.tsv$/.test(name))).toBe(true)
  })

  it('takes the `::` resolution its own refusal tells a reader to write', async () => {
    reset()
    // `detect.ts` refuses a multi-resolution container at its root with a
    // sentence naming the resolutions and an example ending in
    // `::/resolutions/1000`. The whole string went to `stat`, so following that
    // advice got *cannot stat …::/resolutions/1000: No such file or directory*
    // — the shell refusing its own instruction, and the only way into an
    // `.mcool` from a command line.
    expect(
      await main(['expected', `${sample}::/resolutions/1000`, '--out', out, '--quiet']),
    ).toBe(0)
    // Named `sample_1000`, not `1000`: the `::` half is a group inside the
    // container, so the output is named after the file and the resolution
    // rather than after `basename` of a group path — which is a number, and
    // made every output of every `.mcool` a file called `1000.*`.
    const text = await readFile(join(out, 'sample_1000.expected.ps.tsv'), 'utf8')
    expect(text).toMatch(/^# framing: whole file at 1000 bp/m)
  })

  it('carries on past a file it cannot read, and reports it', async () => {
    reset()
    const broken = join(directory, 'broken.cool')
    await writeFile(broken, 'not a contact map')
    const code = await main(['expected', broken, sample, '--out', out, '--quiet'])
    // One failure and one success: a batch of two hundred where the eleventh is
    // truncated should produce a hundred and ninety-nine results and a message.
    expect(code).toBe(1)
    expect(complained()).toMatch(/failed:/)
    expect(await readdir(out)).toContain('sample.expected.ps.tsv')
  })
})

/**
 * The half of the catalogue that runs in the *other* worker.
 *
 * Five tasks declare `venue: 'annotations'`, and the command used to dispatch
 * through `RUNNERS` alone — so `tasks` listed them with a flag apiece and `run`
 * died on them with *no analysis runner is registered*, after the mount and once
 * per file. Then the two that read a bigWig were refused by name, which was
 * honest and was a hole in the console exactly where a reader looks for a line
 * to paste. `cli/tracks.ts` opens the file now, and these pin that every one of
 * the five runs — over a map, and with no map at all, which is the 1D browser's
 * own case. A batch script is written from `tasks`, so the listing and the
 * dispatch disagreeing is the bug, not a cosmetic one.
 */
describe('the annotations venue', () => {
  let aBed = ''
  let bBed = ''
  let reference = ''

  beforeAll(async () => {
    aBed = join(directory, 'a.bed')
    bBed = join(directory, 'b.bed')
    reference = join(directory, 'ref.fa')
    await writeFile(aBed, 'chrI\t1000\t2000\nchrI\t5000\t6000\n')
    await writeFile(bBed, 'chrI\t1500\t2500\n')
    // Named as the map names it, so the sites land on the map's own bin grid
    // and the density half of the task has somewhere to be per (§5.9).
    await writeFile(reference, '>chrI\nACGTACGTGGTCAACGTACGT\n')
  })

  it('runs overlap, which needs two BED files and no bigWig', async () => {
    reset()
    const where = join(directory, 'overlap')
    // Both sets named twice over: `--features` loads them, and `--a`/`--b` are
    // the task's own parameters choosing between what was loaded — the same two
    // steps the form makes the reader take, and what `bindInputs` reconciles.
    const flags = ['--features', aBed, '--features', bBed, '--a', aBed, '--b', bBed]
    expect(await main(['overlap', sample, ...flags, '--out', where, '--quiet'])).toBe(0)
    const text = await readFile(join(where, 'sample.overlap.overlap.tsv'), 'utf8')
    expect(text).toMatch(/^# task: overlap/m)
    // 500 shared bases over 2,500 in either. The arithmetic is `analysis/
    // overlap.ts`'s and is goldened there; what is being pinned here is that
    // the CLI reaches it at all.
    expect(text).toMatch(/Jaccard \(bases\)\t0\.2\b/)
  })

  it('runs overlap against a genePred, read as the transcript it holds', async () => {
    // The same span as `b.bed`, as UCSC's gene tables write one: two exons
    // tiling chrI:1,501-2,500. Read as a BED it was no rows at all — its second
    // column is the sequence, where a BED's is a start — and a task run from a
    // shell over the gene models a browser draws found nothing to overlap.
    const genes = join(directory, 'genes.genePred')
    await writeFile(genes, 'NM_001\tchrI\t+\t1500\t2500\t1600\t2400\t2\t1500,2200,\t1800,2500,\n')
    reset()
    const where = join(directory, 'overlap-genepred')
    const flags = ['--features', aBed, '--features', genes, '--a', aBed, '--b', genes]
    expect(await main(['overlap', sample, ...flags, '--out', where, '--quiet'])).toBe(0)
    const text = await readFile(join(where, 'sample.overlap.overlap.tsv'), 'utf8')
    expect(text).toMatch(/Jaccard \(bases\)\t0\.2\b/)
  })

  it('runs motif against a FASTA named on the command line', async () => {
    reset()
    const where = join(directory, 'motif')
    expect(
      await main(['motif', sample, '--sequence', reference, '--pattern', 'GGTCA', '--out', where, '--quiet']),
    ).toBe(0)
    const files = await readdir(where)
    // Both halves §18.5 asks a task like this for: the sites as an interval
    // set, and the per-bin density on the open map's grid — which is what makes
    // it a per-file run rather than one answer copied sixteen times.
    expect(files).toContain('sample.motif.motif-GGTCA-both.tsv')
    expect(files).toContain('sample.motif.motif-GGTCA-both-density.bedGraph')
    expect(await readFile(join(where, 'sample.motif.motif-GGTCA-both.tsv'), 'utf8')).toMatch(
      /^# task: motif/m,
    )
    expect(complained()).toMatch(/1 site/)
  })

  /**
   * A bigWig written by this repository's own writer: one value per kilobase
   * bin over both sequences, the bin's own index on chrI and nothing on chrII,
   * so a window's average is a number the test can predict.
   */
  let bigwig = ''
  let doubled = ''
  beforeAll(async () => {
    const contigs = [
      { name: 'chrI', length: 120_000 },
      { name: 'chrII', length: 60_000 },
    ]
    const values = new Float32Array(180)
    for (let bin = 0; bin < 120; bin++) values[bin] = bin
    const twice = values.map((value) => value * 2)
    bigwig = join(directory, 'signal.bw')
    doubled = join(directory, 'twice.bw')
    for (const [path, held] of [
      [bigwig, values],
      [doubled, twice],
    ] as const) {
      const blob = await writeBigWig({ contigs, values: held, firstBin: 0, binsize: 1000 })
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()))
    }
  })

  it('runs a metaplot over a bigWig named as the parameter that loads it', async () => {
    reset()
    const where = join(directory, 'metaplot')
    // `--tracks` is both the load and the binding: the task's own parameter is
    // a path, and the shell opens what it names. No `--track` beside it.
    expect(
      await main([
        'metaplot', sample, '--tracks', bigwig, '--features', aBed, '--features', aBed,
        '--band', 'none', '--out', where, '--quiet',
      ]),
    ).toBe(0)
    const files = await readdir(where)
    expect(files).toContain('sample.metaplot.metaplot.tsv')
    expect(files).toContain('sample.metaplot.metaplot-heatmap.tsv')
    const text = await readFile(join(where, 'sample.metaplot.metaplot.tsv'), 'utf8')
    expect(text).toMatch(/^# task: metaplot/m)
    expect(complained()).not.toMatch(/failed:/)
  })

  it('runs FRiP, and reads the track twice through the same reader', async () => {
    reset()
    const where = join(directory, 'frip')
    expect(
      await main(['frip', sample, '--tracks', bigwig, '--features', aBed, '--out', where, '--quiet']),
    ).toBe(0)
    const text = await readFile(join(where, 'sample.frip.frip.tsv'), 'utf8')
    expect(text).toMatch(/^# task: frip/m)
    // One row, named after the file, with a fraction in it: the arithmetic is
    // goldened in `analysis-golden.test.ts`, and what is pinned here is that a
    // shell reaches it through the same `sample`.
    expect(text).toMatch(/signal\.bw\t0\.\d+/)
    expect(complained()).not.toMatch(/failed:/)
  })

  it('correlates two tracks, repeated or comma-separated', async () => {
    reset()
    const where = join(directory, 'trackcorr')
    expect(
      await main([
        'trackcorr', sample, '--tracks', `${bigwig},${doubled}`, '--method', 'spearman',
        '--out', where, '--quiet',
      ]),
    ).toBe(0)
    const text = await readFile(join(where, 'sample.trackcorr.trackcorr-table.tsv'), 'utf8')
    // A track and twice itself rank identically, so Spearman is exactly 1 —
    // and the axes are file names, not `a1`.
    expect(text).toMatch(/signal\.bw\ttwice\.bw\t1(\.0*)?$/m)
  })

  it('runs a track task with no contact map at all', async () => {
    reset()
    // The 1D browser's own case (§5.8): tracks and an assembly, no matrix. The
    // console records such a run with no file positional, and this is the line
    // it records — the assembly is what the bigWig declares.
    const where = join(directory, 'mapless')
    expect(
      await main(['frip', '--tracks', bigwig, '--features', aBed, '--out', where, '--quiet']),
    ).toBe(0)
    const files = await readdir(where)
    expect(files).toContain('signal.frip.frip.tsv')
    const text = await readFile(join(where, 'signal.frip.frip.tsv'), 'utf8')
    expect(text).toMatch(/^# framing: signal\.bw · loaded tracks, no contact map/m)
    expect(text).toMatch(/signal\.bw\t0\.\d+/)
  })

  it('calls peaks on a bigWig, with no map, and writes them as BED', async () => {
    // The demo's own ATAC track rather than the fixture above: the fixture is
    // written at 1 kb bins, which is a staircase of flat steps and not a
    // coverage track anybody would call peaks on.
    reset()
    const atac = new URL('../../demo/yeast/Yeast_ATAC.bw', import.meta.url).pathname
    const where = join(directory, 'peaks')
    expect(
      await main([
        'peaks', '--signal', atac, '--sequences', 'I', '--truncate', '50', '--out', where, '--quiet',
      ]),
    ).toBe(0)
    const files = await readdir(where)
    const bed = files.find((name) => name.endsWith('.bed'))
    expect(bed, files.join(', ')).toBeDefined()
    const rows = (await readFile(join(where, bed!), 'utf8'))
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
    expect(rows).toHaveLength(50)
    for (const row of rows) expect(row.split('\t')[0]).toBe('I')
    expect(files).toContain('Yeast_ATAC.peaks.peaks-sequences.tsv')
    // With one track, the run says there was no test rather than letting the
    // BED pass for an IDR-thresholded set.
    expect(errors.join('')).toMatch(/no test of significance/)
  })

  it('lays base composition out on bins of its own, with a map and without one', async () => {
    // §18.8: the map's resolution unless asked, and 10 kb with no map. Each file
    // is cut at the bin size the lanes were read at, so the second sequence
    // starts at its own first base — not at the map's 1 kb offset for it.
    reset()
    const genome = join(directory, 'genome.fa')
    await writeFile(genome, `>chrI\n${'GC'.repeat(60_000)}\n>chrII\n${'AT'.repeat(30_000)}\n`)
    const rows = async (where: string, stem: string): Promise<string[]> =>
      (await readFile(join(where, `${stem}.composition.composition-gc.bedGraph`), 'utf8'))
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('#'))

    const mapless = join(directory, 'composition-mapless')
    expect(await main(['composition', '--sequence', genome, '--out', mapless, '--quiet'])).toBe(0)
    const alone = await rows(mapless, 'genome')
    expect(alone).toHaveLength(12 + 6)
    expect(alone[0]).toBe('chrI\t0\t10000\t1')
    expect(alone[12]).toBe('chrII\t0\t10000\t0')

    const onMap = join(directory, 'composition-map')
    expect(await main(['composition', sample, '--sequence', genome, '--out', onMap, '--quiet'])).toBe(0)
    expect(await rows(onMap, 'sample')).toHaveLength(120 + 60)

    // Named after the reference, as the app names them after its entry.
    const gc = await readFile(join(onMap, 'sample.composition.composition-gc.tsv'), 'utf8')
    expect(gc).toMatch(/^# output: GC content · genome\.fa/m)

    const asked = join(directory, 'composition-asked')
    expect(
      await main(['composition', sample, '--sequence', genome, '--resolution', '20000', '--out', asked, '--quiet']),
    ).toBe(0)
    const coarse = await rows(asked, 'sample')
    expect(coarse).toHaveLength(6 + 3)
    expect(coarse[6]).toBe('chrII\t0\t20000\t0')
  })

  it('compares a track between the groups of a set, with no map', async () => {
    // §18.8's Signal by group, from a shell: the bigWig's bin index over chrI,
    // split into A (its first 60 kb) and B (the rest of chrI) by a named BED.
    reset()
    const groups = join(directory, 'ab.bed')
    await writeFile(groups, 'chrI\t0\t60000\tA\nchrI\t60000\t120000\tB\n')
    const where = join(directory, 'groupsignal')
    expect(
      await main([
        'groupsignal', '--tracks', bigwig, '--features', groups,
        '--resolution', '10000', '--outside=false', '--out', where, '--quiet',
      ]),
    ).toBe(0)
    const files = await readdir(where)
    expect(files).toContain('signal.groupsignal.groupsignal-groups.tsv')
    expect(files).toContain('signal.groupsignal.groupsignal-tests.tsv')
    const summary = await readFile(join(where, 'signal.groupsignal.groupsignal-groups.tsv'), 'utf8')
    // Six stretches of 10 kb each, their means 4.5 … 54.5 on A and 64.5 … 114.5 on B.
    expect(summary).toMatch(/signal\.bw\tA\t6\t60000\t29\.5\b/)
    expect(summary).toMatch(/signal\.bw\tB\t6\t60000\t89\.5\b/)
    const tests = await readFile(join(where, 'signal.groupsignal.groupsignal-tests.tsv'), 'utf8')
    expect(tests).toMatch(/Mann–Whitney U\tA\tB\t-60\t-1\b/)
  })

  it('still needs a file for a task that reads the matrix', async () => {
    reset()
    expect(await main(['insulation', '--out', out])).toBe(2)
    expect(complained()).toMatch(/needs at least one file/)
  })

  it('refuses a track it cannot read, before anything is opened', async () => {
    reset()
    const notATrack = join(directory, 'notes.txt')
    await writeFile(notATrack, 'hello\n')
    expect(
      await main(['metaplot', join(directory, 'absent.cool'), '--tracks', notATrack, '--features', aBed]),
    ).toBe(2)
    expect(complained()).toMatch(/notes\.txt is not a track/)
    expect(complained()).not.toMatch(/failed:/)
  })

  it('lists every task with its flags, the track tasks included', async () => {
    reset()
    expect(await main(['tasks'])).toBe(0)
    const text = said()
    expect(text).toMatch(/^metaplot$/m)
    expect(text).toMatch(/^trackcorr$/m)
    // The descriptor's own label follows the flag, and those labels are
    // lowercase now (§26.4): they are the words the form prints beside the
    // control, and the form's were Title-case while every card's were not.
    expect(text).toMatch(/--tracks {2}tracks/)
    expect(text).toMatch(/--heatmap/)
    expect(text).toMatch(/--sequence {2}reference/)
    expect(text).toMatch(/--minFraction/)
    // And the one flag a task takes that is not a parameter of its own.
    expect(text).toMatch(/^hicrep$[^]*?--against <file>/m)
    expect(text).not.toMatch(/Run it in the app/)
  })

  it('replays a recorded track task, with the files named by --track', async () => {
    reset()
    const path = join(directory, 'trackcorr.metacooler.json')
    await writeFile(
      path,
      JSON.stringify({
        kind: 'metacooler.workspace',
        version: 1,
        createdAt: '2026-08-12T00:00:00.000Z',
        active: 0,
        tabs: [
          {
            version: 1,
            createdAt: '2026-08-12T00:00:00.000Z',
            state: { uri: 'sample.hic', view: 'contigs' },
            // What the app saved: its own ids, and the tab's track list saying
            // what each one was. `--track` names the files, and each id is
            // filed against the one of that name.
            tracks: [
              { id: 'a1', card: 'linear', kind: 'track', label: 'signal', source: { kind: 'local', name: 'signal.bw' } },
              { id: 'a2', card: 'linear', kind: 'track', label: 'twice', source: { kind: 'local', name: 'twice.bw' } },
            ],
            manual: [],
            bookmarks: [],
            analysis: { trackcorr: { tracks: ['a1', 'a2'], method: 'pearson', over: 'bins', binsize: 1000 } },
          },
        ],
      }),
    )
    const where = join(directory, 'r4')
    expect(
      await main([
        'replay', path, '--over', sample, '--track', bigwig, '--track', doubled, '--out', where, '--quiet',
      ]),
    ).toBe(0)
    expect(complained()).not.toMatch(/skipped/)
    expect(complained()).not.toMatch(/failed:/)
    const text = await readFile(join(where, 'sample.trackcorr.trackcorr-table.tsv'), 'utf8')
    expect(text).toMatch(/signal\.bw\ttwice\.bw\t1(\.0*)?$/m)
  })
})

/**
 * Two runs that wrote a command and then quietly answered a smaller question.
 * Both are inputs a task of the *analysis* venue reads through a channel the
 * session fills and a shell did not: a per-bin vector, and the records behind
 * a map. Neither failed; each left a note saying the input was not there, about
 * a file the command had just read.
 */
describe('inputs the session used to fill and the shell did not', () => {
  it('phases compartments by a reference, rather than noting it could not be read', async () => {
    reset()
    // A reference the length of the map's chrI, GC-rich in the first half and
    // AT-rich in the second — so there is a GC vector to phase against.
    const reference = join(directory, 'phase.fa')
    const half = 60_000
    await writeFile(reference, `>chrI\n${'GC'.repeat(half / 2)}${'AT'.repeat(half / 2)}\n>chrII\n${'AT'.repeat(30_000)}\n`)
    const where = join(directory, 'phased')
    expect(
      await main([
        'compartments', sample, '--sequence', reference, '--phaseSequence', reference,
        // The correlation: each of this map's diagonals is one value, so its
        // observed/expected is one throughout and cooltools' matrix of it zero —
        // no component to phase (see "compartments by either method").
        '--sequences', 'chrI', '--method', 'correlation', '--out', where, '--quiet',
      ]),
    ).toBe(0)
    expect(complained()).not.toMatch(/could not be read/)
    expect(complained()).not.toMatch(/failed:/)
    const files = await readdir(where)
    expect(files).toContain('sample.compartments.compartment-e1.tsv')
  })

  it('reads the orientation curves of a .pairs named beside the map', async () => {
    reset()
    // Strand columns and nothing else out of the ordinary; the header is what
    // `pairs/format.ts` needs and no more.
    const pairs = join(directory, 'named.pairs')
    const rows: string[] = ['## pairs format v1.0', '#chromsize: chrI 120000', '#chromsize: chrII 60000',
      '#columns: readID chrom1 pos1 chrom2 pos2 strand1 strand2']
    const strands = ['+', '-']
    for (let i = 0; i < 400; i++) {
      const pos1 = 1 + ((i * 271) % 110_000)
      const pos2 = Math.min(120_000, pos1 + 500 + ((i * 37) % 20_000))
      rows.push(`r${i}\tchrI\t${pos1}\tchrI\t${pos2}\t${strands[i % 2]}\t${strands[(i >> 1) % 2]}`)
    }
    await writeFile(pairs, `${rows.join('\n')}\n`)
    const where = join(directory, 'stranded')
    expect(
      await main(['expected', sample, '--stranded', '--pairsUri', pairs, '--out', where, '--quiet']),
    ).toBe(0)
    expect(complained()).not.toMatch(/failed:/)
    expect(complained()).not.toMatch(/not an address this can fetch/)
    const files = await readdir(where)
    expect(files).toContain('sample.expected.ps-orientation.tsv')
  })
})

/**
 * Balanced wherever the file carries weights, as the app reads it (§18.9). The
 * flag that used to ask for it was forgotten often enough — the command then
 * ran on raw counts under a framing line that said *balanced* — that the
 * default is now the answer and `--no-balance` the exception. `--balance` itself
 * is refused by name rather than read as a no-op, except as coverage's own
 * parameter, which is off because raw coverage is the point of it.
 */
describe('balancing by default', () => {
  let weighted = ''
  beforeAll(async () => {
    const bins = 40
    const list: HicRecord[] = []
    for (let x = 0; x < bins; x++) {
      for (let y = x; y < bins; y++) list.push({ x, y, value: Math.max(1, Math.round(400 / (1 + y - x))) })
    }
    const fixture = await writeHic({
      version: 9,
      chroms: [{ name: 'chrI', length: bins * 1000 }],
      resolutions: [1000],
      records: { '1_1': list },
      blockBinCount: 16,
      norms: { 'SCALE/1/1000': new Float64Array(bins).fill(2) },
    })
    weighted = join(directory, 'weighted.hic')
    await writeFile(weighted, fixture.bytes)
  })

  const header = async (where: string): Promise<string> => {
    const tsv = (await readdir(where)).find((name) => name.endsWith('.tsv'))
    expect(tsv).toBeDefined()
    return readFile(join(where, tsv as string), 'utf8')
  }

  it('reads a map with weights balanced, and says so twice', async () => {
    reset()
    const where = join(directory, 'balanced-default')
    expect(await main(['hicscore', weighted, '--out', where, '--quiet'])).toBe(0)
    const text = await header(where)
    expect(text).toMatch(/^# framing: .*, balanced, count$/m)
    expect(text).toMatch(/^# param balance: true$/m)
  })

  it('reads the raw counts under --no-balance, framing and parameter alike', async () => {
    reset()
    const where = join(directory, 'balanced-off')
    expect(await main(['hicscore', weighted, '--no-balance', '--out', where, '--quiet'])).toBe(0)
    const text = await header(where)
    expect(text).not.toMatch(/^# framing: .*balanced/m)
    expect(text).toMatch(/^# param balance: false$/m)
  })

  it('refuses --balance, and says what to write instead', async () => {
    reset()
    expect(await main(['hicscore', weighted, '--balance', '--out', out, '--quiet'])).toBe(2)
    expect(complained()).toMatch(/--balance is the default now/)
    expect(complained()).toMatch(/--no-balance/)
    reset()
    expect(await main(['circular', weighted, '--balance'])).toBe(2)
  })

  it('keeps coverage’s own --balance, which is off by default', async () => {
    reset()
    const where = join(directory, 'coverage-balanced')
    expect(await main(['coverage', weighted, '--balance', '--out', where, '--quiet'])).toBe(0)
    expect(await header(where)).toMatch(/^# param balance: true$/m)
    reset()
    const raw = join(directory, 'coverage-raw')
    expect(await main(['coverage', weighted, '--out', raw, '--quiet'])).toBe(0)
    expect(await header(raw)).toMatch(/^# param balance: false$/m)
  })

  it('lists the flag that turns it off, not the one that is gone', async () => {
    reset()
    expect(await main(['tasks'])).toBe(0)
    // A task whose balancing the file decides lists the way out of it…
    const hicscore = said().split('\n\n').find((block) => block.startsWith('hicscore\n')) ?? ''
    expect(hicscore).toMatch(/--no-balance {2}read the raw counts/)
    expect(hicscore).not.toMatch(/--balance /)
    // …and coverage, whose own toggle it is, lists that.
    const coverage = said().split('\n\n').find((block) => block.startsWith('coverage\n')) ?? ''
    expect(coverage).toMatch(/--balance \(default false\)/)
  })
})

/**
 * Two ways to the eigenvectors, and one way only to choose among them (§18.8):
 * by eigenvalue. The phasing signal signs each component and is no longer asked
 * which of them to draw — so `--order`, which asked it, is a parameter the task
 * does not have, and a script still passing it is told so rather than ignored.
 */
describe('compartments by either method', () => {
  // A map with compartments to find — blocks of five bins alternating, each
  // twice as likely to touch its own kind — and a reference that is GC-rich in
  // one kind and AT-rich in the other, so the phasing has something to sign by.
  // The shared `sample` will not do: each of its diagonals is one value, so its
  // observed/expected is exactly one wherever it is defined, and cooltools'
  // matrix of it is zero throughout.
  const kind = (bin: number): number => Math.floor(bin / 5) % 2
  let checkered = ''
  let reference = ''
  beforeAll(async () => {
    const bins = 60
    const list: HicRecord[] = []
    for (let x = 0; x < bins; x++) {
      for (let y = x; y < bins; y++) {
        list.push({ x, y, value: Math.round((1000 * (kind(x) === kind(y) ? 2 : 1)) / (1 + y - x)) })
      }
    }
    const fixture = await writeHic({
      version: 9,
      chroms: [{ name: 'chrI', length: bins * 1000 }],
      resolutions: [1000],
      records: { '1_1': list },
      blockBinCount: 32,
    })
    checkered = join(directory, 'checkered.hic')
    await writeFile(checkered, fixture.bytes)
    reference = join(directory, 'checkered.fa')
    let bases = ''
    for (let bin = 0; bin < bins; bin++) bases += (kind(bin) === 0 ? 'GC' : 'AT').repeat(500)
    await writeFile(reference, `>chrI\n${bases}\n`)
  })

  const components = async (where: string, header: string): Promise<{ text: string; rows: string[][] }> => {
    const text = await readFile(join(where, 'checkered.compartments.compartment-components.tsv'), 'utf8')
    const body = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
    expect(body[0]).toBe(header)
    return { text, rows: body.slice(1).map((line) => line.split('\t')) }
  }

  it('decomposes observed/expected itself by default, as cooltools does, and says so', async () => {
    reset()
    const where = join(directory, 'by-cooltools')
    expect(
      await main([
        'compartments', checkered, '--components', '3',
        '--sequence', reference, '--phaseSequence', reference, '--out', where, '--quiet',
      ]),
    ).toBe(0)
    expect(complained()).not.toMatch(/failed:/)
    const { text, rows } = await components(where, 'sequence\tcomponent\teigenvalue\tcontacts\tr')
    expect(text).toMatch(/^# param method: cooltools$/m)
    // The default goes unnamed in the label, as the ordinary expectation does.
    expect(text).toMatch(/^# output: Components · .*· cis$/m)
    expect(text).toMatch(/^# columns: sequence, component, eigenvalue, of contacts, r with phasing$/m)
    expect(rows.map((row) => row[1])).toEqual(['E1', 'E2', 'E3'])
    // How much of the contacts each accounts for: the checkerboard is most of
    // this map's departure from expected, and the three share no more than all.
    const shares = rows.map((row) => Number(row[3]))
    expect(shares[0]).toBeGreaterThan(0.3)
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(1)
    // By eigenvalue, largest first, whatever the sign.
    const sizes = rows.map((row) => Math.abs(Number(row[2])))
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1])
    // The first is the compartments, signed so that it rises with GC content.
    expect(Number(rows[0][4])).toBeGreaterThan(0.9)
  })

  it('correlates under --method correlation, as Lieberman-Aiden et al. did, and signs the same way', async () => {
    reset()
    const where = join(directory, 'by-correlation')
    expect(
      await main([
        'compartments', checkered, '--method', 'correlation', '--sequence', reference,
        '--phaseSequence', reference, '--out', where, '--quiet',
      ]),
    ).toBe(0)
    const { text, rows } = await components(where, 'sequence\tcomponent\teigenvalue\texplained\tcontacts\tr')
    expect(text).toMatch(/^# param method: correlation$/m)
    expect(text).toMatch(/^# output: Components · .*· correlation$/m)
    expect(text).toMatch(/^# columns: sequence, component, eigenvalue, variance, of contacts, r with phasing$/m)
    // The correlation's own share and the map's are two numbers, both reported.
    expect(Number(rows[0][4])).toBeGreaterThan(0.3)
    expect(Number(rows[0][5])).toBeGreaterThan(0.9)
  })

  it('refuses the ordering it no longer offers, and a method it does not have', async () => {
    reset()
    expect(
      await main(['compartments', checkered, '--order', 'phasing', '--out', out, '--quiet']),
    ).toBe(2)
    expect(complained()).toMatch(/has no parameter --order/)
    reset()
    expect(
      await main(['compartments', checkered, '--method', 'cooltool', '--out', out, '--quiet']),
    ).toBe(1)
    expect(complained()).toMatch(/There is no method “cooltool”/)
  })
})

/**
 * The one task whose unit is a pair of files. The deck supplies the second
 * map in the app; a shell has one file and one mount, and `--against` is the
 * flag that stands in for the deck — mounted through the same `peer` the
 * analysis worker answers, so the coefficient is the same coefficient.
 */
describe('a task that compares two maps', () => {
  let other = ''

  beforeAll(async () => {
    other = join(directory, 'other.hic')
    const fixture = await writeHic({
      version: 9,
      chroms: [
        { name: 'chrI', length: 120_000 },
        { name: 'chrII', length: 60_000 },
      ],
      resolutions: [1000],
      records: {
        '1_1': records(120, 120, true, 4),
        '2_2': records(60, 60, true, 5),
        '1_2': records(120, 60, false, 6),
      },
      blockBinCount: 32,
    })
    await writeFile(other, fixture.bytes)
  })

  it('refuses to start without the other map, before anything is opened', async () => {
    reset()
    expect(await main(['hicrep', join(directory, 'absent.cool'), '--out', out])).toBe(2)
    expect(complained()).toMatch(/--against/)
    expect(complained()).not.toMatch(/failed:/)
  })

  it('compares the file with every map named by --against', async () => {
    reset()
    const where = join(directory, 'hicrep')
    expect(
      await main(['hicrep', sample, '--against', other, '--against', sample, '--out', where, '--quiet']),
    ).toBe(0)
    const files = await readdir(where)
    expect(files).toContain('sample.hicrep.hicrep-pairs.tsv')
    expect(files).toContain('sample.hicrep.hicrep-strata.tsv')
    const text = await readFile(join(where, 'sample.hicrep.hicrep-pairs.tsv'), 'utf8')
    // Labelled by file — this one too, by its base name as the peers are, not
    // *This map*. The arithmetic is `analysis/hicrep.ts`'s, and what is pinned
    // is that both peers were mounted and read on the same grid: a map against
    // itself correlates at exactly 1 on every stratum that has a correlation.
    // Not the pooled number — HiCRep pools a stratum with a constant side as
    // zero, and this fixture's cells repeat along each diagonal, so after
    // smoothing many of its strata are constant.
    expect(text).toMatch(/sample\.hic\tother\.hic\t-?[01]\.\d+/)
    expect(text).toMatch(/sample\.hic\tsample\.hic\t(0\.\d+|1)$/m)
    expect(text).not.toMatch(/This map/)
    const strata = (await readFile(join(where, 'sample.hicrep.hicrep-strata.tsv'), 'utf8'))
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split('\t'))
    const self = strata[0].indexOf('sample.hic vs sample.hic')
    expect(self).toBeGreaterThan(0)
    const values = strata.slice(1).map((cells) => cells[self]).filter((value) => value !== '')
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) expect(Number(value)).toBe(1)
    expect(complained()).not.toMatch(/failed:/)
  })
})

/**
 * The framing a session sets from the picture, as flags. Each is an input to
 * the arithmetic and none is a parameter of any task, so each is a reserved
 * flag of the command's own — and each is checked before the run rather than
 * read as a default that silently repeats a different run.
 */
describe('the framing flags', () => {
  it('reads a sequence as a circle when told to, and records it', async () => {
    reset()
    const where = join(directory, 'circular')
    expect(
      await main(['insulation', sample, '--circular', 'chrII', '--out', where, '--quiet']),
    ).toBe(0)
    // The profile is named after the window it was scored with, so it is found
    // rather than spelled; the framing line is what is under test.
    const profile = (await readdir(where)).find((name) => /insulation-w\d+\.tsv$/.test(name))
    expect(profile).toBeDefined()
    const text = await readFile(join(where, profile as string), 'utf8')
    expect(text).toMatch(/^# framing: whole file at 1000 bp, count, circular chrII/m)
    expect(complained()).not.toMatch(/failed:/)
  })

  it('refuses a score column the file has not got, by name', async () => {
    reset()
    expect(await main(['insulation', sample, '--value', 'oe', '--out', out, '--quiet'])).toBe(1)
    expect(complained()).toMatch(/has no score column "oe"/)
  })

  it('refuses a cell selection on a file with no cells', async () => {
    reset()
    expect(await main(['insulation', sample, '--cell', 'c1', '--out', out, '--quiet'])).toBe(1)
    expect(complained()).toMatch(/has no cells to choose from/)
  })

  it('records an origin, 1-based as it was typed, digits grouped or not', async () => {
    reset()
    const where = join(directory, 'origin')
    // Grouped as the framing line prints it, beside a second origin.
    expect(
      await main(['interarm', sample, '--origin', 'chrII:1,001,chrI:5', '--out', where, '--quiet']),
    ).toBe(0)
    const table = (await readdir(where)).find((name) => /interarm-table\.tsv$/.test(name))
    expect(table).toBeDefined()
    const text = await readFile(join(where, table as string), 'utf8')
    expect(text).toMatch(/^# framing: .*origin chrII:1,001, chrI:5/m)
  })

  it('refuses an origin on a sequence the file has not got, or past its end', async () => {
    reset()
    expect(await main(['interarm', sample, '--origin', 'chrZ:10', '--out', out, '--quiet'])).toBe(1)
    expect(complained()).toMatch(/--origin chrZ: .* has no sequence of that name/)
    reset()
    expect(
      await main(['interarm', sample, '--origin', 'chrII:900000000', '--out', out, '--quiet']),
    ).toBe(1)
    expect(complained()).toMatch(/is past its end/)
  })
})

/**
 * Every locus a command line names is read as the app's boxes read one (§26.1):
 * 1-based and inclusive, digits grouped or not. It was cooler's grammar, read as
 * written, so the digits a reader copied off the app named a window one base
 * along at a shell — and the console wrote its windows in that grammar to match,
 * a base away from every other locus on the screen.
 */
describe('a locus on the command line (§26.1)', () => {
  /** The fixture's assembly, as the session's context would describe it. */
  const context: AnalysisContext = {
    uri: 'sample.hic',
    layout: 'cool',
    hasMap: true,
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: [],
    binsize: 1000,
    nBins: 180,
    contigs: [
      { name: 'chrI', length: 120_000, startBin: 0, bins: 120, genome: -1 },
      { name: 'chrII', length: 60_000, startBin: 120, bins: 60, genome: -1 },
    ],
    genomes: null,
    entries: [],
    framing: null,
    blockLoaded: false,
    blockBytes: 0,
  }

  it('reads --window 1-based and inclusive, digits grouped or not', async () => {
    for (const window of ['chrI:10,001-50,000', 'chrI:10001-50000', 'chrI:10,001–50,000']) {
      reset()
      const where = join(directory, 'window-typed')
      expect(await main(['expected', sample, '--out', where, '--quiet', '--window', window])).toBe(0)
      const text = await readFile(join(where, 'sample.expected.ps.tsv'), 'utf8')
      expect(text).toMatch(/^# framing: chrI:10,001-50,000 at 1000 bp/m)
    }
  })

  it('takes the window the console writes for a framing, as the bins that framing was', async () => {
    // A view of chrI's bins 10–50 at 1 kb, written as the console writes it…
    const command = cliCommandFor({
      task: taskById('expected') as AnalysisTask,
      provenance: {
        task: 'expected',
        taskVersion: 1,
        params: {},
        framing: {
          uri: sample,
          rows: [10, 50],
          cols: [10, 50],
          binsize: 1000,
          binsPerCell: 1,
          balance: false,
          value: 'count',
          normalise: null,
          level: 'bin',
          label: 'chrI:10,001-50,000 · 1 kb bins · count',
        },
        app: 'test',
        createdAt: '2026-10-01T00:00:00Z',
      },
      context,
    }).text
    const words = command.split('\n').pop()?.split(' ') ?? []
    const window = words[words.indexOf('--window') + 1]
    expect(window).toBe('chrI:10,001-50,000')
    // …is those bins to the shell, and the framing it records says so.
    expect(typedLocusToRegion(window)).toBe('chrI:10000-50000')
    reset()
    const where = join(directory, 'window-console')
    expect(await main(['expected', sample, '--out', where, '--quiet', '--window', window])).toBe(0)
    const text = await readFile(join(where, 'sample.expected.ps.tsv'), 'utf8')
    expect(text).toMatch(/^# framing: chrI:10,001-50,000 at 1000 bp/m)
  })

  it('reads a task’s locus flag 1-based, and records it as it was typed', async () => {
    // The 4C anchor's bins name the profile, so the reading is in the file name:
    // base 1,000 is the last of bin 0, and base 1,001 the first of bin 1.
    reset()
    const where = join(directory, 'anchor-typed')
    expect(await main(['fourc', sample, '--anchor', 'chrI:1,000-1,000', '--out', where, '--quiet'])).toBe(0)
    expect(await main(['fourc', sample, '--anchor', 'chrI:1,001-2,000', '--out', where, '--quiet'])).toBe(0)
    const names = await readdir(where)
    expect(names).toContain('sample.fourc.fourc-0-1.tsv')
    expect(names).toContain('sample.fourc.fourc-1-2.tsv')
    const text = await readFile(join(where, 'sample.fourc.fourc-1-2.tsv'), 'utf8')
    expect(text).toMatch(/^# param anchor: chrI:1,001-2,000$/m)
    expect(complained()).not.toMatch(/failed:/)
  })

  it('replays a recorded locus with the same reading', async () => {
    reset()
    const path = join(directory, 'anchored.metacooler.json')
    await writeFile(
      path,
      JSON.stringify({
        kind: 'metacooler.workspace',
        version: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        active: 0,
        tabs: [
          {
            version: 1,
            createdAt: '2026-10-01T00:00:00.000Z',
            state: { uri: 'sample.hic', view: 'contigs' },
            tracks: [],
            manual: [],
            bookmarks: [],
            // As the form holds it: the display form, grouped.
            analysis: { fourc: { anchor: 'chrI:1,001-2,000', normalise: 'none', cis: true } },
          },
        ],
      }),
    )
    const where = join(directory, 'anchor-replayed')
    expect(await main(['replay', path, '--over', sample, '--out', where, '--quiet'])).toBe(0)
    const text = await readFile(join(where, 'sample.fourc.fourc-1-2.tsv'), 'utf8')
    expect(text).toMatch(/^# param anchor: chrI:1,001-2,000$/m)
  })

  it('says loci are 1-based in its own help', async () => {
    reset()
    expect(await main([])).toBe(0)
    expect(said()).toMatch(/--window <chr:a-b>\s+a window rather than the whole file, 1-based and\s+inclusive/)
  })
})

describe('replaying a workspace', () => {
  /** A workspace file of one tab — what the save button writes for one tab. */
  const tabOf = (analysis: unknown, uri = 'sample.hic') => ({
    version: 1,
    createdAt: '2026-08-12T00:00:00.000Z',
    state: { uri, view: 'contigs' },
    tracks: [],
    manual: [],
    bookmarks: [],
    analysis,
  })

  const workspaceAt = async (
    tabs: unknown[],
    active = 0,
    name = 'workspace.metacooler.json',
  ): Promise<string> => {
    const path = join(directory, name)
    await writeFile(
      path,
      JSON.stringify({
        kind: 'metacooler.workspace',
        version: 1,
        createdAt: '2026-08-12T00:00:00.000Z',
        active,
        tabs,
      }),
    )
    return path
  }

  const sessionAt = (analysis: unknown): Promise<string> => workspaceAt([tabOf(analysis)])

  it('runs what the session recorded, with the parameters it recorded', async () => {
    reset()
    const path = await sessionAt({
      expected: { scope: 'contig', factor: 1.25, derivative: false, minSeparation: 0, balance: false },
    })
    const where = join(directory, 'replayed')
    expect(await main(['replay', path, '--over', sample, '--out', where, '--quiet'])).toBe(0)
    const text = await readFile(join(where, 'sample.expected.ps.tsv'), 'utf8')
    // The whole point: no retyping, so no transcription error. A wrong number in
    // a batch of two hundred is two hundred wrong numbers that look right.
    expect(text).toMatch(/^# param factor: 1\.25$/m)
    expect(text).toMatch(/^# param derivative: false$/m)
  })

  it('says how many tasks and how many files, before it starts', async () => {
    reset()
    const path = await sessionAt({
      expected: { scope: 'contig', factor: 1.1, derivative: true, minSeparation: 0, balance: false },
      coverage: { total: true, cis: false, fraction: false, trans: false, balance: false },
    })
    await main(['replay', path, '--over', sample, '--out', join(directory, 'r2'), '--quiet'])
    expect(complained()).toMatch(/2 tasks from workspace\.metacooler\.json, over 1 file/)
  })

  /**
   * Which tab, out of a window full of them.
   *
   * A workspace holds every tab that was open, and "replay the session" now has
   * to mean one of them. The tab that was in front is the honest default — it is
   * what the reader was looking at when they pressed Save — and `--tab` is
   * one-based because that is how they counted the strip.
   */
  it('replays the tab that was in front, and the one --tab names', async () => {
    reset()
    const path = await workspaceAt(
      [
        tabOf({ coverage: { total: true, cis: false, fraction: false, trans: false, balance: false } }),
        tabOf({
          expected: { scope: 'contig', factor: 1.75, derivative: false, minSeparation: 0, balance: false },
        }),
      ],
      1,
    )
    const front = join(directory, 'front')
    expect(await main(['replay', path, '--over', sample, '--out', front, '--quiet'])).toBe(0)
    expect(await readFile(join(front, 'sample.expected.ps.tsv'), 'utf8')).toMatch(
      /^# param factor: 1\.75$/m,
    )

    reset()
    const first = join(directory, 'first')
    expect(
      await main(['replay', path, '--tab', '1', '--over', sample, '--out', first, '--quiet']),
    ).toBe(0)
    // Named by prefix rather than by one filename: a profile output is a bigWig
    // and a bedGraph beside the table, and which of the three is checked is not
    // what this test is about.
    expect(
      (await readdir(first)).some((name) => name.startsWith('sample.coverage')),
      'tab 1 recorded coverage and nothing else',
    ).toBe(true)
  })

  it('names how many tabs there are rather than replaying the wrong one', async () => {
    // Silently falling back to tab 1 would produce a full set of results from
    // parameters nobody asked for, which is the failure this whole command
    // exists to avoid.
    reset()
    const path = await workspaceAt([tabOf({ coverage: { total: true, balance: false } })])
    expect(await main(['replay', path, '--tab', '4', '--over', sample])).toBe(2)
    expect(complained()).toMatch(/holds 1 tab; --tab must name one of them/)
  })

  it('names a task this build does not have rather than skipping in silence', async () => {
    reset()
    const path = await sessionAt({ notATask: { x: 1 } })
    await main(['replay', path, '--over', sample, '--out', join(directory, 'r3'), '--quiet'])
    // The count said one would run; this is why it did not.
    expect(complained()).toMatch(/skipped notATask: this build has no such task/)
  })

  it('refuses a file that is not a workspace, and says which way it is not one', async () => {
    reset()
    const path = join(directory, 'nope.json')
    await writeFile(path, '{"hello":"world"}')
    expect(await main(['replay', path, '--over', sample])).toBe(2)
    expect(complained()).toMatch(/not a saved workspace/)

    reset()
    const broken = join(directory, 'broken.json')
    await writeFile(broken, 'not json at all')
    expect(await main(['replay', broken, '--over', sample])).toBe(2)
    expect(complained()).toMatch(/not a JSON file/)
  })

  it('refuses a workspace from a newer build without blaming the file', async () => {
    // The reason the message is no longer one blanket sentence. A workspace this
    // build cannot read is a fact about the build, and telling somebody their
    // file is "not a metacooler workspace file" sends them to inspect a file
    // that is perfectly good.
    reset()
    const path = join(directory, 'future.json')
    await writeFile(
      path,
      JSON.stringify({
        kind: 'metacooler.workspace',
        version: 99,
        producer: '(meta)cooler 9.9.9',
        active: 0,
        tabs: [{ state: { uri: 'a.cool', view: 'region' } }],
      }),
    )
    expect(await main(['replay', path, '--over', sample])).toBe(2)
    expect(complained()).toMatch(/newer version of the viewer/)
    expect(complained()).toMatch(/9\.9\.9/)
    expect(complained()).not.toMatch(/not a saved workspace/)
  })

  it('refuses a workspace that recorded no analysis', async () => {
    reset()
    const path = await sessionAt({})
    expect(await main(['replay', path, '--over', sample])).toBe(2)
    expect(complained()).toMatch(/records no analysis parameters/)
  })
})

describe('the small pieces', () => {
  it('orders recorded tasks by the catalogue, not by the file', () => {
    const ordered = recordedTasks({
      analysis: { insulation: {}, coverage: {}, expected: {} },
    })
    // Catalogue order is a reading order (`analysis/registry.ts`): what somebody
    // runs first comes first, and a replay should follow it rather than whatever
    // order a JSON object happened to serialise in.
    expect(ordered.map((entry) => entry.task)).toEqual(['coverage', 'expected', 'insulation'])
  })

  it('keeps an unknown task in the list so replay can report it', () => {
    const ordered = recordedTasks({ analysis: { fromTheFuture: {}, coverage: {} } })
    expect(ordered.map((entry) => entry.task)).toEqual(['coverage', 'fromTheFuture'])
  })

  it('names an output file after the file it came from', () => {
    expect(stemOf('/data/runs/Yeast_microC_G2M_1kb.cool')).toBe('Yeast_microC_G2M_1kb')
    expect(stemOf('Hum53.mmetacool')).toBe('Hum53')
    expect(stemOf('noextension')).toBe('noextension')
    // A group inside the container is not part of the file's name, and two
    // resolutions of one file are two sets of results rather than one written
    // twice.
    expect(stemOf('/data/sample.mcool::/resolutions/1000')).toBe('sample_1000')
    expect(stemOf('/data/sample.mcool::')).toBe('sample')
  })
})

/**
 * What `--features` and `--pairs` read a file as: what the app's loader reads it
 * as (§8), through the same parsers.
 *
 * The shell asked four of the worker's sniffers and then `sniffFormat`, whose
 * last line is `return 'bed'` — so every other format a reader hands a task was
 * read as a BED, and none of them said so. A genePred, a GTF and a VCF came out
 * as nothing, each having a word where a BED has its start or its end; an
 * interact as one box spanning both of its anchors; a longrange as a BED4 whose
 * names were its arcs.
 */
describe('what a file named for a task is read as', () => {
  const INTERACT =
    'chrI\t1000\t20000\tloop1\t500\t5.000000\texpA\t#0000FF\tchrI\t1000\t2000\tprom1\t+\tchrI\t19000\t20000\tenh1\t-'
  const LONGRANGE = ['chrI\t1000\t2000\tchrI:19000-20000,3.5', 'chrI\t19000\t20000\tchrI:1000-2000,3.5'].join(
    '\n',
  )
  const GENEPRED = 'NM_001\tchrI\t+\t1000\t20000\t1200\t19000\t3\t1000,5000,18000,\t2000,6000,20000,'

  it('reads a genePred as its transcripts, exons and all', () => {
    const read = readFeatureText(GENEPRED, 'genes.txt')
    expect('features' in read).toBe(true)
    if (!('features' in read)) return
    expect(read.features.length).toBe(1)
    expect(read.features.id[0]).toBe('NM_001')
    expect([read.features.start[0], read.features.end[0]]).toEqual([1000, 20000])
    // Three exons, at the absolute coordinates the file lists them at, and the
    // coding span inside them.
    const { exonAt, exonStart, exonEnd } = read.features
    expect(Array.from(exonStart.subarray(exonAt[0], exonAt[1]))).toEqual([1000, 5000, 18000])
    expect(Array.from(exonEnd.subarray(exonAt[0], exonAt[1]))).toEqual([2000, 6000, 20000])
    expect([read.features.cdsStart[0], read.features.cdsEnd[0]]).toEqual([1200, 19000])
  })

  it('reads an interact and a longrange as the loop sets they are', () => {
    const interact = readFeatureText(INTERACT, 'loops.txt')
    expect('pairs' in interact && interact.pairs.length).toBe(1)
    if ('pairs' in interact) {
      expect([interact.pairs.start1[0], interact.pairs.end1[0]]).toEqual([1000, 2000])
      expect([interact.pairs.start2[0], interact.pairs.end2[0]]).toEqual([19000, 20000])
      // `value`, the number the pipeline computed, and not the display score.
      expect(interact.pairs.score[0]).toBe(5)
    }
    // Written twice, once from each end, and folded back to the one loop.
    const longrange = readFeatureText(LONGRANGE, 'loops.longrange')
    expect('pairs' in longrange && longrange.pairs.length).toBe(1)
  })

  it('reads a GTF and a VCF as the app does, rather than as BEDs of nothing', () => {
    const gtf = readFeatureText(
      'chrI\tsgd\tgene\t1001\t2000\t.\t+\t.\tgene_id "YAL001C"; gene_name "TFC3";',
      'genes.gtf',
    )
    expect('features' in gtf && gtf.features.length).toBe(1)
    const vcf = readFeatureText(
      '##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\nchrI\t1500\trs1\tA\tG\t50\tPASS\t.',
      'calls.vcf',
    )
    expect('features' in vcf && vcf.features.length).toBe(1)
  })

  it('still reads a BED as a BED, and a bedpe as pairs', () => {
    const bed = readFeatureText('chrI\t1000\t2000\tpeak1\t500\t+', 'peaks.bed')
    expect('features' in bed && bed.features.length).toBe(1)
    const bedpe = readFeatureText('chrI\t1000\t2000\tchrI\t19000\t20000', 'loops.bedpe')
    expect('pairs' in bedpe && bedpe.pairs.length).toBe(1)
  })

  it('reads a --pairs file in whichever of the three paired formats it is', () => {
    expect(readPairText(INTERACT, 'loops.txt').start2[0]).toBe(19000)
    expect(readPairText(LONGRANGE, 'loops.txt').length).toBe(1)
    // A bedpe the BED sniffer would not take — an Ensembl one, whose second
    // contig is called `1` — is still a bedpe here, as the flag says it is.
    const ensembl = readPairText('1\t1000\t2000\t1\t19000\t20000', 'loops.txt')
    expect([ensembl.start1[0], ensembl.start2[0]]).toEqual([1000, 19000])
  })
})
