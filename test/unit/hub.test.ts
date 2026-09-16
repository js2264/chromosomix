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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  HUB_COLUMNS,
  hasGenomeStanzas,
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
import { parseGenePred, sniffGenePred } from '@/annotations/genepred'
import { parseInteract, sniffInteract } from '@/annotations/interact'
import { parseLongRange, sniffLongRange } from '@/annotations/longrange'
import { STORE_KIND, storeFromText } from '@/state/store'
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

// ---------------------------------------------------------------------------
// …and the hub this repository ships
// ---------------------------------------------------------------------------

/**
 * The demo hub, read off disk exactly as the browser reads it off a server.
 *
 * Everything above is a hub this file wrote, which pins the rules. This is the
 * one `scripts/make_demo_hub.py` generates over the yeast demo, and it is here
 * for two reasons that a fixture cannot cover.
 *
 * It is a **real assembly hub**: its genome is a `.2bit` that kent's own reader
 * has verified base for base, so the `twoBitPath` rung of §24.10's ladder is
 * exercised against a file rather than against a string in a test.
 *
 * And it is the file a reader is about to be told to paste into the hub tile
 * (`http://localhost:5173/demo/yeast/hub.txt`), so if this test fails, that
 * instruction is wrong — which is the kind of thing nobody notices until
 * somebody follows it.
 */
