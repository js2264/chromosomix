/**
 * One tab of a `metacooler-plot` run, from its load to its last file, against a
 * page that answers as the harness would (§27.1, §27.5).
 *
 * The browser is the one part left out, and on purpose: what is asserted here
 * is the command's side of the conversation — what it asks for in which order,
 * what each file is called, what it prints, and what it counts as a failure.
 * The end-to-end suite (`plot-e2e.test.ts`) drives the same code through a real
 * Chromium where there is one.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CdpPage } from '@/cli/cdp'
import { optionsOf, parseFlags, planJobs, Run, type Tally } from '@/cli/plot'
import { PlotServer } from '@/cli/serve'
import { PLOT_PROTOCOL, type BlobRef, type RunReport, type TabReport, type WireRequest } from '@/plot/protocol'
import type { RecordedTask } from '@/plot/types'
import { isRefusal } from '@/state/SessionConfig'
import { parseWorkspaceFile } from '@/state/workspace'

/** What the fake window holds and says; each test sets what it needs. */
interface Window {
  failure: string | null
  figureKind: TabReport['figure']
  bookmarks: TabReport['bookmarks']
  structures: TabReport['structures']
  /** Said in the notice slot, taken by the next description. */
  notices: string[]
  refuse: Record<string, string>
  recorded: RecordedTask[] | null
  runs: Record<string, RunReport>
  asked: string[]
}

function freshWindow(): Window {
  return {
    failure: null,
    figureKind: { kind: 'map' },
    bookmarks: [],
    structures: [],
    notices: [],
    refuse: {},
    recorded: null,
    runs: {},
    asked: [],
  }
}

/** A page whose `window.metacoolerPlot` is this fake, reached through `call` as the real one is. */
function fakePage(window: Window): CdpPage {
  const held = new Map<string, Buffer>()
  let next = 1
  const hold = (bytes: string, request: WireRequest): BlobRef => {
    const ref = `b${next++}`
    held.set(ref, Buffer.from(`${bytes}:${request.format}:${request.dpi}`))
    return { ref, size: held.get(ref)?.length ?? 0, type: request.format === 'pdf' ? 'application/pdf' : 'image/png' }
  }
  const harness: Record<string, (...args: never[]) => unknown> = {
    configure: () => undefined,
    open: () => null,
    settle: () => ({ ms: 1 }),
    describe: (): TabReport => ({
      index: 0,
      count: 1,
      label: 'a tab',
      view: 'region',
      uri: 'http://127.0.0.1/t/0/Yeast_microC_G2M_1kb.cool',
      failure: window.failure,
      figure: window.figureKind,
      bookmarks: window.bookmarks,
      structures: window.structures,
      notices: window.notices.splice(0),
    }),
    figure: (request: WireRequest) => hold('figure', request),
    goToLocus: (locus: string) => window.refuse[locus] ?? null,
    goToBookmark: () => undefined,
    structureFigure: (index: number, request: WireRequest) => hold(`structure${index}`, request),
    analyses: () => window.recorded,
    runAnalysis: (task: string) => window.runs[task] ?? { status: 'failed', message: 'no such run' },
    analysisFigure: (task: string, index: number, request: WireRequest) => hold(`${task}${index}`, request),
    closeAnalysis: () => undefined,
    read: (ref: string, offset: number, length: number) =>
      (held.get(ref) ?? Buffer.alloc(0)).subarray(offset, offset + length).toString('base64'),
    drop: (ref: string) => held.delete(ref),
  }
  const page = {
    on: () => () => undefined,
    send: async () => ({}),
    evaluate: async () => ({ protocol: PLOT_PROTOCOL, build: { producer: 'test', commit: '' } }),
    call: async (_target: string, method: string, ...args: unknown[]) => {
      window.asked.push(method)
      const answer = harness[method]
      if (answer === undefined) throw new Error(`the fake harness has no ${method}`)
      return (answer as (...args: unknown[]) => unknown)(...args)
    },
  }
  return page as unknown as CdpPage
}

const demo = (() => {
  const read = parseWorkspaceFile(readFileSync('demo/yeast/Yeast_microC.metacooler.json', 'utf8'))
  if (isRefusal(read)) throw new Error('the demo workspace no longer parses')
  return read
})()

let out = ''
const printed: string[] = []
const said: string[] = []

beforeAll(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    said.push(String(chunk))
    return true
  })
})

afterAll(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  printed.length = 0
  said.length = 0
  if (out !== '') rmSync(out, { recursive: true, force: true })
  out = mkdtempSync(join(tmpdir(), 'metacooler-plot-run-'))
})

async function run(window: Window, argv: string[] = [], regions: string[] = []): Promise<Tally> {
  const options = optionsOf(parseFlags(['-o', out, ...argv]))
  const tally: Tally = { written: [], failures: 0 }
  const server = new PlotServer({ kind: 'dir', path: out })
  const browser = { openPage: async () => ({ page: fakePage(window), close: async () => undefined }) }
  const runner = new Run(browser, server, options, { kind: 'dir', path: 'demo/yeast' }, regions, tally)
  const [job] = planJobs(demo.tabs, demo.active, options)
  await runner.job(job, 0, 1)
  return tally
}

const stderr = (): string => said.join('')

