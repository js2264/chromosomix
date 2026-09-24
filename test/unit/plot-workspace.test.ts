/**
 * A saved workspace, pointed at addresses a headless page can read (§27.3).
 *
 * `metacooler-plot` cannot hand the page a file, so every name a tab carries —
 * its map, the map it is compared with, each companion in its deck, each track
 * and each track's index — is rewritten to a URL before the page sees it. The
 * failure worth a test is the quiet one: a deck whose maps were rewritten and
 * whose *keys* were not. Lanes, looks and map names are keyed on the file each
 * is for, so a key left behind is a legal deck with every placed track back on
 * the lead, every clip back on the lead's scale and every name back on its file
 * — nothing reports it, and the figure is not the one that was saved.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { safeName, stemOf } from '@/cli/names'
import {
  baseOf,
  expandOver,
  isAddress,
  locate,
  overTab,
  rewriteTab,
  tabStem,
  uniqueStems,
  type NameKind,
} from '@/cli/plotWorkspace'
import { parseMaps, serialiseMaps } from '@/panels/deck'
import type { SessionConfig } from '@/state/SessionConfig'
import { isRefusal } from '@/state/SessionConfig'
import { parseWorkspaceFile } from '@/state/workspace'
import type { StoredEntry } from '@/annotations/types'

/** A real saved tab, from the demo the repository ships, as the base for every case here. */
function demoTab(): SessionConfig {
  const read = parseWorkspaceFile(readFileSync('demo/yeast/Yeast_deck.metacooler.json', 'utf8'))
  if (isRefusal(read)) throw new Error('the demo deck no longer parses')
  return structuredClone(read.tabs[0])
}

function track(id: string, source: StoredEntry['source']): StoredEntry {
  const base = demoTab().tracks[0]
  return { ...base, id, label: id, source }
}

let root = ''
let workspaceDir = ''
let data1 = ''
let data2 = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'metacooler-plot-ws-'))
  workspaceDir = join(root, 'ws')
  data1 = join(root, 'data1')
  data2 = join(root, 'data2')
  for (const dir of [workspaceDir, data1, data2]) mkdirSync(dir)
  for (const [dir, name] of [
    [workspaceDir, 'lead.cool'],
    [workspaceDir, 'genes.gtf'],
    [data1, 'lead.cool'],
    [data1, 'dropped.bw'],
    [data2, 'moved.cool'],
  ]) {
    writeFileSync(join(dir, name), 'x')
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isAddress', () => {
  it('is an address with a scheme of two letters or more, file: aside', () => {
    expect(isAddress('https://host/x.cool')).toBe(true)
    expect(isAddress('s3://bucket/x.mcool')).toBe(true)
    expect(isAddress('gs://bucket/x.hic')).toBe(true)
    // A Windows drive letter is a path, and `file:` names this machine.
    expect(isAddress('C:\\data\\x.cool')).toBe(false)
    expect(isAddress('file:///data/x.cool')).toBe(false)
    expect(isAddress('x.cool')).toBe(false)
    expect(isAddress('../data/x.cool')).toBe(false)
  })
})