describe('the demo hub', () => {
  const dir = join(process.cwd(), 'demo/yeast')
  const read = async (url: string): Promise<string | null> => {
    const name = url.replace(/^https:\/\/demo\//, '')
    try {
      return readFileSync(join(dir, name), 'utf8')
    } catch {
      return null
    }
  }
  const at = 'https://demo/hub.txt'

  it('reads as an assembly hub over the demo data', async () => {
    const store = await readHub(at, await read(at) as string, read)
    expect(store).not.toBeNull()
    expect(store!.name).toBe('metacooler demo')
    expect(store!.description).toContain('1 assembly')
    // Nothing refused: every track in it is a type this viewer draws.
    expect(store!.description).not.toContain('not offered')
  })

  it('opens on the hub’s own .2bit, with every track on its shelf', async () => {
    const store = (await readHub(at, (await read(at)) as string, read))!
    const genome = store.entries.find((entry) => entry.fields?.['role'] === 'sequence')
    expect(genome?.uri).toBe('https://demo/S288c_syn40-XIII.2bit')
    expect(genome?.fields?.['format']).toBe('2bit')
    expect(genome?.tracks?.map((track) => track.label)).toEqual([
      'MNase',
      'ATAC',
      'Pol II',
      'RNA +',
      'RNA −',
      'Shotgun',
      'Micro-C loops',
      'Micro-C map',
    ])
  })

  it('keeps the six bigWigs under the composite their hub groups them in', async () => {
    const store = (await readHub(at, (await read(at)) as string, read))!
    const signal = store.entries.filter((entry) => entry.fields?.['group'] === 'signal')
    expect(signal).toHaveLength(6)
    expect(signal.every((entry) => entry.fields?.['format'] === 'bigWig')).toBe(true)
    // The composite stanza itself names no file, so it gets no row of its own.
    expect(store.entries.some((entry) => entry.label === 'Signal')).toBe(false)
  })

  it('sends the contact map through the map door and the loops through the genome one', async () => {
    const store = (await readHub(at, (await read(at)) as string, read))!
    const map = store.entries.find((entry) => entry.label === 'Micro-C map')
    expect(map?.kind).toBe('map')
    const loops = store.entries.find((entry) => entry.label === 'Micro-C loops')
    expect(loops?.kind).toBe('genome')
    expect(loops?.fields?.['format']).toBe('longrange')
  })
})

/**
 * The two loose demo files the hub cannot carry, read by the readers they are
 * for.
 *
 * UCSC's remote-data types are the `big*` ones plus `bam`, `cram`, `vcfTabix`,
 * `hic` and `longTabix` — so a plain `.interact` or `.genePred` in a `trackDb`
 * is a hub UCSC itself would refuse, and the demo hub does not write one
 * (`scripts/make_demo_hub.py`). They are beside it as files to drop instead,
 * and this is what says they open.
 */
describe('the demo files for the formats a hub cannot carry', () => {
  const dir = join(process.cwd(), 'demo/yeast')

  it('reads the loop calls as interact, both anchors intact', () => {
    const text = readFileSync(join(dir, 'Yeast_microC_loops.interact'), 'utf8')
    expect(sniffInteract(text)).toBe(true)
    const set = parseInteract(text)
    expect(set.length).toBeGreaterThan(1000)
    // The anchors, not the span between them: every pair is two 1 kb windows.
    for (let i = 0; i < 20; i++) {
      expect(set.end1[i] - set.start1[i]).toBe(1000)
      expect(set.end2[i] - set.start2[i]).toBe(1000)
    }
  })

  it('reads the same calls as longrange, folding the reciprocal lines', () => {
    const text = readFileSync(join(dir, 'Yeast_microC_loops.longrange'), 'utf8')
    expect(sniffLongRange(text)).toBe(true)
    const folded = parseLongRange(text)
    const interact = parseInteract(readFileSync(join(dir, 'Yeast_microC_loops.interact'), 'utf8'))
    // The file holds both ends of each call, so it is twice as many lines as
    // interactions — and the reader must arrive at the interact file's count.
    expect(text.trim().split('\n')).toHaveLength(interact.length * 2)
    expect(folded.length).toBe(interact.length)
  })

  it('reads the GTF’s transcripts back out of the genePred spelling', () => {
    const text = readFileSync(join(dir, 'Yeast_annotations.genePred'), 'utf8')
    expect(sniffGenePred(text)).toBe(true)
    const set = parseGenePred(text)
    expect(set.length).toBe(7071)
    // The symbol in front of the accession, which is what `name2` carries.
    const at = set.name.findIndex((name) => name === 'SOR2')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(set.id[at]).toMatch(/^Y/)
    expect(set.exonAt[at + 1]).toBeGreaterThan(set.exonAt[at])
  })
})

// ---------------------------------------------------------------------------
// …pasted rather than fetched
// ---------------------------------------------------------------------------

/**
 * A hub read from text somebody pasted (§24.10).
 *
 * The reason this road exists is not convenience: a store or a hub is fetched by
 * the *page*, so the host has to allow a cross-origin `GET`, and plenty do not —
 * `genome.ucsc.edu` among them, which puts UCSC's own example hubs out of reach
 * of every browser-only viewer. The file is public and the one thing in the way
 * is a response header on somebody else's server.
 *
 * **One box, not three.** A `hub.txt`, a `genomes.txt` and a `trackDb.txt`
 * concatenated are a one-file hub in every respect that matters: the only keys
 * the concatenation loses are the two saying where the next file is, and the
 * next file is already in the box.
 */
describe('a hub pasted rather than fetched', () => {
  const CONCATENATED = [HUB_TXT, GENOMES_TXT.split('\n\n')[1], GALGAL_TRACKDB].join('\n')

  it('reads a concatenation with no `useOneFile` line and no fetch at all', async () => {
    let asked = 0
    const store = await readHub('https://lab.example.org/myHub/', CONCATENATED, async () => {
      asked++
      return null
    })
    expect(asked).toBe(0)
    expect(store!.name).toBe('My Hub')
    expect(store!.entries.map((entry) => entry.label)).toEqual([
      'Chicken (galGal7)',
      'Genes',
    ])
  })

  it('tells a whole hub from its first file', () => {
    expect(hasGenomeStanzas(CONCATENATED)).toBe(true)
    // A real three-file `hub.txt` has no genome stanza, which is what keeps this
    // from ever firing on one by mistake.
    expect(hasGenomeStanzas(HUB_TXT)).toBe(false)
  })
})

describe('storeFromText', () => {
  const ONE_FILE = [
    'hub pasted',
    'shortLabel Pasted hub',
    '',
    'genome hg38',
    'organism Human',
    '',
    'track cov',
    'shortLabel Coverage',
    'bigDataUrl https://lab.example.org/data/cov.bw',
    'type bigWig',
    '',
  ].join('\n')

  it('reads a pasted hub with absolute URLs and no base', async () => {
    const result = await storeFromText(ONE_FILE)
    expect(result.ok).toBe(true)
    expect(result.ok && result.store.name).toBe('Pasted hub')
    expect(result.ok && result.store.entries.map((entry) => entry.uri)).toEqual([
      'https://lab.example.org/data/cov.bw',
      'https://lab.example.org/data/cov.bw',
    ])
  })

  it('refuses a hub.txt on its own, and says what is missing', async () => {
    const result = await storeFromText(HUB_TXT)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('hub.txt alone')
    expect(!result.ok && result.message).toContain('genomes.txt')
  })

  it('refuses relative names with nothing to resolve them against', async () => {
    const relative = ONE_FILE.replace('https://lab.example.org/data/cov.bw', 'cov.bw')
    const result = await storeFromText(relative)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('relatively')
    expect(!result.ok && result.message).toContain('cov.bw')
  })

  it('takes those same names once a base is given', async () => {
    const relative = ONE_FILE.replace('https://lab.example.org/data/cov.bw', 'cov.bw')
    const result = await storeFromText(relative, 'https://lab.example.org/data/')
    expect(result.ok).toBe(true)
    expect(result.ok && result.store.entries[0].uri).toBe('https://lab.example.org/data/cov.bw')
  })

  it('reads a pasted store file too, not only a hub', async () => {
    const json = JSON.stringify({
      kind: STORE_KIND,
      version: 1,
      name: 'Pasted shelf',
      columns: [],
      entries: [{ label: 'One', uri: 'https://lab.example.org/one.mcool' }],
    })
    const result = await storeFromText(json)
    expect(result.ok && result.store.name).toBe('Pasted shelf')
  })

  it('says so when nothing was pasted', async () => {
    const result = await storeFromText('   ')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('Nothing pasted')
  })
})