describe('one tab of a run', () => {
  it('saves the tab’s figure in each format asked, and prints only the paths on stdout', async () => {
    const tally = await run(freshWindow(), ['--format', 'png,pdf', '--dpi', '150'])
    const files = ['Yeast_microC_G2M_1kb.png', 'Yeast_microC_G2M_1kb.pdf'].map((name) => join(out, name))
    expect(tally).toEqual({ written: files, failures: 0 })
    expect(printed.join('')).toBe(`${files.join('\n')}\n`)
    // The bytes are the page's own, read back whole.
    expect(readFileSync(files[1], 'utf8')).toBe('figure:pdf:150')
  })

  // The notice most worth reading is the one the load raised, and the first
  // description is the one that takes it from the window.
  it('prints what the window said while the tab loaded, under the tab', async () => {
    const window = freshWindow()
    window.notices.push('A track was left out: gone.bw could not be read.')
    await run(window)
    expect(stderr()).toMatch(
      /\[1\/1\] Yeast_microC_G2M_1kb\.cool\n {2}region view of Yeast_microC_G2M_1kb\.cool\n {2}note: A track was left out: gone\.bw could not be read\.\n/,
    )
  })

  it('reports a tab that would not open, with what the window said, and writes nothing for it', async () => {
    const window = freshWindow()
    window.failure = 'This is not an HDF5 file.'
    window.notices.push('The session has opened; the numbers in it are this file’s.')
    const tally = await run(window)
    expect(tally).toEqual({ written: [], failures: 1 })
    expect(stderr()).toMatch(/note: The session has opened.*\n {2}failed: This is not an HDF5 file\.\n/)
    expect(window.asked).not.toContain('figure')
  })

  it('says so, and fails nothing, when the view has no figure to save', async () => {
    const window = freshWindow()
    window.figureKind = { kind: null, why: 'the genomes table is not a figure' }
    const tally = await run(window)
    expect(tally).toEqual({ written: [], failures: 0 })
    expect(stderr()).toContain('no figure: the genomes table is not a figure')
  })

  it('names a locus’s figure after the locus, and counts a locus the tab refuses as a failure', async () => {
    const window = freshWindow()
    window.refuse['nowhere:1-2'] = 'nowhere is not a sequence of this file'
    const tally = await run(window, [], ['IV:1100000-1300000', 'nowhere:1-2', 'XV'])
    expect(tally.written.map((path) => path.slice(out.length + 1))).toEqual([
      'Yeast_microC_G2M_1kb.png',
      'Yeast_microC_G2M_1kb.IV_1100000-1300000.png',
      'Yeast_microC_G2M_1kb.XV.png',
    ])
    expect(tally.failures).toBe(1)
    expect(stderr()).toContain('nowhere:1-2: nowhere is not a sequence of this file')
  })

  it('names each bookmark’s figure by its place in the list and its label', async () => {
    const window = freshWindow()
    window.bookmarks = [
      { label: 'loop cluster', locus: 'IV:1150000-1250000' },
      { label: '', locus: 'IV:400000-600000' },
    ]
    const tally = await run(window, ['--bookmarks', '--no-main'])
    expect(tally.written.map((path) => path.slice(out.length + 1))).toEqual([
      'Yeast_microC_G2M_1kb.bookmark-1-loop_cluster.png',
      'Yeast_microC_G2M_1kb.bookmark-2.png',
    ])
  })

  it('runs every recorded task before the tab’s figure, and names each figure by task and output', async () => {
    const window = freshWindow()
    window.recorded = [
      { id: 'expected', title: 'P(s)', state: 'ready' },
      { id: 'apa', title: 'APA', state: 'waiting', needs: 'Load a loop set (BEDPE).' },
      { id: 'gone', title: 'gone', state: 'unknown' },
    ]
    window.runs['expected'] = {
      status: 'done',
      notes: ['sampled every sequence'],
      figures: [
        { index: 0, output: 'ps', label: 'P(s)', drawable: true },
        { index: 1, output: 'table', label: 'Per sequence', drawable: false },
      ],
    }
    const tally = await run(window, ['--analysis'])
    expect(tally.written.map((path) => path.slice(out.length + 1))).toEqual([
      'Yeast_microC_G2M_1kb.expected.ps.png',
      'Yeast_microC_G2M_1kb.png',
    ])
    expect(tally.failures).toBe(0)
    const lines = stderr()
    expect(lines).toContain('skipped apa: Load a loop set (BEDPE).')
    expect(lines).toContain('skipped gone: this build has no such task')
    expect(lines).toContain('note: sampled every sequence')
    expect(lines).toContain('Per sequence is a table rather than a figure; metacooler-run writes it as TSV')
    // The drawer is shut before the tab's own figure is taken.
    expect(window.asked.indexOf('closeAnalysis')).toBeLessThan(window.asked.lastIndexOf('figure'))
  })

  it('counts a task that failed, and carries on to the next', async () => {
    const window = freshWindow()
    window.recorded = [
      { id: 'insulation', title: 'Insulation', state: 'ready' },
      { id: 'expected', title: 'P(s)', state: 'ready' },
    ]
    window.runs['insulation'] = { status: 'failed', message: 'the worker ran out of memory' }
    window.runs['expected'] = { status: 'done', figures: [{ index: 0, output: 'ps', label: 'P(s)', drawable: true }] }
    const tally = await run(window, ['--analysis', '--no-main'])
    expect(tally.failures).toBe(1)
    expect(tally.written.map((path) => path.slice(out.length + 1))).toEqual(['Yeast_microC_G2M_1kb.expected.ps.png'])
    expect(stderr()).toContain('insulation failed: the worker ran out of memory')
  })

  it('saves each structure cell under its label', async () => {
    const window = freshWindow()
    window.structures = [{ label: 'Yeast structure' }]
    const tally = await run(window, ['--structures', '--no-main'])
    expect(tally.written.map((path) => path.slice(out.length + 1))).toEqual([
      'Yeast_microC_G2M_1kb.structure-1-Yeast_structure.png',
    ])
    expect(readdirSync(out)).toEqual(['Yeast_microC_G2M_1kb.structure-1-Yeast_structure.png'])
  })
})
