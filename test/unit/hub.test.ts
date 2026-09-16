/**
 * UCSC track hubs, read as stores (§24.10).
 *
 * The claims here are about a translation, so they come in pairs: what the hub
 * format says, and what the store has to end up meaning.
 *
 * The three that are easiest to get wrong, and are therefore tested hardest:
 *
 * **Stanza boundaries.** The `ra` format separates records with a blank line,
 * indents subtracks for readability, and continues lines with a trailing `\\`.
 * A parser that treated indentation as nesting, or that needed the blank line,
 * merges a composite with its first subtrack — producing one stanza whose
 * `bigDataUrl` belongs to neither.
 *
 * **Which base a URL resolves against.** A `bigDataUrl` is relative to the
 * `trackDb.txt` that named it, a `twoBitPath` to `genomes.txt`, and an
 * `include`d file's tracks to *that* file. Three bases, and using the hub's own
 * for all three is the bug that puts every track one directory up.
 *
 * **What is refused.** A track this viewer cannot draw must get no row — a row
 * that draws the wrong picture when pressed is worse than an absent one — and
 * the count must be said rather than silently dropped.
 */

import { describe, expect, it } from 'vitest'

import {
  HUB_COLUMNS,
  hubFormat,
  hubRefusal,
  hubStore,
  includesOf,
  looksLikeHub,
  looksLikeHubUrl,
  oneFileGenomes,
  parseHubGenomes,
  parseHubHeader,
  parseStanzas,
  parseTrackDb,
  readHub,
} from '@/state/hub'
import { STORE_KIND } from '@/state/store'
import type { StoreEntry } from '@/state/store'

const HUB_URL = 'https://lab.example.org/myHub/hub.txt'

const HUB_TXT = `hub myHub
shortLabel My Hub
longLabel Everything the lab published in 2026
genomesFile genomes.txt
email me@example.org
`

const GENOMES_TXT = `genome hg38
trackDb hg38/trackDb.txt
organism Human

genome galGal7
trackDb galGal7/trackDb.txt
twoBitPath galGal7/galGal7.2bit
organism Chicken
description Gallus gallus, 2026
defaultPos chr1:1-100000
`

/** Indented subtracks, a continuation line, a composite, and two refusals. */
const HG38_TRACKDB = `track signal
compositeTrack on
shortLabel Signal
longLabel Every signal track \\
in this hub
type bigWig

    track signalRep1
    parent signal on
    shortLabel Rep 1
    bigDataUrl data/rep1.bw
    type bigWig 0 100

    track signalRep2
    parent signal on
    shortLabel Rep 2
    bigDataUrl data/rep2.bw
    type bigWig

track loops
shortLabel Loops
longLabel ChIA-PET loops
bigDataUrl data/loops.inter.bb
type bigInteract

track methyl
shortLabel 5mC
bigDataUrl data/calls.bb
type bigMethyl

track reads
shortLabel Reads
bigDataUrl data/sample.cram
type cram

track snakes
shortLabel Snake
bigDataUrl data/aln.hal
type halSnake

include extra.txt
`

const HG38_EXTRA = `track genes
shortLabel Genes
bigDataUrl genes.bb
type bigGenePred

track variants
shortLabel Variants
bigDataUrl calls.vcf.gz
bigDataIndex indexes/calls.vcf.gz.tbi
type vcfTabix
`

const GALGAL_TRACKDB = `track chickenGenes
shortLabel Genes
bigDataUrl genes.bb
type bigBed 12
`

const FILES: Record<string, string> = {
  [HUB_URL]: HUB_TXT,
  'https://lab.example.org/myHub/genomes.txt': GENOMES_TXT,
  'https://lab.example.org/myHub/hg38/trackDb.txt': HG38_TRACKDB,
  'https://lab.example.org/myHub/hg38/extra.txt': HG38_EXTRA,
  'https://lab.example.org/myHub/galGal7/trackDb.txt': GALGAL_TRACKDB,
}

