// @vitest-environment jsdom
/**
 * The landing page's example sessions (§24.11): the column under *Just
 * looking?*, the `?` on each button, and the two tabs built in the bundle.
 *
 * The column stands with the store tiles and only where they are, since every
 * example is somebody's published files read over the network. Each button is
 * a name and a `?` — the Analysis column's mark and tip — and a press on the
 * `?` reads, it does not open. Two examples are the lab's store's figures, by
 * the address the store itself reads them from; two are built here, and are
 * pinned as they arrive: through the workspace file's own reader, the
 * validator a dropped workspace meets.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FIELD_NAME } from '@/annotations/fields'
import type { LaneEdge, StoredEntry } from '@/annotations/types'
import { isRefusal, type SessionConfig } from '@/state/SessionConfig'
import { buildWorkspaceFile, parseWorkspaceFile } from '@/state/workspace'
import { demoFigure } from '@/ui/examples'
import {
  CHICKEN_G2,
  CHICKEN_MITOSIS,
  COMPARISON_REGION,
  EXAMPLES,
  HUMAN_MAP,
  HUMAN_REGION,
  comparisonConfig,
  exampleSessions,
  humanConfig,
  type ExampleSession,
} from '@/ui/exampleSessions'
import { FilePicker } from '@/ui/FilePicker'
import { getPlotOptions, setPlotOption } from '@/ui/plotOptions'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  teardown()
})

function landing(options: { store?: boolean; example?: (example: ExampleSession) => void } = {}): FilePicker {
  return new FilePicker({
    onOpen: () => undefined,
    onOpenFiles: () => undefined,
    ...(options.store === false ? {} : { onStore: () => undefined }),
    ...(options.example === undefined ? {} : { onExample: options.example }),
  })
}

const tip = (): HTMLElement | null => document.querySelector<HTMLElement>('.question-tip:not(.hidden)')

describe('the column', () => {
  it('asks, then offers four sessions by name, after the store tiles', () => {
    const picker = landing({ example: () => undefined })
    const column = picker.el.querySelector('.picker-store-section > .picker-examples')
    expect(column).not.toBeNull()
    // After the tiles, so that a narrow page reads it as a row under them.
    expect(column?.previousElementSibling?.classList.contains('picker-stores')).toBe(true)
    expect(textsOf(picker.el, '.picker-examples-kicker')).toEqual([EXAMPLES.kicker])
    expect(textsOf(picker.el, '.picker-examples-prompt')).toEqual(['Pick an example session'])
    expect(textsOf(picker.el, '.picker-example-label')).toEqual([
      'Human Hi-C data',
      'Yeast micro-C data',
      'Linear tracks',
      'Comparing data',
    ])
    // No sentence under the buttons: what each opens is behind its `?`.
    expect(all(picker.el, '.picker-examples > p')).toHaveLength(2)
    picker.destroy()
  })

  it('opens the example its button names', () => {
    const opened: string[] = []
    const picker = landing({ example: (example) => opened.push(example.id) })
    for (const button of all<HTMLButtonElement>(picker.el, '.picker-example')) button.click()
    expect(opened).toEqual(['human', 'yeast', 'linear', 'compare'])
    picker.destroy()
  })

  it('wears the Analysis column’s `?`, which reads and does not open', () => {
    const open = vi.fn()
    const picker = landing({ example: open })
    document.body.appendChild(picker.el)
    const button = picker.el.querySelector<HTMLButtonElement>('[data-example="compare"]')
    const mark = button?.querySelector<HTMLElement>('.picker-example-hint')
    expect(mark?.tagName).toBe('SPAN')
    expect(mark?.querySelector('svg.icon')).not.toBeNull()
    // Named by its words, described by its `?`.
    expect(button?.getAttribute('aria-label')).toBe('Comparing data')
    expect(button?.getAttribute('aria-describedby')).toBe(mark?.id)
    expect(mark?.getAttribute('aria-label')).toMatch(/^Chicken Hi-C in G2 above the diagonal/)
    mark?.dispatchEvent(new Event('pointerenter'))
    expect(tip()?.querySelector('.question-tip-text')?.textContent).toMatch(/^Chicken Hi-C in G2/)
    expect(tip()?.querySelector('.question-tip-note')?.textContent).toBe('Gibcus et al. 2018 (4DN)')
    // Outside the button, which a tip cannot sit inside.
    expect(tip()?.closest('.picker-example')).toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(tip()).toBeNull()
    // A press on it, for a finger, shows the tip and opens nothing.
    mark?.click()
    expect(open).not.toHaveBeenCalled()
    expect(tip()).not.toBeNull()
    // Every button has one, each its own.
    const ids = all(picker.el, '.picker-example-hint').map((node) => node.id)
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    picker.el.remove()
    picker.destroy()
  })

  it('is absent where nothing would open it, and where there are no stores to read', () => {
    const none = landing()
    expect(none.el.querySelector('.picker-examples')).toBeNull()
    none.destroy()
    // An embed builds no store drawer and passes no tile handler (§21.2).
    const embed = landing({ store: false, example: () => undefined })
    expect(embed.el.querySelector('.picker-examples')).toBeNull()
    embed.destroy()
  })
})

describe('the examples', () => {
  it('opens two of the lab’s store’s figures by the address the store reads them from', () => {
    const byId = new Map(exampleSessions().map((example) => [example.id, example]))
    const microC = demoFigure('Yeast_microC.chromosomix.json')
    const landscape = demoFigure('Yeast_landscape.chromosomix.json')
    expect(byId.get('yeast')?.open).toEqual({ workspace: microC.uri })
    expect(byId.get('linear')?.open).toEqual({ workspace: landscape.uri })
    expect(microC.uri).toMatch(/\/store\/yeast\/Yeast_microC\.chromosomix\.json$/)
    expect(byId.get('yeast')?.about).toBe(microC.line)
    expect(byId.get('linear')?.about).toBe(landscape.line)
    expect('config' in (byId.get('human')?.open ?? {})).toBe(true)
    expect('config' in (byId.get('compare')?.open ?? {})).toBe(true)
  })
})

/** A built tab, written out as a workspace file and read back in. */
function readBack(config: SessionConfig): SessionConfig {
  const now = new Date('2026-10-30T12:00:00Z')
  const read = parseWorkspaceFile(JSON.stringify(buildWorkspaceFile([config], 0, now)))
  if (isRefusal(read)) throw new Error(`refused: ${read.reason}`)
  expect(read.tabs).toHaveLength(1)
  expect(read.tabs[0].tracks).toEqual(config.tracks)
  return read.tabs[0]
}

