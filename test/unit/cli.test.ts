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

import { main, recordedTasks, stemOf } from '@/cli/main'
import { writeHic, type HicRecord } from '../support/hicWriter'

let directory = ''
let sample = ''
let out = ''
const written: string[] = []
const errors: string[] = []

function records(nx: number, ny: number, intra: boolean, seed: number): HicRecord[] {
  const list: HicRecord[] = []
  for (let x = 0; x < nx; x++) {
    for (let y = intra ? x : 0; y < ny; y++) {
      if ((x * 7 + y * 3 + seed) % 5 !== 0) continue
      list.push({ x, y, value: Math.max(1, Math.round(100 / (1 + Math.abs(x - y)))) })
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

  it('narrows to a window, and says so in the framing', async () => {
    reset()
    expect(
      await main(['expected', sample, '--out', out, '--quiet', '--window', 'chrI:0-50000']),
    ).toBe(0)
    const text = await readFile(join(out, 'sample.expected.ps.tsv'), 'utf8')
    expect(text).toMatch(/^# framing: chrI:0-50000 at 1000 bp/m)
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
 * Four tasks declare `venue: 'annotations'`, and the command used to dispatch
 * through `RUNNERS` alone — so `tasks` listed all sixteen with a flag apiece and
 * `run` died on four of them with *no analysis runner is registered*, after the
 * mount and once per file. Two of the four need only what a shell already has,
 * and these pin that they now run; the two that read a bigWig are refused before
 * anything is opened, and these pin that the refusal is what the listing says
 * too. A batch script is written from `tasks`, so the listing and the dispatch
 * disagreeing is the bug, not a cosmetic one.
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

  it('refuses a task that reads a track before it opens anything', async () => {
    reset()
    // A path that does not exist: reaching the filesystem at all would report
    // that instead, so the exit code and the sentence together are the proof
    // that nothing was mounted.
    expect(await main(['metaplot', join(directory, 'absent.cool'), '--out', out])).toBe(2)
    expect(complained()).toMatch(/metaplot reads a track \(--tracks\)/)
    expect(complained()).toMatch(/Run it in the app/)
    expect(complained()).not.toMatch(/failed:/)
  })

  it('lists a task it cannot run without advertising its flags', async () => {
    reset()
    expect(await main(['tasks'])).toBe(0)
    const text = said()
    // The row stays, so the reader still learns the task exists.
    expect(text).toMatch(/^metaplot$/m)
    expect(text).toMatch(/^trackcorr$/m)
    expect(text).toMatch(/trackcorr reads a track \(--tracks\)/)
    // The flags go. `--tracks` in a listing is a flag somebody writes into a
    // batch script and finds out about after the first file is mounted.
    expect(text).not.toMatch(/--tracks /)
    expect(text).not.toMatch(/--heatmap/)
    // The two that do run keep theirs.
    expect(text).toMatch(/--sequence {2}Reference/)
    expect(text).toMatch(/--minFraction/)
  })

  it('skips a replayed task it cannot run, with the reason', async () => {
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
            tracks: [],
            manual: [],
            bookmarks: [],
            analysis: { trackcorr: { tracks: ['a1'], method: 'spearman' } },
          },
        ],
      }),
    )
    // Exit 0, not 1: a workspace that recorded a track correlation recorded
    // something real, and a replay that cannot run it here has failed at
    // nothing — it is the venue that is missing, not the tab that is wrong.
    expect(await main(['replay', path, '--over', sample, '--out', join(directory, 'r4')])).toBe(0)
    expect(complained()).toMatch(/skipped trackcorr: trackcorr reads a track/)
    expect(complained()).not.toMatch(/no analysis runner is registered/)
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
  })
})