describe('locate', () => {
  const dir = (): { kind: 'dir'; path: string } => ({ kind: 'dir', path: workspaceDir })

  it('leaves an address as it is', () => {
    expect(locate('https://host/x.cool', 'named', dir(), [])).toEqual({ kind: 'address', url: 'https://host/x.cool' })
  })

  // A published workspace names its files beside itself; a dropped file's name
  // was never relative to anything, so the directories the reader named come first.
  it('asks the workspace’s folder first for a written name, the --data folders first for a dropped one', () => {
    expect(locate('lead.cool', 'named', dir(), [data1])).toEqual({ kind: 'file', path: join(workspaceDir, 'lead.cool') })
    expect(locate('lead.cool', 'dropped', dir(), [data1])).toEqual({ kind: 'file', path: join(data1, 'lead.cool') })
  })

  it('falls back to the last segment, for a path another machine had', () => {
    expect(locate('/home/someone/run7/dropped.bw', 'named', dir(), [data1])).toEqual({
      kind: 'file',
      path: join(data1, 'dropped.bw'),
    })
    expect(locate('run7/dropped.bw', 'dropped', dir(), [data1])).toEqual({
      kind: 'file',
      path: join(data1, 'dropped.bw'),
    })
  })

  it('reads a file: URL as the path it is', () => {
    const url = pathToFileURL(join(workspaceDir, 'genes.gtf')).href
    expect(locate(url, 'named', dir(), [])).toEqual({ kind: 'file', path: join(workspaceDir, 'genes.gtf') })
  })

  it('resolves a written name against a workspace read from an address, and not a dropped one', () => {
    const base = { kind: 'url' as const, url: 'https://lab.example/share/figure.metacooler.json' }
    expect(locate('maps/x.cool', 'named', base, [])).toEqual({ kind: 'address', url: 'https://lab.example/share/maps/x.cool' })
    expect(locate('dropped.bw', 'dropped', base, [data1])).toEqual({ kind: 'file', path: join(data1, 'dropped.bw') })
    expect(locate('nowhere.bw', 'dropped', base, [data1])).toEqual({ kind: 'missing', name: 'nowhere.bw' })
  })

  it('says what it could not find', () => {
    expect(locate('absent.cool', 'named', dir(), [data1, data2])).toEqual({ kind: 'missing', name: 'absent.cool' })
  })
})