function reader(files: Record<string, string> = FILES): (url: string) => Promise<string | null> {
  return async (url) => files[url] ?? null
}

function entryNamed(entries: readonly StoreEntry[], label: string): StoreEntry {
  const found = entries.find((entry) => entry.label === label)
  if (found === undefined) throw new Error(`no entry called ${label}: ${entries.map((e) => e.label).join(', ')}`)
  return found
}

describe('the stanza format', () => {
  it('splits on blank lines', () => {
    const stanzas = parseStanzas('a 1\nb 2\n\nc 3\n')
    expect(stanzas.map((stanza) => [...stanza])).toEqual([
      [
        ['a', '1'],
        ['b', '2'],
      ],
      [['c', '3']],
    ])
  })

  it('strips the indentation subtracks are written with', () => {
    const stanzas = parseStanzas('track a\n\n    track b\n    parent a\n', 'track')
    expect(stanzas[1].get('track')).toBe('b')
    expect(stanzas[1].get('parent')).toBe('a')
  })

  it('starts a new record on a repeated start key with no blank line', () => {
    const stanzas = parseStanzas('track a\nshortLabel A\ntrack b\nshortLabel B\n', 'track')
    expect(stanzas).toHaveLength(2)
    expect(stanzas[1].get('shortLabel')).toBe('B')
  })

  it('joins a continued line', () => {
    const stanzas = parseStanzas('track a\nlongLabel one \\\ntwo\n')
    expect(stanzas[0].get('longLabel')).toBe('one two')
  })

  it('keeps the first of a repeated key and drops comments', () => {
    const stanzas = parseStanzas('# a comment\ntrack a\ntype bigWig\ntype bigBed\n')
    expect(stanzas[0].get('type')).toBe('bigWig')
  })
})

describe('reading the three files', () => {
  it('recognises a hub by its content, not its name', () => {
    expect(looksLikeHub(HUB_TXT)).toBe(true)
    expect(looksLikeHub('{"kind":"metacooler.store"}')).toBe(false)
    expect(looksLikeHub(HG38_TRACKDB)).toBe(false)
    expect(looksLikeHubUrl(HUB_URL)).toBe(true)
    expect(looksLikeHubUrl('https://lab.example.org/store.json')).toBe(false)
  })

  it('reads the header', () => {
    const header = parseHubHeader(HUB_TXT)
    expect(header).toMatchObject({
      name: 'myHub',
      shortLabel: 'My Hub',
      genomesFile: 'genomes.txt',
      oneFile: false,
    })
  })

  it('reads the genomes, with an assembly hub’s own sequence', () => {
    const genomes = parseHubGenomes(GENOMES_TXT)
    expect(genomes.map((genome) => genome.assembly)).toEqual(['hg38', 'galGal7'])
    expect(genomes[0].twoBitPath).toBe('')
    expect(genomes[1].twoBitPath).toBe('galGal7/galGal7.2bit')
    expect(genomes[1].label).toBe('Chicken')
  })

  it('reads the tracks, telling a container from a file', () => {
    const tracks = parseTrackDb(HG38_TRACKDB)
    const composite = tracks.find((track) => track.track === 'signal')!
    expect(composite.container).toBe(true)
    expect(composite.bigDataUrl).toBe('')
    expect(composite.longLabel).toBe('Every signal track in this hub')
    const sub = tracks.find((track) => track.track === 'signalRep1')!
    expect(sub.parent).toBe('signal')
    expect(sub.type).toBe('bigwig')
    expect(sub.bigDataUrl).toBe('data/rep1.bw')
  })

  it('finds the include lines', () => {
    expect(includesOf(HG38_TRACKDB)).toEqual(['extra.txt'])
  })
})