const edgeOf = (row: StoredEntry): LaneEdge[] =>
  (Object.entries(row.placement) as Array<[LaneEdge, boolean]>).filter(([, on]) => on).map(([edge]) => edge)

const on = (tab: SessionConfig, edge: LaneEdge): string[] =>
  tab.tracks.filter((row) => row.card === 'linear' && edgeOf(row).includes(edge)).map((row) => row.label)

describe('Human Hi-C data', () => {
  it('survives the workspace reader whole: one tab, one map, no deck', () => {
    const tab = readBack(humanConfig())
    expect(tab.state.uri).toBe(`${HUMAN_MAP}::resolutions/10000`)
    expect(tab.state.view).toBe('region')
    expect(tab.state.region).toBe(HUMAN_REGION)
    expect(tab.state.maps).toBeUndefined()
    expect(tab.state.uri2).toBeUndefined()
    expect(tab.mapNames?.[HUMAN_MAP]).toMatch(/K562/)
  })

  it('puts the genome above, the structure down the left and on the map, and the signal below', () => {
    const tab = readBack(humanConfig())
    expect(on(tab, 'top')).toEqual(['RefSeq genes (IGV)', 'hg38 sequence (IGV)', 'hg38 bands (IGV)'])
    expect(on(tab, 'left')).toEqual([
      'insulation (4DN)',
      'boundaries (4DN)',
      'E1 · compartments (4DN)',
      'subcompartments (ENCODE)',
    ])
    expect(on(tab, 'right')).toEqual([])
    expect(on(tab, 'bottom')).toEqual([
      'CTCF',
      'RAD21',
      'H3K4me3',
      'H3K27ac',
      'Pol II',
      'H3K36me3',
      'H3K27me3',
      'H3K9me3',
      'ATAC',
      'DNase',
    ])
    for (const row of tab.tracks) expect(edgeOf(row)).toHaveLength(1)
    const overlays = tab.tracks.filter((row) => row.card === 'overlay')
    expect(overlays.map((row) => [row.kind, row.label])).toEqual([['pairs', 'CTCF ChIA-PET loops (ENCODE)']])
  })

  it('draws the signal as five lanes of two, each pair overlaid on its own axes', () => {
    const tab = readBack(humanConfig())
    const bottom = tab.tracks.filter((row) => row.card === 'linear' && edgeOf(row).includes('bottom'))
    const groups = [...new Set(bottom.map((row) => row.style.group))]
    expect(groups).toHaveLength(5)
    for (const group of groups) {
      expect(bottom.filter((row) => row.style.group === group)).toHaveLength(2)
      expect(tab.groups[group]).toBe('overlay')
      expect(tab.scaling[group]).toBe('each')
    }
  })

  it('reads every file over HTTPS from the consortium that published it', () => {
    const tab = readBack(humanConfig())
    const ids = tab.tracks.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    const hosts = new Set<string>()
    for (const row of tab.tracks) {
      expect(row.source.kind).toBe('remote')
      const url = new URL(row.source.url ?? '')
      expect(url.protocol).toBe('https:')
      hosts.add(url.host)
    }
    expect([...hosts].sort()).toEqual([
      '1000genomes.s3.amazonaws.com',
      '4dn-open-data-public.s3.amazonaws.com',
      'encode-public.s3.amazonaws.com',
      's3.amazonaws.com',
    ])
    // UCSC's copy of the gene model carries no CORS header; IGV's own does.
    const genes = tab.tracks.find((row) => row.kind === 'gtf')
    expect(genes?.source.url).toMatch(/^https:\/\/s3\.amazonaws\.com\/igv\.org\.genomes\/hg38\//)
    expect(genes?.primary).toBe(true)
    // The sequence is read by range, through the index named beside it.
    const sequence = tab.tracks.find((row) => row.kind === 'sequence')
    expect(sequence?.source.index).toBe(`${sequence?.source.url}.fai`)
  })

  it('colours the subcompartments by the cluster each row names, in the file’s own colours', () => {
    const row = readBack(humanConfig()).tracks.find((entry) => entry.label === 'subcompartments (ENCODE)')
    expect(row?.style.features?.colourBy).toBe(FIELD_NAME)
    expect(Object.keys(row?.style.features?.nameColours ?? {})).toEqual(['1', '2', '3', '4', '5'])
  })
})

describe('Comparing data', () => {
  it('is G2 above the diagonal and mitosis below it, at one bin size, in one map', () => {
    const tab = readBack(comparisonConfig())
    expect(tab.state.uri).toBe(`${CHICKEN_G2}::resolutions/100000`)
    expect(tab.state.uri2).toBe(`${CHICKEN_MITOSIS}::resolutions/100000`)
    expect(tab.state.view).toBe('region')
    expect(tab.state.region).toBe(COMPARISON_REGION)
    expect(tab.state.maps).toBeUndefined()
    expect(tab.mapNames?.[CHICKEN_G2]).toMatch(/^G2/)
    expect(tab.mapNames?.[CHICKEN_MITOSIS]).toMatch(/60 min/)
  })

  it('puts each map’s compartments and insulation on the edge beside its own triangle, on one axis per kind', () => {
    const tab = readBack(comparisonConfig())
    expect(on(tab, 'top')).toEqual(['E1 · G2 (4DN)', 'insulation · G2 (4DN)'])
    expect(on(tab, 'left')).toEqual(['E1 · 60 min (4DN)', 'insulation · 60 min (4DN)'])
    expect(on(tab, 'bottom')).toEqual([])
    expect(on(tab, 'right')).toEqual([])
    const limits = (prefix: string): unknown[] =>
      tab.tracks.filter((row) => row.label.startsWith(prefix)).map((row) => row.style.limits)
    expect(limits('E1')).toEqual([
      { auto: false, min: -1.5, max: 1.5 },
      { auto: false, min: -1.5, max: 1.5 },
    ])
    expect(limits('insulation')).toEqual([
      { auto: false, min: -1, max: 1 },
      { auto: false, min: -1, max: 1 },
    ])
    for (const row of tab.tracks) {
      expect(new URL(row.source.url ?? '').host).toBe('4dn-open-data-public.s3.amazonaws.com')
    }
  })
})

describe('both built tabs', () => {
  it('leave the reader’s overlays as they are', () => {
    for (const build of [humanConfig, comparisonConfig]) {
      setPlotOption('crosshair', false)
      expect(build().plot).toEqual(getPlotOptions())
      setPlotOption('crosshair', true)
      expect(build().plot).toEqual(getPlotOptions())
    }
  })
})