describe('rewriteTab', () => {
  /**
   * Serves what exists at `http://srv/<name>` and leaves an address as it is,
   * as the command's own `place` does — and records how each name was asked for.
   */
  function server(present: readonly string[]): {
    place: (name: string, how: NameKind) => string | null
    asked: Map<string, NameKind>
  } {
    const asked = new Map<string, NameKind>()
    return {
      asked,
      place: (name, how) => {
        asked.set(name, how)
        if (!present.includes(name)) return null
        return isAddress(name) ? name : `http://srv/${name}`
      },
    }
  }

  function deckTab(): SessionConfig {
    const tab = demoTab()
    return {
      ...tab,
      state: {
        ...tab.state,
        uri: 'lead.cool',
        maps: serialiseMaps([
          { kind: 'remote', uri: 'rep2.mcool::/resolutions/5000' },
          { kind: 'vacant' },
          { kind: 'structure' },
        ]),
      },
      deck: {
        columns: 2,
        locals: [{ index: 1, uri: 'dropped2.cool' }],
        looks: [
          { uri: 'rep2.mcool::/resolutions/5000', vmin: 1 },
          { uri: 'dropped2.cool', vmax: 3 },
        ],
      },
      lanes: [
        { track: 'a', uri: 'rep2.mcool::/resolutions/5000', placement: { top: false, bottom: true, left: false, right: false }, borrowedLead: false },
        { track: 'b', uri: 'dropped2.cool', placement: { top: false, bottom: false, left: false, right: true }, borrowedLead: false },
      ],
      mapNames: { 'lead.cool': 'the lead', 'rep2.mcool': 'replicate 2', 'dropped2.cool': 'a dropped one' },
      tracks: [
        track('genes', { kind: 'remote', name: 'genes.gtf', url: 'genes.gtf' }),
        track('reads', { kind: 'remote', name: 'reads.bam', url: 'reads.bam', index: 'reads.bam.bai' }),
        track('signal', { kind: 'local', name: 'dropped.bw' }),
        track('gone', { kind: 'local', name: 'gone.bw' }),
        track('web', { kind: 'remote', name: 'web.bw', url: 'https://host/web.bw' }),
      ],
      compare: 'other.cool',
      source: { name: 'lead.cool', size: 1, lastModified: 0 },
    } as SessionConfig
  }

  const present = [
    'lead.cool',
    'rep2.mcool',
    'dropped2.cool',
    'genes.gtf',
    'reads.bam',
    'reads.bam.bai',
    'dropped.bw',
    'https://host/web.bw',
    'other.cool',
  ]

  it('points the map, every companion and every track at the address it is served at', () => {
    const { place } = server(present)
    const { tab, missing } = rewriteTab(deckTab(), place)
    expect(tab.state.uri).toBe('http://srv/lead.cool')
    // The group inside a container rides along; the vacancy the local
    // companion filled is a map now, and a structure cell is left as it was.
    expect(parseMaps(tab.state.maps)).toEqual([
      { kind: 'remote', uri: 'http://srv/rep2.mcool::/resolutions/5000' },
      { kind: 'remote', uri: 'http://srv/dropped2.cool' },
      { kind: 'structure' },
    ])
    expect(tab.deck.locals).toBeUndefined()
    const sources = Object.fromEntries(tab.tracks.map((entry) => [entry.id, entry.source]))
    expect(sources['genes']).toMatchObject({ kind: 'remote', url: 'http://srv/genes.gtf' })
    expect(sources['reads']).toMatchObject({ url: 'http://srv/reads.bam', index: 'http://srv/reads.bam.bai' })
    // A dropped track is read from its address now, under the name it had.
    expect(sources['signal']).toMatchObject({ kind: 'remote', name: 'dropped.bw', url: 'http://srv/dropped.bw' })
    expect(sources['web']).toMatchObject({ kind: 'remote', url: 'https://host/web.bw' })
    // A track that is not there stays in the list, detached, as a reload leaves it.
    expect(sources['gone']).toEqual({ kind: 'local', name: 'gone.bw' })
    expect(missing).toEqual([{ name: 'gone.bw', role: 'the track "gone"' }])
  })

  // The deck's own invariant: a key is the file the thing is for, and
  // `adoptHome` matches it by string equality.
  it('rewrites every key through the same answer as the map it names', () => {
    const { tab } = rewriteTab(deckTab(), server(present).place)
    const maps = parseMaps(tab.state.maps).flatMap((ref) => (ref.kind === 'remote' ? [ref.uri] : []))
    expect(tab.lanes?.map((lane) => lane.uri)).toEqual(maps)
    expect(tab.deck.looks?.map((look) => look.uri)).toEqual(maps)
    expect(tab.mapNames).toEqual({
      'http://srv/lead.cool': 'the lead',
      'http://srv/rep2.mcool': 'replicate 2',
      'http://srv/dropped2.cool': 'a dropped one',
    })
  })

  it('asks for a dropped name as dropped and a written one as written', () => {
    const { place, asked } = server(present)
    rewriteTab(deckTab(), place)
    expect(asked.get('lead.cool')).toBe('named')
    expect(asked.get('rep2.mcool')).toBe('named')
    expect(asked.get('dropped2.cool')).toBe('dropped')
    expect(asked.get('dropped.bw')).toBe('dropped')
    expect(asked.get('other.cool')).toBe('dropped')
  })

  // §5.7: the only difference between `compare` and `uri2` is whether the file
  // has an address. Once served, it has.
  it('turns the local second file into the square’s second map, and drops what named a local file', () => {
    const { tab } = rewriteTab(deckTab(), server(present).place)
    expect(tab.state.uri2).toBe('http://srv/other.cool')
    expect(tab.compare).toBeUndefined()
    expect(tab.source).toBeUndefined()
  })

  it('leaves a vacancy where a companion cannot be found, and says which', () => {
    const { tab, missing } = rewriteTab(deckTab(), server(present.filter((name) => name !== 'dropped2.cool')).place)
    expect(parseMaps(tab.state.maps)[1]).toEqual({ kind: 'vacant' })
    expect(missing).toContainEqual({ name: 'dropped2.cool', role: 'a map beside the first' })
  })

  it('keeps a remote uri2 over a local compare, and drops a second file it cannot find', () => {
    const tab = { ...deckTab(), state: { ...deckTab().state, uri2: 'https://host/b.cool' } }
    expect(rewriteTab(tab, server([...present, 'https://host/b.cool']).place).tab.state.uri2).toBe('https://host/b.cool')
    const lost = rewriteTab(deckTab(), server(present.filter((name) => name !== 'other.cool')).place)
    expect(lost.tab.state.uri2).toBeUndefined()
    expect(lost.missing).toContainEqual({ name: 'other.cool', role: 'the second map in the square' })
  })

  it('reports a missing lead as the map the tab is of, and keeps its name', () => {
    const { tab, missing } = rewriteTab(deckTab(), server(present.filter((name) => name !== 'lead.cool')).place)
    expect(tab.state.uri).toBe('lead.cool')
    expect(missing).toContainEqual({ name: 'lead.cool', role: 'the map this tab is of' })
  })
})