describe('the store a hub becomes', () => {
  it('is an ordinary store file', async () => {
    const store = await readHub(HUB_URL, HUB_TXT, reader())
    expect(store).not.toBeNull()
    expect(store!.kind).toBe(STORE_KIND)
    expect(store!.name).toBe('My Hub')
    expect(store!.source).toBe(HUB_URL)
    expect(store!.columns).toEqual([...HUB_COLUMNS])
  })

  it('resolves each URL against the file that named it', async () => {
    const store = (await readHub(HUB_URL, HUB_TXT, reader()))!
    // A trackDb's own directory…
    expect(entryNamed(store.entries, 'Rep 1').uri).toBe(
      'https://lab.example.org/myHub/hg38/data/rep1.bw',
    )
    // …an included file's, which is the same directory here but reached another
    // way, and `genomes.txt`'s for an assembly hub's sequence.
    expect(entryNamed(store.entries, 'Genes').uri).toBe(
      'https://lab.example.org/myHub/hg38/genes.bb',
    )
    expect(entryNamed(store.entries, 'Chicken (galGal7)').uri).toBe(
      'https://lab.example.org/myHub/galGal7/galGal7.2bit',
    )
  })

  it('opens an assembly hub on its own .2bit', async () => {
    const store = (await readHub(HUB_URL, HUB_TXT, reader()))!
    const chicken = entryNamed(store.entries, 'Chicken (galGal7)')
    expect(chicken.kind).toBe('genome')
    expect(chicken.fields?.['role']).toBe('sequence')
    expect(chicken.fields?.['format']).toBe('2bit')
  })

  it('opens a db hub on a track whose header declares the assembly', async () => {
    const store = (await readHub(HUB_URL, HUB_TXT, reader()))!
    // hg38 has no twoBitPath and no chromSizes, so the genome row falls back to
    // the first track whose header carries lengths — and says so.
    const human = entryNamed(store.entries, 'Human (hg38)')
    expect(human.fields?.['role']).toBe('sequence')
    expect(human.uri).toBe('https://lab.example.org/myHub/hg38/data/rep1.bw')
    expect(human.note).toContain('names no sequence of its own')
  })

  it('hangs every drawable track on the genome row as a shelf', async () => {
    const store = (await readHub(HUB_URL, HUB_TXT, reader()))!
    const human = entryNamed(store.entries, 'Human (hg38)')
    expect(human.tracks?.map((track) => track.label)).toEqual([
      'Rep 1',
      'Rep 2',
      'Loops',
      '5mC',
      'Genes',
      'Variants',
    ])
  })

  it('gives every track a row, under the group its hub put it in', async () => {
    const store = (await readHub(HUB_URL, HUB_TXT, reader()))!
    expect(entryNamed(store.entries, 'Rep 1').fields).toMatchObject({
      assembly: 'hg38',
      role: 'annotation',
      format: 'bigWig',
      group: 'signal',
    })
    // A track with no parent has no group, which is what leaves it loose in the
    // list rather than under an invented heading.
    expect(entryNamed(store.entries, 'Loops').fields?.['group']).toBeUndefined()
    expect(entryNamed(store.entries, 'Loops').fields?.['format']).toBe('bigInteract')
    expect(entryNamed(store.entries, '5mC').fields?.['format']).toBe('bigMethyl')
  })

  it('carries a hub-named index as the fragment this app reads', async () => {
    const store = (await readHub(HUB_URL, HUB_TXT, reader()))!
    expect(entryNamed(store.entries, 'Variants').uri).toBe(
      'https://lab.example.org/myHub/hg38/calls.vcf.gz#index=https://lab.example.org/myHub/hg38/indexes/calls.vcf.gz.tbi',
    )
  })

  it('offers no row for a track it cannot draw, and says how many', async () => {
    const store = (await readHub(HUB_URL, HUB_TXT, reader()))!
    expect(store.entries.some((entry) => entry.label === 'Reads')).toBe(false)
    expect(store.entries.some((entry) => entry.label === 'Snake')).toBe(false)
    expect(store.description).toContain('2 tracks not offered')
    expect(store.description).toContain('CRAM')
    expect(store.description).toContain('HAL')
  })

  it('names the refusals one by one', () => {
    expect(hubRefusal('bigwig')).toBeNull()
    expect(hubRefusal('cram')).toContain('reference')
    expect(hubRefusal('halsnake')).toContain('server')
    expect(hubRefusal('')).toContain('no type')
    expect(hubRefusal('wigmaf')).toContain('wigmaf')
  })

  it('knows the five formats this release added', () => {
    expect(hubFormat('biginteract')).toBe('bigInteract')
    expect(hubFormat('interact')).toBe('interact')
    expect(hubFormat('longtabix')).toBe('longrange')
    expect(hubFormat('bigmethyl')).toBe('bigMethyl')
    expect(hubFormat('biggenepred')).toBe('bigGenePred')
    expect(hubFormat('hic')).toBe('hic')
  })

  it('sends a .hic through the map door and everything else through the genome one', async () => {
    const store = (await readHub(
      HUB_URL,
      HUB_TXT,
      reader({
        ...FILES,
        'https://lab.example.org/myHub/hg38/trackDb.txt':
          'track contacts\nshortLabel Contacts\nbigDataUrl maps/gm12878.hic\ntype hic\n',
      }),
    ))!
    expect(entryNamed(store.entries, 'Contacts').kind).toBe('map')
  })

  it('survives a genomes.txt that is not there', async () => {
    const store = (await readHub(HUB_URL, HUB_TXT, reader({ [HUB_URL]: HUB_TXT })))!
    expect(store.entries).toEqual([])
    expect(store.name).toBe('My Hub')
    expect(store.description).toContain('0 assemblies')
  })
})

