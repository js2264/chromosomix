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

import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { MIN_JUNCTION_SEQUENCE_BINS, measureJunctions } from '@/analysis/circularity'
import { cliCommandFor } from '@/analysis/cliCommand'
import { TASKS, taskById } from '@/analysis/registry'
import { paramDerived, type AnalysisContext, type AnalysisTask, type Params } from '@/analysis/types'
import { writeBigWig } from '@/analysis/write/bigwig'
import {
  ignoreClosedPipe,
  main,
  parseCommandLine,
  readFeatureText,
  readPairText,
  recordedTasks,
  stemOf,
  stemsOf,
} from '@/cli/main'
import { typedLocusToRegion } from '@/genome/assembly'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { BOOST_ALPHA, boostSteps } from '@/metacooler/boost'
import { LocalFileSource } from '@/sources/LocalFileSource'
import { writeHic, type HicRecord } from '../support/hicWriter'
import { buildTwoBit } from '../support/twoBitWriter'

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
  directory = await mkdtemp(join(tmpdir(), 'chromosomix-cli-'))
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

/** A small `.hic` of its own at `path`, so two inputs of one command hold different maps. */
async function mapAt(path: string, seed: number): Promise<string> {
  const fixture = await writeHic({
    version: 9,
    chroms: [{ name: 'chrI', length: 60_000 }],
    resolutions: [1000],
    records: { '1_1': records(60, 60, true, seed) },
    blockBinCount: 32,
  })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, fixture.bytes)
  return path
}

/** The rows of a written table, without its provenance. */
async function rowsIn(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '' && !line.startsWith('#'))
}

describe('the surface', () => {
  it('prints usage with no arguments, and exits cleanly', async () => {
    reset()
    expect(await main([])).toBe(0)
    expect(said()).toMatch(/chromosomix/)
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
    expect(said()).toMatch(/chromosomix circular/)
  })

  it('says which build it is, and what it runs on', async () => {
    reset()
    expect(await main(['--version'])).toBe(0)
    const lines = said().trimEnd().split('\n')
    // The fallback stamp: vitest applies no `define` block (`version.test.ts`).
    expect(lines[0]).toBe('chromosomix 0.0.0-dev')
    expect(lines[1]).toBe(`node ${process.versions.node} on ${process.platform}-${process.arch}`)
    // Read off the copies installed beside the command, which here are the repository's own.
    const installed = (name: string): string =>
      (JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8')) as {
        version: string
      }).version
    expect(lines.slice(2)).toEqual([`h5wasm ${installed('h5wasm')}`, `@gmod/bbi ${installed('@gmod/bbi')}`])
    expect(complained()).toBe('')
  })

  it('answers --version wherever it is written, before the rest is checked', async () => {
    reset()
    expect(await main(['nonesuch', 'x.cool', '--version'])).toBe(0)
    expect(said()).toMatch(/^chromosomix 0\.0\.0-dev\n/)
    expect(complained()).toBe('')
  })

  it('lets a reader stop reading, and still throws anything else', () => {
    // `chromosomix tasks | head -1`: the pipe closes under the command, and Node
    // reports the next write as an error on the stream — EPIPE, or EOF on Windows.
    const stream = new EventEmitter() as unknown as NodeJS.WritableStream
    ignoreClosedPipe(stream)
    const failure = (code: string): Error => Object.assign(new Error(`write ${code}`), { code })
    expect(() => stream.emit('error', failure('EPIPE'))).not.toThrow()
    expect(() => stream.emit('error', failure('EOF'))).not.toThrow()
    expect(() => stream.emit('error', failure('ENOSPC'))).toThrow('write ENOSPC')
  })
})