describe('overTab', () => {
  it('is the same tab of another file, without what named the old one', () => {
    const tab = {
      ...demoTab(),
      state: { ...demoTab().state, uri: 'a.mcool::/resolutions/5000' },
      mapNames: { 'a.mcool': 'sample A', 'Yeast_hic.hic': 'Hi-C (hic)' },
      source: { name: 'a.mcool', size: 1, lastModified: 0 },
    } as SessionConfig
    const over = overTab(tab, 'b.mcool')
    // The same rung of the new file, since it is the same kind of container.
    expect(over.state.uri).toBe('b.mcool::/resolutions/5000')
    expect(over.name).toBeUndefined()
    expect(over.source).toBeUndefined()
    expect(over.mapNames).toEqual({ 'Yeast_hic.hic': 'Hi-C (hic)' })
    // Everything else the tab is comes along.
    expect(over.tracks).toEqual(tab.tracks)
    expect(over.state.region).toBe(tab.state.region)
    expect(over.state.maps).toBe(tab.state.maps)
  })

  it('carries a group only to a file of the same kind, and never over one it was given', () => {
    const tab = { ...demoTab(), state: { ...demoTab().state, uri: 'a.mcool::/resolutions/5000' } }
    expect(overTab(tab, 'b.hic').state.uri).toBe('b.hic')
    expect(overTab(tab, 'b.mcool::/resolutions/1000').state.uri).toBe('b.mcool::/resolutions/1000')
    const pairs = { ...demoTab(), state: { ...demoTab().state, uri: 'a.pairs.gz' } }
    expect(overTab(pairs, 'b.pairs').state.uri).toBe('b.pairs')
  })
})

describe('what the files are called', () => {
  it('names a tab by what the reader called it, or else by its file', () => {
    expect(tabStem({ ...demoTab(), name: 'micro-C vs Hi-C' })).toBe('micro-C_vs_Hi-C')
    const unnamed = { ...demoTab(), state: { ...demoTab().state, uri: 'runs/wt.mcool::/resolutions/5000' } }
    delete unnamed.name
    expect(tabStem(unnamed)).toBe('wt_5000')
    expect(tabStem({ ...unnamed, name: '   ' })).toBe('wt_5000')
  })

  // A suffix never lands on another tab's own name, whatever the order.
  it('makes every stem unique without taking a name another tab has', () => {
    expect(uniqueStems(['a', 'b'])).toEqual(['a', 'b'])
    expect(uniqueStems(['a', 'a', 'a'])).toEqual(['a', 'a-2', 'a-3'])
    expect(uniqueStems(['a', 'a', 'a-2'])).toEqual(['a', 'a-3', 'a-2'])
    expect(uniqueStems(['a-2', 'a', 'a'])).toEqual(['a-2', 'a', 'a-3'])
  })

  it('stems a file as metacooler-run does, a URL’s query and a container’s group included', () => {
    expect(stemOf('demo/yeast/Yeast_microC_G2M_1kb.cool')).toBe('Yeast_microC_G2M_1kb')
    expect(stemOf('sample.mcool::/resolutions/1000')).toBe('sample_1000')
    expect(stemOf('https://host/dir/rep1.hic?X-Amz-Signature=abc')).toBe('rep1')
    expect(stemOf('README')).toBe('README')
  })

  it('makes a reader’s words safe for a filename', () => {
    expect(safeName('wild type × mutant')).toBe('wild_type_x_mutant')
    expect(safeName('chrI:100,000-200,000')).toBe('chrI_100_000-200_000')
    expect(safeName('../../etc/passwd')).toBe('etc_passwd')
    expect(safeName('')).toBe('figure')
    expect(safeName('×'.repeat(3))).toBe('xxx')
    expect(safeName('a'.repeat(200))).toHaveLength(80)
  })
})