describe('a one-file hub', () => {
  const ONE_FILE = `hub oneFile
shortLabel One File
longLabel A hub in a single file
useOneFile on

genome hg38
organism Human

track first
shortLabel First
bigDataUrl a.bw
type bigWig

track second
shortLabel Second
bigDataUrl b.bb
type bigBed 9

genome mm39
organism Mouse
twoBitPath mm39.2bit

track third
shortLabel Third
bigDataUrl c.bw
type bigWig
`

  it('keeps each track under the genome it follows', () => {
    const genomes = oneFileGenomes(ONE_FILE, HUB_URL)
    expect(genomes.map((held) => held.genome.assembly)).toEqual(['hg38', 'mm39'])
    expect(genomes[0].tracks.map((track) => track.track)).toEqual(['first', 'second'])
    expect(genomes[1].tracks.map((track) => track.track)).toEqual(['third'])
  })

  it('reads with no further fetch at all', async () => {
    let asked = 0
    const store = (await readHub(HUB_URL, ONE_FILE, async () => {
      asked++
      return null
    }))!
    expect(asked).toBe(0)
    expect(store.name).toBe('One File')
    expect(entryNamed(store.entries, 'First').uri).toBe('https://lab.example.org/myHub/a.bw')
    expect(entryNamed(store.entries, 'Mouse (mm39)').uri).toBe(
      'https://lab.example.org/myHub/mm39.2bit',
    )
  })
})

describe('hubStore on its own', () => {
  it('drops a genome it can open nothing for, and keeps its tracks', () => {
    const store = hubStore({
      header: {
        name: 'h',
        shortLabel: 'H',
        longLabel: '',
        genomesFile: '',
        oneFile: false,
        descriptionUrl: '',
        email: '',
      },
      hubUrl: HUB_URL,
      genomesUrl: HUB_URL,
      genomes: [
        {
          genome: {
            assembly: 'hg38',
            label: 'hg38',
            trackDb: '',
            twoBitPath: '',
            chromSizes: '',
            description: '',
            defaultPos: '',
          },
          // A BAM declares an assembly to this app, but not through a bbi
          // header — and the genome row has to be a file the 1D browser can
          // open on. Nothing here is one.
          tracks: [
            {
              track: 'reads',
              shortLabel: 'Reads',
              longLabel: '',
              type: 'bam',
              bigDataUrl: 'https://host/reads.bam',
              bigDataIndex: '',
              parent: '',
              container: false,
            },
          ],
          trackDbUrl: HUB_URL,
        },
      ],
    })
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].fields?.['role']).toBe('annotation')
  })
})