describe('the junction test', () => {
  /** Rows of the table `circular` printed, without its `#` lines. */
  const table = (): string[][] =>
    said()
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split('\t'))

  it('reads a sequence whose ends are a chromosome apart as a line', async () => {
    // Every cell present, and each a function of the separation along the line.
    const n = 60
    const line: HicRecord[] = []
    for (let x = 0; x < n; x++) {
      for (let y = x; y < n; y++) line.push({ x, y, value: Math.round(10_000 / (1 + y - x) ** 1.5) })
    }
    const fixture = await writeHic({
      version: 9,
      chroms: [{ name: 'line', length: n * 1000 }],
      resolutions: [1000],
      records: { '1_1': line },
      blockBinCount: 32,
    })
    const file = join(directory, 'line.hic')
    await writeFile(file, fixture.bytes)
    reset()
    expect(await main(['circular', file, '--quiet'])).toBe(0)
    expect(said()).toMatch(/^# framing: 1000 bp$/m)
    const rows = table()
    expect(rows[0]).toEqual(['sequence', 'length', 'score', 'circular'])
    expect(rows[1][0]).toBe('line')
    expect(Number(rows[1][2])).toBeLessThan(0.05)
    expect(rows[1][3]).toBe('no')
  })

  it('leaves a sequence undecided where it can be compared at one separation alone', async () => {
    // The sample's cells are one in five, laid out so that each sequence's
    // diagonal holds contacts at one separation of the three — the third on
    // chrI, the first on chrII — and a score there would be one cell's.
    reset()
    expect(await main(['circular', sample, '--quiet'])).toBe(0)
    expect(table().slice(1)).toEqual([
      ['chrI', '120000', '', ''],
      ['chrII', '60000', '', ''],
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

  /**
   * A level that floors each sequence's last part-bin into the bin before it:
   * the yeast and *M. pneumoniae* demo at 2 kb gives chromosome I 115 bins where
   * `ceil(230,218 / 2,000)` is 116. Summed that way, every first bin after I
   * drifted, and the test read the bins of the sequences beside each one. It
   * reads each where the file puts it, as the oracle here does from the file's
   * own extents.
   */
  it('reads each sequence where the file puts it, on a level that floors its part-bins', async () => {
    const demo = new URL('../../demo/yeast-mpneumoniae/Yeast_mpneumoniae_G2M.mcool', import.meta.url).pathname
    const uri = `${demo}::/resolutions/2000`
    reset()
    expect(await main(['circular', uri, '--quiet'])).toBe(0)
    const decided = table()
      .slice(1)
      .filter((row) => row[2] !== '')

    const source = await LocalFileSource.fromPath(demo)
    await source.mount()
    const mc = await MetaCooler.open(uri, source)
    try {
      expect(mc.contigExtent('I')).toEqual([0, 115])
      const placed = mc.chromnames.flatMap((name) => {
        const [from, to] = mc.contigExtent(name)
        return to - from >= MIN_JUNCTION_SEQUENCE_BINS ? [{ name, from, n: to - from }] : []
      })
      const oracle = await measureJunctions(
        placed,
        async (rows, cols) => (await mc.matrix({ rows, cols, balance: mc.hasWeights })).values,
      )
      const scores = oracle?.scores ?? {}
      expect(Object.keys(scores).length).toBeGreaterThan(0)
      expect(decided.map((row) => row[0]).sort()).toEqual(Object.keys(scores).sort())
      for (const row of decided) expect(Number(row[2])).toBeCloseTo(scores[row[0]], 3)
    } finally {
      mc.close()
    }
  })

  it('needs a file', async () => {
    reset()
    expect(await main(['circular'])).toBe(2)
    expect(complained()).toMatch(/circular needs at least one file/)
  })
})

describe('Boost-HiC, on its own', () => {
  /** The square `boost` wrote: each kept bin's start, and the map over them. */
  async function square(file: string): Promise<{ starts: number[]; values: number[][]; head: string }> {
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n').filter((line) => line !== '')
    const rows = lines.filter((line) => !line.startsWith('#')).map((line) => line.split('\t'))
    return {
      starts: rows[0].slice(1).map(Number),
      values: rows.slice(1).map((row) => row.slice(1).map(Number)),
      head: lines.filter((line) => line.startsWith('#')).join('\n'),
    }
  }

  it('writes the map boostSteps makes of the sequence’s own counts, over the bins it keeps', async () => {
    const where = join(directory, 'boost')
    reset()
    expect(await main(['boost', sample, '--sequences', 'chrII', '--out', where, '--quiet'])).toBe(0)
    expect(await readdir(where)).toEqual(['sample.boost-chrII.tsv'])
    const written = await square(join(where, 'sample.boost-chrII.tsv'))
    expect(written.head).toMatch(/^# alpha: 0\.2$/m)
    expect(written.head).toMatch(/^# units: SCN$/m)

    // The oracle reads the counts through the dense path, not the band the
    // command reads, and hands them to the port directly.
    const source = await LocalFileSource.fromPath(sample)
    await source.mount()
    const mc = await MetaCooler.open(sample, source)
    try {
      const [from, to] = mc.contigExtent('chrII')
      const n = to - from
      const dense = await mc.matrix({ rows: [from, to], cols: [from, to], balance: false })
      const steps = boostSteps(Float64Array.from(dense.values), n, BOOST_ALPHA)!
      expect(written.starts).toEqual(Array.from(steps.kept, (bin) => bin * mc.binsize))
      const size = steps.kept.length
      expect(written.values).toHaveLength(size)
      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          const expected = steps.boosted[row * size + col]
          expect(Math.abs(written.values[row][col] - expected)).toBeLessThanOrEqual(1e-9 * Math.abs(expected))
        }
      }
    } finally {
      mc.close()
    }
  })

  it('boosts every sequence when none is named', async () => {
    const where = join(directory, 'boost-all')
    reset()
    expect(await main(['boost', sample, '--out', where, '--quiet'])).toBe(0)
    expect((await readdir(where)).sort()).toEqual(['sample.boost-chrI.tsv', 'sample.boost-chrII.tsv'])
  })

  it('refuses a sequence the file has not got, by name, and writes the others', async () => {
    const where = join(directory, 'boost-named')
    reset()
    expect(await main(['boost', sample, '--sequences', 'chrII,chrIX', '--out', where, '--quiet'])).toBe(1)
    expect(complained()).toMatch(/has no sequence chrIX/)
    expect(await readdir(where)).toEqual(['sample.boost-chrII.tsv'])
  })

  it('refuses an exponent that is not a positive number, and a run with no file', async () => {
    reset()
    expect(await main(['boost', sample, '--alpha', '-1'])).toBe(2)
    expect(complained()).toMatch(/--alpha needs a positive number/)
    reset()
    expect(await main(['boost'])).toBe(2)
    expect(complained()).toMatch(/boost needs at least one file/)
  })

  it('is offered beside the tasks', async () => {
    reset()
    expect(await main([])).toBe(0)
    expect(said()).toMatch(/chromosomix boost/)
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
    // wondering whether the difference is the tool. Its build is the version and
    // `cli`, where the browser's is the version and the commit.
    expect(text).toMatch(/^# chromosomix \S+ cli$/m)
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
    // A switch's value after `=`: a switch never takes the word after it, so
    // `--derivative false` is refused (see "the line, typed by the command").
    expect(
      await main(['expected', sample, '--out', out, '--quiet', '--factor', '1.5', '--derivative=false']),
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

  it('reads the map at --coarsen, its bins summed, and names the outputs and the framing for it (§3.4)', async () => {
    reset()
    const code = await main(['insulation', sample, '--out', out, '--quiet', '--coarsen', '3000', '--no-balance'])
    expect(code, complained()).toBe(0)
    const track = await readFile(join(out, 'sample_coarsen3000.insulation.insulation-w10.bedGraph'), 'utf8')
    expect(track).toMatch(/^# framing: whole file at 3000 bp \(1000 bp bins summed\), count$/m)
    // Every interval one summed bin: three of the file's, or what is left at a
    // sequence's end.
    const rows = track
      .split('\n')
      .filter((line) => /^chrI{1,2}\t/.test(line))
      .map((line) => line.split('\t'))
    expect(rows.length).toBeGreaterThan(0)
    for (const [name, start, end] of rows) {
      const length = name === 'chrI' ? 120_000 : 60_000
      expect(Number(start) % 3000).toBe(0)
      expect(Number(end) - Number(start) === 3000 || Number(end) === length).toBe(true)
    }
  })

  it('refuses a --coarsen that is not a whole number of the file’s bins', async () => {
    reset()
    expect(await main(['expected', sample, '--out', out, '--quiet', '--coarsen', '2500'])).not.toBe(0)
    expect(complained()).toMatch(/--coarsen 2500: sample\.hic is at 1,000 bp, and 2,500 bp is not a whole number of its bins/)
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
    expect(text).toMatch(/^# chromosomix .*bed3d: chrom start end x y z/m)
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
    // …and as a PDB beside it, for PyMOL, through the drawer's own writer: a
    // HETATM per bead, and the same beads back when this app reads it.
    expect(files).toContain('sample.reconstruct3d.reconstructed-model.pdb')
    const pdbPath = join(out, 'sample.reconstruct3d.reconstructed-model.pdb')
    const pdb = await readFile(pdbPath, 'utf8')
    expect(pdb.split('\n').filter((line) => line.startsWith('HETATM'))).toHaveLength(rows.length)
    const fromPdb = readFeatureText(pdb, pdbPath)
    const fromBed3d = readFeatureText(text, 'model.bed3d')
    if (!('features' in fromPdb) || !('features' in fromBed3d)) throw new Error('not a feature set')
    expect(Array.from(fromPdb.features.start)).toEqual(Array.from(fromBed3d.features.start))
    expect(Array.from(fromPdb.features.end)).toEqual(Array.from(fromBed3d.features.end))
    expect(fromPdb.features.contigs).toEqual(fromBed3d.features.contigs)
    for (let i = 0; i < fromPdb.features.length; i++) {
      expect(fromPdb.features.model?.x[i]).toBeCloseTo(fromBed3d.features.model?.x[i] ?? Number.NaN, 3)
    }
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
    // The PDB written beside it is the same model to every task that reads one.
    const fromPdb = join(directory, 'spatial-pdb')
    const pdb = join(where, 'sample.reconstruct3d.reconstructed-model.pdb')
    expect(
      await main(['spatialtracks', sample, '--features', pdb, '--structure', pdb, '--out', fromPdb, '--quiet']),
    ).toBe(0)
    expect(complained()).not.toMatch(/not a structure/)
    expect((await readdir(fromPdb)).some((name) => /structure-radial.*\.tsv$/.test(name))).toBe(true)
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
/**
 * A `--sequence` opened the way the browser opens it (§8.8, §8.21).
 *
 * A reference was read whole here, always, and Node will not `readFile` past
 * 2 GiB — so a plain mouse FASTA was refused before a byte of it was parsed.
 * Now a FASTA with its `.fai` beside it, and a `.2bit`, are read by range
 * (`cli/reference.ts`), and what is pinned is that the answer cannot tell:
 * the motif search and the composition both walk the index a piece at a time,
 * and both write what the whole read wrote.
 */
describe('a --sequence read by range', () => {
  /** A deterministic genome over the sample's two sequences, with sites in it. */
  function genome(): Array<[string, string]> {
    let seed = 7
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed
    }
    const make = (length: number): string => {
      const out: string[] = []
      for (let i = 0; i < length; i++) out.push('ACGT'[next() % 4])
      // A site every 7 kb or so, on both strands, a few across a line break.
      for (let at = 1_000; at + 5 < length; at += 7_013) {
        out.splice(at, 5, ...(at % 2 === 0 ? 'GGTCA' : 'TGACC'))
      }
      return out.join('')
    }
    return [
      ['chrI', make(120_000)],
      ['chrII', make(60_000)],
    ]
  }

  /** The FASTA, wrapped at 60, and the `.fai` `samtools faidx` writes for it. */
  function fastaAndIndex(sequences: Array<[string, string]>): { fasta: string; fai: string } {
    let fasta = ''
    const fai: string[] = []
    for (const [name, bases] of sequences) {
      fasta += `>${name}\n`
      fai.push(`${name}\t${bases.length}\t${fasta.length}\t60\t61`)
      for (let at = 0; at < bases.length; at += 60) fasta += `${bases.slice(at, at + 60)}\n`
    }
    return { fasta, fai: fai.join('\n') + '\n' }
  }

  let whole = ''
  let indexed = ''
  let twobit = ''

  beforeAll(async () => {
    const sequences = genome()
    const { fasta, fai } = fastaAndIndex(sequences)
    whole = join(directory, 'whole.fa')
    indexed = join(directory, 'indexed.fa')
    twobit = join(directory, 'packed.2bit')
    await writeFile(whole, fasta)
    await writeFile(indexed, fasta)
    await writeFile(`${indexed}.fai`, fai)
    await writeFile(twobit, buildTwoBit(sequences.map(([name, bases]) => ({ name, bases }))))
  })

  /** The data rows of one written file, without the provenance that names the reference. */
  async function rowsOf(where: string, file: string): Promise<string[]> {
    return (await readFile(join(where, file), 'utf8')).split('\n').filter((line) => line !== '' && !line.startsWith('#'))
  }

  it('searches a FASTA through its .fai, and a .2bit, site for site as the whole file', async () => {
    const runs: Record<string, string[]> = {}
    for (const [name, reference] of [['whole', whole], ['indexed', indexed], ['twobit', twobit]] as const) {
      reset()
      const where = join(directory, `motif-${name}`)
      expect(
        await main(['motif', sample, '--sequence', reference, '--pattern', 'GGTCA', '--out', where, '--quiet']),
        complained(),
      ).toBe(0)
      runs[name] = await rowsOf(where, 'sample.motif.motif-GGTCA-both.tsv')
    }
    expect(runs.whole.length).toBeGreaterThan(20)
    expect(runs.indexed).toEqual(runs.whole)
    expect(runs.twobit).toEqual(runs.whole)
  })

  it('searches only the sequences named with --sequences', async () => {
    reset()
    const where = join(directory, 'motif-chrII')
    expect(
      await main([
        'motif', sample, '--sequence', indexed, '--pattern', 'GGTCA', '--sequences', 'chrII',
        '--out', where, '--quiet',
      ]),
      complained(),
    ).toBe(0)
    const rows = await rowsOf(where, 'sample.motif.motif-GGTCA-both-on-chrII.tsv')
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.filter((row) => /^chrI\t/.test(row))).toEqual([])
  })

  it('counts base composition through the .fai as it counts the file read whole', async () => {
    const runs: Record<string, string[]> = {}
    for (const [name, reference] of [['whole', whole], ['indexed', indexed]] as const) {
      reset()
      const where = join(directory, `composition-${name}`)
      expect(await main(['composition', '--sequence', reference, '--out', where, '--quiet']), complained()).toBe(0)
      const stem = name === 'whole' ? 'whole' : 'indexed'
      runs[name] = await rowsOf(where, `${stem}.composition.composition-gc.bedGraph`)
    }
    expect(runs.whole.length).toBe(12 + 6)
    expect(runs.indexed).toEqual(runs.whole)
  })

  it('refuses a FASTA past 2 GiB with no index, and searches it once the index is beside it', async () => {
    // The genome, and then nothing to the 2 GiB mark — sparse, so the test
    // writes kilobytes. Read whole it is refused by size before a byte is
    // read; read by its index it is the genome above and nothing more.
    const huge = join(directory, 'huge.fa')
    const { fasta, fai } = fastaAndIndex(genome())
    await writeFile(huge, fasta)
    await truncate(huge, 2 ** 31 + 1)
    reset()
    const where = join(directory, 'motif-huge')
    const args = ['motif', sample, '--sequence', huge, '--pattern', 'GGTCA', '--out', where, '--quiet']
    expect(await main(args)).toBe(2)
    expect(complained()).toContain('samtools faidx huge.fa')

    await writeFile(`${huge}.fai`, fai)
    reset()
    expect(await main(args), complained()).toBe(0)
    const reference = join(directory, 'motif-huge-whole')
    expect(
      await main(['motif', sample, '--sequence', whole, '--pattern', 'GGTCA', '--out', reference, '--quiet']),
    ).toBe(0)
    expect(await rowsOf(where, 'sample.motif.motif-GGTCA-both.tsv')).toEqual(
      await rowsOf(reference, 'sample.motif.motif-GGTCA-both.tsv'),
    )
    await rm(huge)
  })
})

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
    // The curve's column is the track as the app names its row, `signal`, so the
    // drawer's TSV and this one have one header (notebooks/parity.qmd).
    expect(text).toMatch(/^Distance from the anchor \(bp\)\tsignal\tsignal_low\tsignal_high$/m)
    expect(complained()).not.toMatch(/failed:/)
  })

  it('writes a metaplot’s heatmap for each of its tracks', async () => {
    reset()
    const where = join(directory, 'metaplot-two')
    expect(
      await main([
        'metaplot', sample, '--tracks', `${bigwig},${doubled}`, '--features', aBed,
        '--band', 'none', '--out', where, '--quiet',
      ]),
    ).toBe(0)
    const files = (await readdir(where)).filter((name) => name.includes('heatmap'))
    expect(files.sort()).toEqual([
      'sample.metaplot.metaplot-heatmap-2.tsv',
      'sample.metaplot.metaplot-heatmap.tsv',
    ])
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
    // One row, named after the file as the app names its row — `signal`, the
    // suffix off — with a fraction in it: the arithmetic is goldened in
    // `analysis-golden.test.ts`, and what is pinned here is that a shell reaches
    // it through the same `sample`.
    expect(text).toMatch(/^signal\t0\.\d+/m)
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
    // and the axes are the files' names as the app's rows have them, not `a1`.
    expect(text).toMatch(/^signal\ttwice\t1(\.0*)?$/m)
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
    expect(text).toMatch(/^signal\t0\.\d+/m)
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
    expect(summary).toMatch(/^signal\tA\t6\t60000\t29\.5\b/m)
    expect(summary).toMatch(/^signal\tB\t6\t60000\t89\.5\b/m)
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

  it('lists every task as one JSON document, with every value a choice takes', async () => {
    reset()
    expect(await main(['tasks', '--json'])).toBe(0)
    const listed = JSON.parse(said()) as {
      producer: string
      inputs: Record<string, string>
      outputs: Record<string, string>
      tasks: Array<{ id: string; params: Array<{ key: string; flag: string; choices?: Array<{ value: string }> }> }>
    }
    expect(listed.producer).toMatch(/^chromosomix /)
    // Every task the plain listing names, dev features' included: the command runs them all.
    expect(listed.tasks.map((task) => task.id)).toEqual(TASKS.map((task) => task.id))
    expect(Object.keys(listed.inputs)).toEqual(['featureSet', 'pairSet', 'track', 'sequence'])
    expect(Object.keys(listed.outputs)).toContain('profile')
    const apa = listed.tasks.find((task) => task.id === 'apa')
    expect(apa?.params.find((param) => param.key === 'norm')?.choices?.map((choice) => choice.value)).toContain('matched')
    expect(apa?.params.find((param) => param.key === 'balance')?.flag).toBe('--no-balance')
    // The deck a comparison reads, spelled as the files a shell names.
    expect(listed.tasks.find((task) => task.id === 'hicrep')?.params[0]?.flag).toBe('--against <file>')
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
    const path = join(directory, 'trackcorr.chromosomix.json')
    await writeFile(
      path,
      JSON.stringify({
        kind: 'chromosomix.workspace',
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
    // Named as the workspace's rows are, `signal` and `twice`.
    expect(text).toMatch(/^signal\ttwice\t1(\.0*)?$/m)
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
    // Refused before the file is opened now, with the values there are: the
    // choice is checked against the descriptor's options, as the form offers
    // them, rather than by the runner once per file.
    reset()
    expect(
      await main(['compartments', checkered, '--method', 'cooltool', '--out', out, '--quiet']),
    ).toBe(2)
    expect(complained()).toMatch(/There is no --method “cooltool”\. It is cooltools or correlation\./)
  })

  // `--contacts` is both this task's own choice and the total a map is drawn to
  // (§6.5), and the console writes both on one line. Every compartments line it
  // had written was refused, `cis` read as a total.
  it('runs the console’s own line, whose --contacts cis is its choice and not a total', async () => {
    reset()
    const where = join(directory, 'console-line')
    expect(
      await main(['compartments', checkered, '--contacts', 'cis', '--out', where, '--quiet']),
    ).toBe(0)
    const { text } = await components(where, 'sequence\tcomponent\teigenvalue\tcontacts\tr')
    expect(text).toMatch(/^# param contacts: cis$/m)
  })

  it('draws the map to a total written beside the choice, and reads the choice as the task’s', async () => {
    reset()
    const plain = join(directory, 'undrawn')
    const drawn = join(directory, 'drawn')
    expect(
      await main(['compartments', checkered, '--contacts', 'both', '--out', plain, '--quiet']),
    ).toBe(0)
    expect(
      await main([
        'compartments', checkered, '--contacts', 'both', '--contacts', '20k', '--out', drawn, '--quiet',
      ]),
    ).toBe(0)
    const before = (await components(plain, 'sequence\tcomponent\teigenvalue\tcontacts\tr')).text
    const after = (await components(drawn, 'sequence\tcomponent\teigenvalue\tcontacts\tr')).text
    expect(after).toMatch(/^# param contacts: both$/m)
    // The total is the framing's, so it is in the record and in the numbers:
    // a map drawn to twenty thousand contacts is not the map as stored.
    expect(after).toMatch(/20,000/)
    expect(before).not.toMatch(/20,000/)
  })

  it('refuses a word that is neither one of its contacts nor a total, naming both', async () => {
    reset()
    expect(
      await main(['compartments', checkered, '--contacts', 'cs', '--out', out, '--quiet']),
    ).toBe(2)
    expect(complained()).toMatch(/--contacts cs is neither a choice of compartments \(cis, both, trans\) nor a number/)
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
    const path = join(directory, 'anchored.chromosomix.json')
    await writeFile(
      path,
      JSON.stringify({
        kind: 'chromosomix.workspace',
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
    name = 'workspace.chromosomix.json',
  ): Promise<string> => {
    const path = join(directory, name)
    await writeFile(
      path,
      JSON.stringify({
        kind: 'chromosomix.workspace',
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
    expect(complained()).toMatch(/2 tasks from workspace\.chromosomix\.json, over 1 file/)
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
    // file is "not a chromosomix workspace file" sends them to inspect a file
    // that is perfectly good.
    reset()
    const path = join(directory, 'future.json')
    await writeFile(
      path,
      JSON.stringify({
        kind: 'chromosomix.workspace',
        version: 99,
        producer: 'chromosomix 9.9.9',
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

  /**
   * `--over data/*.hic`, as a shell expands it, is `--over` and one file and
   * then the rest as words of their own — which replay never read, so it
   * replayed the first file alone and exited 0.
   */
  it('replays every file the shell expanded --over to', async () => {
    reset()
    const path = await sessionAt({
      expected: { scope: 'contig', factor: 1.1, derivative: true, minSeparation: 0, balance: false },
    })
    const other = await mapAt(join(directory, 'replay-many', 'other.hic'), 21)
    const where = join(directory, 'replayed-many')
    expect(await main(['replay', path, '--over', sample, other, '--out', where, '--quiet'])).toBe(0)
    expect(complained()).toMatch(/over 2 files/)
    const files = await readdir(where)
    expect(files).toContain('sample.expected.ps.tsv')
    expect(files).toContain('other.expected.ps.tsv')
  })

  /**
   * The runners read a recorded value with a fallback, so a workspace naming
   * an option this build has not got ran the default under the recorded name.
   * Checked as a typed value is, before any file is opened.
   */
  it('refuses a recorded value this build cannot run, before any file', async () => {
    reset()
    const where = join(directory, 'replay-refused')
    const path = await sessionAt({ expected: { scope: 'contig', quantity: 'expectd', factor: 1.1 } })
    expect(await main(['replay', path, '--over', sample, '--out', where, '--quiet'])).toBe(2)
    expect(complained()).toMatch(/recorded expected with a value this build cannot run/)
    expect(complained()).toMatch(/There is no --quantity “expectd”\. It is density or expected\./)
    expect(existsSync(where)).toBe(false)
    // The text `"false"` is not `false`, and `boolParam` reads it as neither.
    reset()
    const typed = await sessionAt({ expected: { derivative: 'false' } })
    expect(await main(['replay', typed, '--over', sample, '--out', where, '--quiet'])).toBe(2)
    expect(complained()).toMatch(/--derivative is true or false, not the text “false”/)
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

/**
 * The line, typed by what the command takes (§23.1).
 *
 * A flag took the next word as its value unless that word began with `--`, so a
 * switch swallowed the file after it: `coverage a.cool --no-balance b.hic` ran
 * over `a.cool` alone and exited 0, and `coverage --quiet a.cool` refused
 * itself for having no file. What a flag takes comes from the command now — a
 * task's descriptor says which of its parameters are switches, and the CLI's
 * own flags are known.
 */
describe('the line, typed by the command', () => {
  let first = ''
  let second = ''
  beforeAll(async () => {
    first = await mapAt(join(directory, 'typed', 'first.hic'), 7)
    second = await mapAt(join(directory, 'typed', 'second.hic'), 8)
  })

  it('never lets a switch take the file after it', async () => {
    reset()
    const where = join(directory, 'typed-swallow')
    expect(await main(['coverage', first, '--no-balance', second, '--out', where, '--quiet'])).toBe(0)
    const files = await readdir(where)
    expect(files).toContain('first.coverage.coverage-total.tsv')
    expect(files).toContain('second.coverage.coverage-total.tsv')
  })

  it('reads --quiet before the file as a switch, and is quiet', async () => {
    reset()
    const where = join(directory, 'typed-quiet')
    expect(await main(['coverage', '--quiet', first, '--out', where])).toBe(0)
    expect(await readdir(where)).toContain('first.coverage.coverage-total.tsv')
    expect(complained()).not.toMatch(/wrote|first\.hic\n/)
  })

  it('takes the command line’s own flags before the task, and refuses a task’s there', async () => {
    reset()
    const where = join(directory, 'typed-before')
    expect(await main(['--quiet', 'coverage', first, '--out', where])).toBe(0)
    expect(await readdir(where)).toContain('first.coverage.coverage-total.tsv')
    reset()
    expect(await main(['--factor', '1.5', 'expected', first])).toBe(2)
    expect(complained()).toMatch(/a task's flags come after the task/)
  })

  it('turns a switch off by =false or --no-, and refuses a word after it', async () => {
    reset()
    const where = join(directory, 'typed-off')
    expect(await main(['expected', first, '--no-derivative', '--out', where, '--quiet'])).toBe(0)
    expect(await readFile(join(where, 'first.expected.ps.tsv'), 'utf8')).toMatch(
      /^# param derivative: false$/m,
    )
    // The old spelling, a file called `false` to a typed parser: refused, and
    // told what to write, before anything is opened or written.
    reset()
    const refused = join(directory, 'typed-refused')
    expect(await main(['expected', first, '--derivative', 'false', '--out', refused, '--quiet'])).toBe(2)
    expect(complained()).toMatch(/--derivative is a switch and takes nothing after it/)
    expect(complained()).toMatch(/--derivative=false or --no-derivative/)
    expect(existsSync(refused)).toBe(false)
    reset()
    expect(await main(['expected', first, '--derivative=maybe', '--out', refused, '--quiet'])).toBe(2)
    expect(complained()).toMatch(/a switch is true or false/)
  })

  it('refuses a flag that takes a value and was given none', async () => {
    // `--out --quiet` wrote into a directory called `true`.
    reset()
    expect(await main(['expected', first, '--out', '--quiet'])).toBe(2)
    expect(complained()).toMatch(/--out needs a value after it/)
    reset()
    expect(await main(['expected', first, '--quiet', '--out'])).toBe(2)
    expect(complained()).toMatch(/--out needs a value after it/)
  })

  it('refuses a flag replay and circular do not take, as it refuses a task’s', async () => {
    reset()
    expect(await main(['circular', first, '--factor', '2'])).toBe(2)
    expect(complained()).toMatch(/circular has no flag --factor/)
  })
})

/**
 * A value the form could have held (§23.1). The runners read a choice with a
 * fallback, and the form never reaches it; a shell did, and ran the default
 * under a provenance naming the value typed.
 */
describe('a value the form could have held', () => {
  it('refuses a choice that is none of its values, and names the values there are', async () => {
    reset()
    const where = join(directory, 'choice-refused')
    expect(await main(['expected', sample, '--quantity', 'expectd', '--out', where, '--quiet'])).toBe(2)
    expect(complained()).toMatch(/There is no --quantity “expectd”\. It is density or expected\./)
    // Before anything is opened, so nothing went out under a record of a run
    // that never happened.
    expect(existsSync(where)).toBe(false)
  })

  it('takes every descriptor’s own default, which a run given no flag is handed', () => {
    // The check reads the options, so a default that is none of them would
    // refuse every run of its task before a file was opened.
    for (const task of TASKS) {
      for (const spec of task.params) {
        if (spec.kind !== 'choice') continue
        expect(spec.options.map((option) => option.value), `${task.id} --${spec.key}`).toContain(spec.default)
      }
    }
  })

  it('writes a value with a space in it as a shell takes it', async () => {
    reset()
    expect(await main(['dotplot', '--streaks', 'one'])).toBe(2)
    expect(complained()).toMatch(/It is 'one to one' or 'every one'\./)
  })

  it('refuses a number that does not parse, an empty one included', async () => {
    for (const bad of [['--factor', 'abc'], ['--factor='], ['--factor', '0x10']]) {
      reset()
      expect(await main(['expected', sample, ...bad, '--quiet']), bad.join(' ')).toBe(2)
      expect(complained()).toMatch(/--factor needs a number/)
    }
  })

  it('refuses a --bin-size or --rungs that is not a whole number, for any input', async () => {
    reset()
    expect(await main(['coverage', sample, '--bin-size', '5000', '--rungs', 'abc', '--quiet'])).toBe(2)
    expect(complained()).toMatch(/--rungs needs a number/)
    reset()
    expect(await main(['circular', sample, '--bin-size', '0'])).toBe(2)
    expect(complained()).toMatch(/--bin-size is a whole number of base pairs/)
  })
})

/**
 * What a command names its outputs (§23.1). The stem was the name up to its
 * first dot and nothing else, so two files that shared one were written under
 * one name, the second over the first, with exit 0.
 */
describe('the outputs of one command, one name each', () => {
  it('keeps more of two names that share a stem, and both results', async () => {
    const one = await mapAt(join(directory, 'stems', 'HCT116.rep1.hic'), 11)
    const two = await mapAt(join(directory, 'stems', 'HCT116.rep2.hic'), 12)
    reset()
    const where = join(directory, 'stems-reps')
    expect(await main(['coverage', one, two, '--out', where, '--quiet'])).toBe(0)
    const files = await readdir(where)
    expect(files).toContain('HCT116.rep1.coverage.coverage-total.tsv')
    expect(files).toContain('HCT116.rep2.coverage.coverage-total.tsv')
    expect(files.some((name) => name.startsWith('HCT116.coverage'))).toBe(false)
    // Two maps, two answers: neither run's table is the other's.
    expect(await rowsIn(join(where, 'HCT116.rep1.coverage.coverage-total.tsv'))).not.toEqual(
      await rowsIn(join(where, 'HCT116.rep2.coverage.coverage-total.tsv')),
    )
  })

  it('tells two files of one name apart by the directories they are in', async () => {
    const a = await mapAt(join(directory, 'stems', 'dirA', 'sample.hic'), 13)
    const b = await mapAt(join(directory, 'stems', 'dirB', 'sample.hic'), 14)
    reset()
    const where = join(directory, 'stems-dirs')
    expect(await main(['coverage', a, b, '--out', where, '--quiet'])).toBe(0)
    const files = await readdir(where)
    expect(files).toContain('dirA_sample.coverage.coverage-total.tsv')
    expect(files).toContain('dirB_sample.coverage.coverage-total.tsv')
  })

  it('names the batch before its first run, and a file that names nothing fails alone', async () => {
    // The stems are made before any file is opened, so a positional the run
    // refuses must not refuse the batch: `::x` names a group of no file.
    reset()
    const where = join(directory, 'stems-empty')
    expect(await main(['coverage', '::x', sample, '--out', where, '--quiet'])).toBe(1)
    expect(complained()).toMatch(/failed:/)
    expect(await readdir(where)).toContain('sample.coverage.coverage-total.tsv')
  })

  it('names the outputs of one file as it always has', async () => {
    const one = await mapAt(join(directory, 'stems', 'HCT116.rep1.hic'), 11)
    reset()
    const where = join(directory, 'stems-alone')
    expect(await main(['coverage', one, '--out', where, '--quiet'])).toBe(0)
    expect(await readdir(where)).toContain('HCT116.coverage.coverage-total.tsv')
  })

  it('gives every input of one command its own stem, the same way every time', () => {
    expect(stemsOf(['/d/HCT116.rep1.cool', '/d/HCT116.rep2.cool'])).toEqual(['HCT116.rep1', 'HCT116.rep2'])
    expect(stemsOf(['/a/sample.mcool', '/b/sample.mcool'])).toEqual(['a_sample', 'b_sample'])
    expect(stemsOf(['/d/x.cool', '/d/x.hic'])).toEqual(['x.cool', 'x.hic'])
    expect(stemsOf(['/d/x.pairs.gz', '/d/x.mcool'])).toEqual(['x.pairs.gz', 'x.mcool'])
    // Two resolutions of one file were two stems already.
    expect(stemsOf(['/d/x.mcool::/resolutions/1000', '/d/x.mcool::/resolutions/5000'])).toEqual([
      'x_1000',
      'x_5000',
    ])
    // Only the two that met keep more of their names.
    expect(stemsOf(['/d/a.cool', '/d/HCT116.rep1.cool', '/d/HCT116.rep2.cool'])).toEqual([
      'a',
      'HCT116.rep1',
      'HCT116.rep2',
    ])
    // One file twice, and two names that are one file on a Mac's disk: no more
    // of the name tells them apart, so the second is numbered.
    expect(stemsOf(['/d/x.cool', '/d/x.cool'])).toEqual(['x', 'x_2'])
    expect(stemsOf(['/d/Sample.cool', '/d/sample.cool'])).toEqual(['Sample', 'sample_2'])
    expect(stemsOf(['/d/a/x.cool', '/d/a/x.cool', '/d/b/x.cool'])).toEqual(['a_x', 'a_x_2', 'b_x'])
    // An address, by its path's directories and with its query left off.
    expect(
      stemsOf(['https://data.org/run1/s.mcool?sig=1', 'https://data.org/run2/s.mcool?sig=2']),
    ).toEqual(['run1_s', 'run2_s'])
    expect(stemOf('https://data.org/run1/s.mcool?sig=1::/resolutions/1000')).toBe('s_1000')
  })
})

/**
 * A file named by its address (§23.1). The README said a remote file is
 * fetched first, and the command handed the address to `stat` instead: *cannot
 * stat /cwd/https:/example.org/x.cool*. Served here by a server of the test's
 * own on the loopback, so nothing leaves the machine.
 */
describe('a file named by its address', () => {
  let server: Server
  let base = ''
  let served = ''
  const asked: Array<{ path: string; encoding: string | undefined }> = []
  /** Where downloads are to go, looked into while a request is being answered. */
  let watched: string | null = null
  let seen: string[] = []

  beforeAll(async () => {
    served = join(directory, 'served')
    await mkdir(served, { recursive: true })
    await writeFile(join(served, 'sample.hic'), await readFile(sample))
    // A reference with the `.fai` `samtools faidx` writes beside it, unwrapped.
    const fasta = `>chrI\n${'GC'.repeat(60_000)}\n>chrII\n${'AT'.repeat(30_000)}\n`
    await writeFile(join(served, 'genome.fa'), fasta)
    await writeFile(
      join(served, 'genome.fa.fai'),
      `chrI\t120000\t6\t120000\t120001\nchrII\t60000\t${6 + 120_001 + 7}\t60000\t60001\n`,
    )
    const rows = ['## pairs format v1.0', '#chromsize: chrI 120000', '#chromsize: chrII 60000',
      '#columns: readID chrom1 pos1 chrom2 pos2 strand1 strand2']
    for (let i = 0; i < 400; i++) {
      const pos1 = 1 + ((i * 271) % 110_000)
      const pos2 = Math.min(120_000, pos1 + 500 + ((i * 37) % 20_000))
      rows.push(`r${i}\tchrI\t${pos1}\tchrI\t${pos2}\t${'+-'[i % 2]}\t${'+-'[(i >> 1) % 2]}`)
    }
    await writeFile(join(served, 'named.pairs'), `${rows.join('\n')}\n`)

    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const encoding = request.headers['accept-encoding']
      asked.push({ path: url.pathname, encoding: Array.isArray(encoding) ? encoding.join(',') : encoding })
      if (watched !== null) seen = readdirSync(watched)
      readFile(join(served, decodeURIComponent(url.pathname.replace(/^\/data\//, '')))).then(
        (bytes) => {
          response.writeHead(200, { 'content-length': bytes.length })
          response.end(bytes)
        },
        () => {
          response.writeHead(404, 'Not Found')
          response.end()
        },
      )
    })
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/data`
  })

  afterAll(async () => {
    await new Promise<void>((closed) => server.close(() => closed()))
  })

  it('fetches a map named by its address, and names its outputs and its record after it', async () => {
    reset()
    const where = join(directory, 'remote-map')
    const address = `${base}/sample.hic?token=abc`
    expect(await main(['coverage', address, '--out', where, '--quiet']), complained()).toBe(0)
    const files = await readdir(where)
    expect(files).toContain('sample.coverage.coverage-total.tsv')
    const text = await readFile(join(where, 'sample.coverage.coverage-total.tsv'), 'utf8')
    // The address the reader typed, not the temporary copy it was read from.
    expect(text.split('\n')).toContain(`# file: ${address}`)
    // The bytes as the file holds them, never a compressed rendering of them.
    expect(asked.find((request) => request.path === '/data/sample.hic')?.encoding).toBe('identity')
  })

  it('says how far a download has got, and leaves nothing behind', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'chromosomix-tmpdir-'))
    const before = process.env.TMPDIR
    process.env.TMPDIR = scratch
    watched = scratch
    try {
      reset()
      const where = join(directory, 'remote-progress')
      expect(await main(['coverage', `${base}/sample.hic`, '--out', where])).toBe(0)
      expect(complained()).toMatch(/downloading sample\.hic: \d+% of \d+ kB/)
      expect(complained()).toMatch(/downloaded sample\.hic, \d+ kB/)
      // Into $TMPDIR while it was read, and gone once the command had ended.
      expect(seen.some((name) => name.startsWith('chromosomix-'))).toBe(true)
      expect(await readdir(scratch)).toEqual([])
    } finally {
      watched = null
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('names an address it could not fetch, and carries on past it', async () => {
    reset()
    const where = join(directory, 'remote-missing')
    const signed = `${base}/absent.hic?X-Amz-Signature=secret`
    expect(await main(['coverage', signed, sample, '--out', where, '--quiet'])).toBe(1)
    expect(complained()).toMatch(/failed: http:\/\/127\.0\.0\.1:\d+\/data\/absent\.hic\?… answered 404/)
    // A presigned link's query is its signature, and stays out of the log.
    expect(complained()).not.toMatch(/secret/)
    expect(await readdir(where)).toContain('sample.coverage.coverage-total.tsv')
  })

  it('fetches a reference with the index beside it, before any map, or refuses the command', async () => {
    reset()
    const where = join(directory, 'remote-reference')
    expect(await main(['composition', '--sequence', `${base}/genome.fa`, '--out', where, '--quiet'])).toBe(0)
    expect(asked.map((request) => request.path)).toContain('/data/genome.fa.fai')
    expect(await rowsIn(join(where, 'genome.composition.composition-gc.bedGraph'))).toHaveLength(12 + 6)
    // What every run reads is fetched before the first, so an address that
    // cannot be had is a fault in the command: exit 2, and no file opened.
    reset()
    expect(
      await main(['motif', sample, '--sequence', `${base}/absent.fa`, '--pattern', 'GGTCA', '--quiet']),
    ).toBe(2)
    expect(complained()).toMatch(/absent\.fa answered 404/)
    expect(complained()).not.toMatch(/failed:/)
  })

  it('compares a map with one named by its address', async () => {
    reset()
    const where = join(directory, 'remote-against')
    expect(
      await main(['hicrep', sample, '--against', `${base}/sample.hic`, '--out', where, '--quiet']),
      complained(),
    ).toBe(0)
    const text = await readFile(join(where, 'sample.hicrep.hicrep-pairs.tsv'), 'utf8')
    expect(text).toMatch(/sample\.hic\tsample\.hic\t/)
  })

  it('reads the orientations of a .pairs named by its address', async () => {
    reset()
    const where = join(directory, 'remote-stranded')
    const named = `${base}/named.pairs`
    expect(
      await main(['expected', sample, '--stranded', '--pairsUri', named, '--out', where, '--quiet']),
    ).toBe(0)
    expect(complained()).not.toMatch(/needs a venue that can fetch an address/)
    expect(await readdir(where)).toContain('sample.expected.ps-orientation.tsv')
  })

  it('refuses an address by a scheme it does not fetch, by name', async () => {
    reset()
    const where = join(directory, 'remote-s3')
    expect(await main(['coverage', 's3://bucket/x.cool', '--out', where, '--quiet'])).toBe(1)
    expect(complained()).toMatch(/fetches http and https addresses, and s3:\/\/ is neither/)
  })
})

/**
 * The console's lines, read back by the parser that has to take them (§23.1).
 * The builder writes a switch as itself or as `--key=false`, which is the one
 * spelling a typed parser and the untyped one before it both read the same way.
 */
describe('the console’s lines, read back', () => {
  /** A line split as a POSIX shell splits what `quote` writes. */
  function words(line: string): string[] {
    const out: string[] = []
    let word = ''
    let started = false
    let quoted = false
    for (let at = 0; at < line.length; at++) {
      const char = line[at]
      if (quoted) {
        if (char === "'") quoted = false
        else word += char
      } else if (char === "'") {
        quoted = true
        started = true
      } else if (char === '\\') {
        at += 1
        word += line[at]
        started = true
      } else if (char === ' ') {
        if (started) out.push(word)
        word = ''
        started = false
      } else {
        word += char
        started = true
      }
    }
    if (started) out.push(word)
    return out
  }

  const context: AnalysisContext = {
    uri: 'sample.hic',
    layout: 'cool',
    hasMap: true,
    hasGenomes: false,
    hasWeights: true,
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

  it('reads every task’s line with every switch as it was recorded, on or off', () => {
    for (const task of TASKS) {
      // Each switch the other way from its default, so both spellings are written.
      const params: Record<string, Params[string]> = {}
      for (const spec of task.params) {
        const fallback = (spec as { default?: unknown }).default
        if (fallback === undefined) continue
        params[spec.key] =
          spec.kind === 'toggle' && !paramDerived(spec) ? !fallback : (fallback as Params[string])
      }
      const line =
        cliCommandFor({
          task,
          provenance: {
            task: task.id,
            taskVersion: 1,
            params,
            framing: {
              uri: 'sample.hic',
              rows: [0, 180],
              cols: [0, 180],
              binsize: 1000,
              binsPerCell: 1,
              balance: true,
              value: 'count',
              normalise: null,
              level: 'bin',
              label: 'whole file at 1000 bp',
            },
            app: 'test',
            createdAt: '2026-10-11T00:00:00Z',
          },
          context,
        })
          .text.split('\n')
          .find((row) => !row.startsWith('#')) ?? ''
      const parsed = parseCommandLine(words(line).slice(1))
      expect(parsed.command, line).toBe(task.id)
      expect(parsed.positional, line).toEqual(['sample.hic'])
      for (const spec of task.params) {
        if (spec.kind !== 'toggle' || paramDerived(spec)) continue
        expect(parsed.flags.get(spec.key)?.at(-1), `${task.id} --${spec.key}`).toBe(
          String(params[spec.key]),
        )
      }
    }
  })
})
