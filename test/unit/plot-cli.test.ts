/**
 * `metacooler-plot`'s command line, and the plan it makes, without a browser.
 *
 * Everything that can be wrong with a command is found before a browser is
 * started (§27.2), so the parts asserted here are the ones that decide whether
 * an hour-long batch runs as written: a flag that is misspelt, a value that is
 * missing, a switch that swallowed the workspace's name, two tabs that would
 * write one file, a `--over` that plotted every tab of the window over every
 * file instead of the one in front.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { main, missingFiles, optionsOf, parseFlags, planJobs, regionsOfBed, viewerOf } from '@/cli/plot'
import type { SessionConfig } from '@/state/SessionConfig'
import { isRefusal } from '@/state/SessionConfig'
import { parseWorkspaceFile } from '@/state/workspace'

function options(argv: string[]): ReturnType<typeof optionsOf> {
  return optionsOf(parseFlags(argv))
}

function demoTabs(): SessionConfig[] {
  const read = parseWorkspaceFile(readFileSync('demo/yeast/Yeast_deck.metacooler.json', 'utf8'))
  if (isRefusal(read)) throw new Error('the demo deck no longer parses')
  const tab = read.tabs[0]
  const unnamed = structuredClone(tab)
  delete unnamed.name
  return [tab, unnamed, { ...structuredClone(unnamed), state: { ...unnamed.state, uri: 'Yeast_hic.hic' } }]
}

describe('parseFlags', () => {
  it('reads values, switches and the workspace in any order', () => {
    const args = parseFlags(['--analysis', 'w.metacooler.json', '-o', 'out', '--dpi=600', '--format', 'png,pdf'])
    expect(args.positional).toEqual(['w.metacooler.json'])
    expect(args.switches.get('analysis')).toBe(true)
    expect(args.values.get('out')).toEqual(['out'])
    expect(args.values.get('dpi')).toEqual(['600'])
    expect(args.values.get('format')).toEqual(['png', 'pdf'])
  })

  it('collects a list from repeats and from commas alike', () => {
    const args = parseFlags(['--region', 'IV:1-2', '--region', 'XV', '--tab', '1,3'])
    expect(args.values.get('region')).toEqual(['IV:1-2', 'XV'])
    expect(args.values.get('tab')).toEqual(['1', '3'])
  })

  it('turns a switch off with --no-, or with a false value', () => {
    expect(parseFlags(['--no-caption']).switches.get('caption')).toBe(false)
    expect(parseFlags(['--caption=false']).switches.get('caption')).toBe(false)
    expect(parseFlags(['--caption=off']).switches.get('caption')).toBe(false)
    expect(parseFlags(['--caption=yes']).switches.get('caption')).toBe(true)
    expect(() => parseFlags(['--no-caption=true'])).toThrow(/takes no value/)
  })

  // `--dpi300` must not run for an hour at the default.
  it('refuses a flag it does not know, and suggests the one meant', () => {
    expect(() => parseFlags(['--lsit'])).toThrow('metacooler-plot has no flag --lsit. Did you mean --list?')
    expect(() => parseFlags(['--dpi300'])).toThrow(/has no flag --dpi300/)
    expect(() => parseFlags(['--zzzzzzzzzz'])).toThrow(/Try --help/)
    expect(() => parseFlags(['-x'])).toThrow(/has no flag -x/)
    expect(() => parseFlags(['--no-dpi'])).toThrow(/has no flag --no-dpi/)
  })

  it('refuses a value that is missing, rather than taking the next flag as it', () => {
    expect(() => parseFlags(['--out'])).toThrow('--out needs a value.')
    expect(() => parseFlags(['--out', '--analysis'])).toThrow('--out needs a value.')
  })

  it('takes everything after -- as a name, and a single dash as one', () => {
    expect(parseFlags(['--', '--odd-name.json']).positional).toEqual(['--odd-name.json'])
    expect(parseFlags(['-']).positional).toEqual(['-'])
  })
})

describe('optionsOf', () => {
  it('defaults to one PNG of each tab at 300 dpi, light, at the app’s own text size', () => {
    const chosen = options(['w.json'])
    expect(chosen).toMatchObject({
      out: '.',
      tabs: null,
      formats: ['png'],
      dpi: 300,
      caption: true,
      theme: 'light',
      textScale: 1.35,
      viewport: { width: 1600, height: 1000 },
      main: true,
      analysis: false,
      tasks: null,
      structures: false,
      bookmarks: false,
      pairs: null,
      scool: 'fine',
      allowMissing: false,
      timeoutMs: 600_000,
    })
  })

  it('reads every value it is given', () => {
    const chosen = options([
      '--format', 'PDF,png,pdf',
      '--tab', '2',
      '--viewport', '1200x800',
      '--theme', 'dark',
      '--text-scale', '1',
      '--bin-size', '5000',
      '--rungs', '3',
      '--scool', 'whole',
      '--timeout', '30',
      '--no-main',
    ])
    expect(chosen.formats).toEqual(['pdf', 'png'])
    expect(chosen.tabs).toEqual([1])
    expect(chosen.viewport).toEqual({ width: 1200, height: 800 })
    expect(chosen.theme).toBe('dark')
    expect(chosen.textScale).toBe(1)
    expect(chosen.pairs).toEqual({ base: 5000, rungs: 3 })
    expect(chosen.scool).toBe('whole')
    expect(chosen.timeoutMs).toBe(30_000)
    expect(chosen.main).toBe(false)
  })

  it('runs the analyses when it is told which ones', () => {
    const chosen = options(['--tasks', 'expected,insulation'])
    expect(chosen.analysis).toBe(true)
    expect(chosen.tasks).toEqual(['expected', 'insulation'])
  })

  it('says in one sentence which value is wrong', () => {
    expect(() => options(['--format', 'svg'])).toThrow(/--format takes png or pdf/)
    expect(() => options(['--dpi', '10'])).toThrow(/--dpi needs a resolution from 24 to 1200 dpi; got "10"/)
    expect(() => options(['--dpi', 'high'])).toThrow(/--dpi needs/)
    expect(() => options(['--tab', '0'])).toThrow(/--tab takes tab numbers counted from 1/)
    expect(() => options(['--theme', 'blue'])).toThrow(/--theme is light or dark/)
    expect(() => options(['--viewport', '100x100'])).toThrow(/--viewport is a window size/)
    expect(() => options(['--text-scale', '1.2'])).toThrow(/--text-scale needs one of the text sizes/)
    expect(() => options(['--scool', 'all'])).toThrow(/--scool is pieces or whole/)
    expect(() => options(['--bin-size', '0'])).toThrow(/--bin-size needs a bin size/)
    expect(() => options(['--bin-size', '1000', '--rungs', '20'])).toThrow(/--rungs needs/)
    expect(() => options(['--timeout', '-1'])).toThrow(/--timeout needs/)
  })
})

describe('planJobs', () => {
  it('plots every tab by default, each named after itself', () => {
    const jobs = planJobs(demoTabs(), 0, { tabs: null, over: [] })
    expect(jobs.map((job) => [job.tab, job.stem, job.label])).toEqual([
      [0, 'micro-C_vs_Hi-C', 'micro-C vs Hi-C'],
      [1, 'Yeast_microC_G2M_1kb', 'Yeast_microC_G2M_1kb.cool'],
      [2, 'Yeast_hic', 'Yeast_hic.hic'],
    ])
    expect(jobs.every((job) => job.over === null)).toBe(true)
  })

  it('plots the tabs asked for, and refuses one the workspace has not got', () => {
    expect(planJobs(demoTabs(), 0, { tabs: [2], over: [] }).map((job) => job.tab)).toEqual([2])
    expect(() => planJobs(demoTabs(), 0, { tabs: [5], over: [] })).toThrow(
      'the workspace holds 3 tabs; --tab 6 is not one of them.',
    )
  })

  // `replay --over`'s rule: a whole window applied to each of two hundred
  // files is rarely what anybody means.
  it('applies the tab in front to each --over file, named after that file', () => {
    const jobs = planJobs(demoTabs(), 1, { tabs: null, over: ['runs/a.cool', 'runs/b.cool'] })
    expect(jobs.map((job) => [job.tab, job.over, job.stem])).toEqual([
      [1, 'runs/a.cool', 'a'],
      [1, 'runs/b.cool', 'b'],
    ])
    expect(jobs[0].config.state.uri).toBe('runs/a.cool')
    // The line printed for it is still the tab the reader knows.
    expect(jobs[0].label).toBe('Yeast_microC_G2M_1kb.cool')
  })

  it('tells two tabs over one file apart, and never writes two jobs to one name', () => {
    const jobs = planJobs(demoTabs(), 0, { tabs: [0, 1], over: ['a.cool'] })
    expect(jobs.map((job) => job.stem)).toEqual(['a-tab1', 'a-tab2'])
    // The same file named twice is two jobs and two sets of files.
    const twice = planJobs(demoTabs(), 0, { tabs: null, over: ['x/a.cool', 'y/a.cool'] })
    expect(twice.map((job) => job.stem)).toEqual(['a', 'a-2'])
  })
})

describe('regionsOfBed', () => {
  it('reads a locus per row, 0-based as the rows are, and skips what is not a row', () => {
    const bed = [
      'track name=loops',
      'browser position IV:1-2',
      '# a comment',
      '',
      'IV\t1000000\t1400000\tname\t0\t+',
      'XV\t0\t500000\r',
      'broken\tx\t12',
      'short\t12',
    ].join('\n')
    expect(regionsOfBed(bed)).toEqual(['IV:1000000-1400000', 'XV:0-500000'])
  })
})

describe('missingFiles', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'metacooler-plot-missing-'))
    writeFileSync(join(dir, 'Yeast_microC_G2M_1kb.cool'), 'x')
    writeFileSync(join(dir, 'Yeast_hic.hic'), 'x')
    writeFileSync(join(dir, 'Yeast_annotations.gtf'), 'x')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('names every file a job cannot find, and what it was for, before anything starts', () => {
    const jobs = planJobs(demoTabs().slice(0, 1), 0, { tabs: null, over: [] })
    const absent = missingFiles(jobs, { kind: 'dir', path: dir }, [])
    expect(absent).toHaveLength(1)
    expect(absent[0].missing).toEqual([{ name: 'Yeast_ATAC.bw', role: 'the track "ATAC"' }])
    writeFileSync(join(dir, 'Yeast_ATAC.bw'), 'x')
    expect(missingFiles(jobs, { kind: 'dir', path: dir }, [])).toEqual([])
  })
})

describe('viewerOf', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'metacooler-plot-viewer-'))
    mkdirSync(join(dir, 'built'))
    writeFileSync(join(dir, 'built', 'index.html'), '<!doctype html>')
    mkdirSync(join(dir, 'empty'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('serves a built directory, relays a running one, and refuses a folder that is neither', () => {
    expect(viewerOf(join(dir, 'built'), {})).toEqual({ kind: 'dir', path: join(dir, 'built') })
    expect(viewerOf('http://127.0.0.1:5173/', {})).toEqual({ kind: 'url', url: 'http://127.0.0.1:5173/' })
    expect(viewerOf(join(dir, 'empty'), {})).toMatch(/is not a built viewer/)
  })

  it('reads METACOOLER_VIEWER when no flag names one', () => {
    expect(viewerOf(undefined, { METACOOLER_VIEWER: join(dir, 'built') })).toEqual({ kind: 'dir', path: join(dir, 'built') })
  })
})

describe('main, up to the browser', () => {
  let dir = ''
  const out: string[] = []
  const err: string[] = []
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'metacooler-plot-main-'))
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk))
      return true
    })
  })
  afterAll(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })
  const run = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    out.length = 0
    err.length = 0
    const code = await main(argv)
    return { code, out: out.join(''), err: err.join('') }
  }

  it('prints its usage with nothing to do, and exits cleanly', async () => {
    const { code, out: printed } = await run([])
    expect(code).toBe(0)
    expect(printed).toMatch(/^metacooler-plot — every figure a saved workspace shows/)
    expect((await run(['--help'])).code).toBe(0)
  })

  it('is exit 2 and one sentence for a command that is wrong', async () => {
    expect(await run(['--lsit'])).toMatchObject({ code: 2, err: expect.stringMatching(/Did you mean --list\?/) })
    expect(await run(['a.json', 'b.json'])).toMatchObject({ code: 2, err: expect.stringMatching(/one workspace at a time/) })
    expect(await run([join(dir, 'nope.json')])).toMatchObject({ code: 2, err: expect.stringMatching(/could not be read/) })
    writeFileSync(join(dir, 'bad.json'), '{"kind": "something else"}')
    expect((await run([join(dir, 'bad.json')])).code).toBe(2)
    expect(await run(['demo/yeast/Yeast_deck.metacooler.json', '--data', join(dir, 'nope')])).toMatchObject({
      code: 2,
      err: expect.stringMatching(/is not a directory/),
    })
  })

  it('refuses a workspace whose files are missing, and says where it looked', async () => {
    writeFileSync(
      join(dir, 'moved.metacooler.json'),
      readFileSync('demo/yeast/Yeast_tracks.metacooler.json', 'utf8'),
    )
    const { code, err: said } = await run([join(dir, 'moved.metacooler.json')])
    expect(code).toBe(2)
    expect(said).toMatch(/was not found/)
    expect(said).toMatch(/--data <dir>/)
  })

  // A path on the command line is the shell's, and a glob that matches nothing
  // is a mistyped one.
  it('reads --over relative to here, expands a glob, and refuses one that names nothing', async () => {
    const listed = await run(['demo/yeast/Yeast_microC.metacooler.json', '--over', 'demo/yeast/*.hic', '--list'])
    expect(listed.code).toBe(0)
    expect(listed.out).toContain(`over ${resolve('demo/yeast/Yeast_hic.hic')}`)
    expect(listed.out).toMatch(/writes .*Yeast_hic\.\{png\}/)
    expect(await run(['demo/yeast/Yeast_microC.metacooler.json', '--over', 'nowhere/*.cool'])).toMatchObject({
      code: 2,
      err: '--over nowhere/*.cool names no file.\n',
    })
    // Unquoted, the shell hands the second match to nobody; the refusal says how.
    expect(await run(['demo/yeast/Yeast_microC.metacooler.json', '--over', 'a.cool', 'b.cool'])).toMatchObject({
      code: 2,
      err: expect.stringMatching(/one quoted glob: --over 'data\/\*\.mcool'/),
    })
  })

  it('lists the plan and stops, with --list', async () => {
    const { code, out: printed } = await run(['demo/yeast/Yeast_microC.metacooler.json', '--list', '--format', 'png,pdf'])
    expect(code).toBe(0)
    expect(printed).toMatch(/^tab 1 · /)
    expect(printed).toMatch(/reads Yeast_microC_G2M_1kb\.cool — .*demo\/yeast\/Yeast_microC_G2M_1kb\.cool/)
    expect(printed).toMatch(/writes .*\.\{png,pdf\}/)
  })
})