describe('expandOver', () => {
  let cwd = ''
  beforeAll(() => {
    cwd = join(root, 'over')
    mkdirSync(join(cwd, 'runs', 'deeper'), { recursive: true })
    mkdirSync(join(cwd, 'other'))
    for (const name of ['runs/b.mcool', 'runs/a.mcool', 'runs/.hidden.mcool', 'runs/c.cool', 'other/a.mcool']) {
      writeFileSync(join(cwd, name), 'x')
    }
  })

  // A path on the command line is the shell's: relative to where it was typed,
  // not to the workspace.
  it('resolves a path against the directory the command was run in, keeping its group', () => {
    expect(expandOver('runs/a.mcool', cwd)).toEqual([join(cwd, 'runs', 'a.mcool')])
    expect(expandOver('runs/a.mcool::resolutions/5000', cwd)).toEqual([`${join(cwd, 'runs', 'a.mcool')}::/resolutions/5000`])
    expect(expandOver(pathToFileURL(join(cwd, 'runs', 'c.cool')).href, cwd)).toEqual([join(cwd, 'runs', 'c.cool')])
    expect(expandOver('https://host/x.mcool', cwd)).toEqual(['https://host/x.mcool'])
  })

  it('expands a quoted glob to every file it matches, in order, the group on each', () => {
    expect(expandOver('runs/*.mcool::resolutions/5000', cwd)).toEqual([
      `${join(cwd, 'runs', 'a.mcool')}::/resolutions/5000`,
      `${join(cwd, 'runs', 'b.mcool')}::/resolutions/5000`,
    ])
    expect(expandOver('runs/?.cool', cwd)).toEqual([join(cwd, 'runs', 'c.cool')])
    expect(expandOver('runs/[!a].mcool', cwd)).toEqual([join(cwd, 'runs', 'b.mcool')])
    expect(expandOver('*/a.mcool', cwd)).toEqual([join(cwd, 'other', 'a.mcool'), join(cwd, 'runs', 'a.mcool')])
    // A directory is not a file to plot over, and a dotfile is matched only by name.
    expect(expandOver('runs/*', cwd)).not.toContain(join(cwd, 'runs', 'deeper'))
    expect(expandOver('runs/.*.mcool', cwd)).toEqual([join(cwd, 'runs', '.hidden.mcool')])
    expect(expandOver('runs/*.hic', cwd)).toEqual([])
  })
})

describe('baseOf', () => {
  it('is the folder a workspace is in, or the address it was read from', () => {
    expect(baseOf(join(workspaceDir, 'w.metacooler.json'))).toEqual({ kind: 'dir', path: workspaceDir })
    expect(baseOf(pathToFileURL(join(workspaceDir, 'w.metacooler.json')).href)).toEqual({ kind: 'dir', path: workspaceDir })
    expect(baseOf('https://lab.example/w.json')).toEqual({ kind: 'url', url: 'https://lab.example/w.json' })
  })
})
