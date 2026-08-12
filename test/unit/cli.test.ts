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

describe('replaying a session', () => {
  const sessionAt = async (analysis: unknown): Promise<string> => {
    const path = join(directory, 'session.metacooler.json')
    await writeFile(
      path,
      JSON.stringify({
        kind: 'metacooler.session',
        version: 1,
        createdAt: '2026-08-12T00:00:00.000Z',
        state: { uri: 'sample.hic', view: 'contigs' },
        tracks: [],
        manual: [],
        bookmarks: [],
        analysis,
      }),
    )
    return path
  }

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
    expect(complained()).toMatch(/2 tasks from session\.metacooler\.json, over 1 file/)
  })

  it('names a task this build does not have rather than skipping in silence', async () => {
    reset()
    const path = await sessionAt({ notATask: { x: 1 } })
    await main(['replay', path, '--over', sample, '--out', join(directory, 'r3'), '--quiet'])
    // The count said one would run; this is why it did not.
    expect(complained()).toMatch(/skipped notATask: this build has no such task/)
  })

  it('refuses a file that is not a session', async () => {
    reset()
    const path = join(directory, 'nope.json')
    await writeFile(path, '{"hello":"world"}')
    expect(await main(['replay', path, '--over', sample])).toBe(2)
    expect(complained()).toMatch(/not a metacooler session file/)
  })

  it('refuses a session that recorded no analysis', async () => {
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
