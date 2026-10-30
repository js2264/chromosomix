// @vitest-environment jsdom
/**
 * The K562 showcase (§24.11): the landing page's offer, and the one tab it
 * opens.
 *
 * The offer stands with the store tiles and only where they are, since what it
 * opens is three stores' files read over the network. The tab is one map and
 * its tracks on three sides — IGV's hg38 above, the structure 4DN and ENCODE
 * computed down the left and on the map, ENCODE's 1D signal under it — and no
 * deck. It is pinned here as it arrives: through the workspace file's own
 * reader, which is the validator a dropped workspace meets.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FIELD_NAME } from '@/annotations/fields'
import type { LaneEdge, StoredEntry } from '@/annotations/types'
import { isRefusal, type SessionConfig } from '@/state/SessionConfig'
import { buildWorkspaceFile, parseWorkspaceFile } from '@/state/workspace'
import { FilePicker } from '@/ui/FilePicker'
import { getPlotOptions, setPlotOption } from '@/ui/plotOptions'
import { SHOWCASE, SHOWCASE_MAP, SHOWCASE_REGION, showcaseConfig } from '@/ui/showcase'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  teardown()
})

function landing(options: { store?: boolean; showcase?: () => void } = {}): FilePicker {
  return new FilePicker({
    onOpen: () => undefined,
    onOpenFiles: () => undefined,
    ...(options.store === false ? {} : { onStore: () => undefined }),
    ...(options.showcase === undefined ? {} : { onShowcase: options.showcase }),
  })
}

describe('the offer', () => {
  it('stands after the store tiles, in their section, and opens the showcase', () => {
    const open = vi.fn()
    const picker = landing({ showcase: open })
    const offer = picker.el.querySelector('.picker-store-section > .picker-showcase')
    expect(offer).not.toBeNull()
    // After the tiles, so that a narrow page reads it as a row under them.
    expect(offer?.previousElementSibling?.classList.contains('picker-stores')).toBe(true)
    expect(textsOf(picker.el, '.picker-showcase-kicker')).toEqual([SHOWCASE.kicker])
    expect(textsOf(picker.el, '.picker-showcase-open')).toEqual([SHOWCASE.button])
    expect(textsOf(picker.el, '.picker-showcase-text')).toEqual([SHOWCASE.line])
    picker.el.querySelector<HTMLButtonElement>('.picker-showcase-open')?.click()
    expect(open).toHaveBeenCalledTimes(1)
    picker.destroy()
  })

  it('is absent where nothing would open it, and where there are no stores to read', () => {
    const none = landing()
    expect(none.el.querySelector('.picker-showcase')).toBeNull()
    none.destroy()
    // An embed builds no store drawer and passes no tile handler (§21.2).
    const embed = landing({ store: false, showcase: () => undefined })
    expect(embed.el.querySelector('.picker-showcase')).toBeNull()
    embed.destroy()
  })
})

describe('the tab', () => {
  /** The showcase, written out as a workspace file and read back in. */
  function readBack(): SessionConfig {
    const now = new Date('2026-10-30T12:00:00Z')
    const read = parseWorkspaceFile(JSON.stringify(buildWorkspaceFile([showcaseConfig(now)], 0, now)))
    if (isRefusal(read)) throw new Error(`refused: ${read.reason}`)
    expect(read.tabs).toHaveLength(1)
    return read.tabs[0]
  }

  const edgeOf = (row: StoredEntry): LaneEdge[] =>
    (Object.entries(row.placement) as Array<[LaneEdge, boolean]>).filter(([, on]) => on).map(([edge]) => edge)

  it('survives the workspace reader whole: one tab, one map, no deck', () => {
    const tab = readBack()
    expect(tab.name).toBe(SHOWCASE.tab)
    expect(tab.state.uri).toBe(`${SHOWCASE_MAP}::resolutions/10000`)
    expect(tab.state.view).toBe('region')
    expect(tab.state.region).toBe(SHOWCASE_REGION)
    expect(tab.state.maps).toBeUndefined()
    expect(tab.state.uri2).toBeUndefined()
    expect(tab.tracks).toEqual(showcaseConfig().tracks)
    expect(tab.mapNames?.[SHOWCASE_MAP]).toMatch(/K562/)
  })

  it('puts the genome above, the structure down the left and on the map, and the signal below', () => {
    const tab = readBack()
    const on = (edge: LaneEdge): string[] =>
      tab.tracks.filter((row) => row.card === 'linear' && edgeOf(row).includes(edge)).map((row) => row.label)
    expect(on('top')).toEqual(['RefSeq genes (IGV)', 'hg38 sequence (IGV)', 'hg38 bands (IGV)'])
    expect(on('left')).toEqual([
      'insulation (4DN)',
      'boundaries (4DN)',
      'E1 · compartments (4DN)',
      'subcompartments (ENCODE)',
    ])
    expect(on('right')).toEqual([])
    expect(on('bottom')).toEqual([
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
    // Every row on one edge, and the loops on the map rather than beside it.
    for (const row of tab.tracks) expect(edgeOf(row)).toHaveLength(1)
    const overlays = tab.tracks.filter((row) => row.card === 'overlay')
    expect(overlays.map((row) => [row.kind, row.label])).toEqual([['pairs', 'CTCF ChIA-PET loops (ENCODE)']])
  })

  it('draws the signal as five lanes of two, each pair overlaid on its own axes', () => {
    const tab = readBack()
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
    const tab = readBack()
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
    const row = readBack().tracks.find((entry) => entry.label === 'subcompartments (ENCODE)')
    expect(row?.style.features?.colourBy).toBe(FIELD_NAME)
    expect(Object.keys(row?.style.features?.nameColours ?? {})).toEqual(['1', '2', '3', '4', '5'])
  })

  it('leaves the reader’s overlays as they are', () => {
    setPlotOption('crosshair', false)
    expect(showcaseConfig().plot).toEqual(getPlotOptions())
    setPlotOption('crosshair', true)
    expect(showcaseConfig().plot).toEqual(getPlotOptions())
  })
})
