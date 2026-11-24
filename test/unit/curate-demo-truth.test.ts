// @dev-feature curate
/**
 * The curation's method held to the truth (SPECS §33.5, §33.11): the demo's
 * mock community MM133, read as the stage reads it — the file's binning, its
 * markers and every stored pixel, through the reader's own handlers — and its
 * suggestions scored against which organism each contig is
 * (`test/golden/demo/MM133.truth.tsv.gz`, `scripts/make_mock_truth.py`). A
 * contig whose organism is unknown — about 13 Mb match no reference — is
 * neither right nor wrong. The quality is held to the miComplete numbers the
 * map stores for every MAG.
 */

import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'

import { AUTO_THRESHOLD, LIKELY, OFFER_FLOOR } from '../../src/curate/method'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import { handleCurationBase, handleCurationNetwork, handleCurationState, releaseCuration } from '../../src/worker/curate'
import type { CurationBaseResult, CurationNetworkResult, CurationStateResult } from '../../src/worker/curateProtocol'

const MAP = new URL('../../demo/metagenomics/mock-community/MM133.metacool', import.meta.url).pathname
const TRUTH = new URL('../golden/demo/MM133.truth.tsv.gz', import.meta.url).pathname

interface Truth {
  /** Each contig's organism, `''` for unknown. */
  organism: Map<string, string>
  /** For a plasmid's or a phage's contig, the organism it belongs to. */
  host: Map<string, string>
}

function readTruth(): Truth {
  const lines = gunzipSync(readFileSync(TRUTH)).toString('utf8').trimEnd().split('\n')
  const head = lines[0].split('\t')
  const at = (name: string): number => head.indexOf(name)
  const organism = new Map<string, string>()
  const host = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const f = line.split('\t')
    organism.set(f[at('contig')], f[at('organism')])
    if (f[at('host')] !== '') host.set(f[at('contig')], f[at('host')])
  }
  return { organism, host }
}

let base: CurationBaseResult
let network: CurationNetworkResult
let state: CurationStateResult
let truth: Truth
let mc: MetaCooler

beforeAll(async () => {
  mc = await MetaCooler.open(MAP, await LocalFileSource.open(MAP))
  releaseCuration()
  base = handleCurationBase(mc)
  network = await handleCurationNetwork(mc, { cancelled: () => false, onProgress: () => {} }, () => new Error('cancelled'))
  state = handleCurationState(mc, { kind: 'curationState', curation: null, weights: {} } as never)
  truth = readTruth()
}, 120_000)

/** The organism most of a genome's bases are, `''` where most are unknown. */
function organismOf(g: number): string {
  const by = new Map<string, number>()
  state.genomeOf.forEach((owner, c) => {
    if (owner !== g) return
    const o = truth.organism.get(base.base.names[c]) ?? ''
    by.set(o, (by.get(o) ?? 0) + base.base.lengths[c])
  })
  return [...by].sort((x, y) => y[1] - x[1])[0]?.[0] ?? ''
}

/** The organism an element's contigs belong to, by their bases: its true host. */
function hostOf(g: number): string {
  const by = new Map<string, number>()
  state.genomeOf.forEach((owner, c) => {
    if (owner !== g) return
    const h = truth.host.get(base.base.names[c])
    if (h !== undefined) by.set(h, (by.get(h) ?? 0) + base.base.lengths[c])
  })
  return [...by].sort((x, y) => y[1] - x[1])[0]?.[0] ?? ''
}

describe('MM133, against its truth', () => {
  it('reads the community as the binner left it: 50 MAGs, 127 elements, every pixel', () => {
    expect(base.base.genomes.filter((g) => g.kind === 'mag').length).toBe(50)
    expect(base.base.genomes.filter((g) => g.kind === 'element').length).toBe(127)
    expect(network.pixels).toBe(7_081_501)
    expect(network.pairs).toBe(263_961)
    expect(base.markerSets).toEqual(['Bact105', 'Arch131'])
  })

  /** Of the suggestions of a kind at a confidence: how many, and how many of those the truth can judge are right. */
  function scored(kind: 'merge' | 'recruit' | 'move' | 'link' | 'unlink', at: number): { count: number; contigs: number; bases: number; known: number; right: number } {
    const dom = state.genomes.map((_, g) => organismOf(g))
    const out = { count: 0, contigs: 0, bases: 0, known: 0, right: 0 }
    for (const s of state.suggestions) {
      if (s.kind !== kind || s.confidence < at) continue
      out.count++
      if (kind === 'merge') {
        const [a, b] = s.genomes
        if (dom[a] === '' || dom[b] === '') continue
        out.known++
        if (dom[a] === dom[b]) out.right++
      } else if (kind === 'recruit' || kind === 'move') {
        // The genome a contig would go to is the suggestion's last.
        const g = s.genomes[s.genomes.length - 1]
        for (const c of s.contigs) {
          out.contigs++
          out.bases += base.base.lengths[c]
          const o = truth.organism.get(base.base.names[c]) ?? ''
          if (o === '' || dom[g] === '') continue
          out.known++
          if (o === dom[g]) out.right++
        }
      } else {
        const [e, m] = s.genomes
        const h = hostOf(e)
        if (h === '' || dom[m] === '') continue
        out.known++
        if (kind === 'link' ? h === dom[m] : h !== dom[m]) out.right++
      }
    }
    return out
  }

  it('measures the rate of spurious ligation from the file’s own binning', () => {
    expect(network.background.rho).toBeCloseTo(0.0237, 4)
  })

  it('merges the fragments of one organism, and only those: 13 of 13 at even odds', () => {
    expect(scored('merge', LIKELY)).toMatchObject({ count: 13, known: 13, right: 13 })
    expect(scored('merge', AUTO_THRESHOLD)).toMatchObject({ count: 11, known: 11, right: 11 })
  })

  it('recruits the pool’s contigs where they belong: 314 contigs, 1.58 Mb, 96.6% right at even odds, 98.6% at 80%', () => {
    const likely = scored('recruit', LIKELY)
    expect(likely).toMatchObject({ contigs: 314, known: 117, right: 113 })
    expect(likely.bases / 1e6).toBeCloseTo(1.58, 2)
    expect(scored('recruit', AUTO_THRESHOLD)).toMatchObject({ known: 71, right: 70 })
  })

  it('moves a misplaced contig: 10 of the 12 the truth can judge at even odds, every one at 80%', () => {
    expect(scored('move', LIKELY)).toMatchObject({ count: 15, known: 12, right: 10 })
    expect(scored('move', AUTO_THRESHOLD)).toMatchObject({ count: 7, known: 5, right: 5 })
  })

  it('links the elements metaTOR left without their host: 11 of 12 at even odds', () => {
    expect(scored('link', LIKELY)).toMatchObject({ count: 13, known: 12, right: 11 })
  })

  it('unlinks one host only: metaTOR’s Vibrio phage on a Corynebacterium MAG', () => {
    const unlinks = state.suggestions.filter((s) => s.kind === 'unlink' && s.confidence >= OFFER_FLOOR)
    expect(unlinks.map((s) => s.words)).toEqual(['unlink MetaTOR_MGE_00002 from MM133_metator_00713_00000'])
    expect(hostOf(unlinks[0].genomes[0])).toBe('V_cholerae')
    expect(organismOf(unlinks[0].genomes[1])).toBe('corynebact_RES')
  })

  it('prices every MAG as miComplete does: the map’s own four numbers, but where mge --reassign took a contig since', () => {
    const table = mc.fullGenomes()
    const names = table.strings('name')
    const column = (name: string): number[] => table.numbers(name)
    const stored = ['Completeness', 'Redundancy', 'Weighted completeness', 'Weighted redundancy'].map(column)
    const differs: string[] = []
    let mags = 0
    state.genomes.forEach((genome) => {
      if (genome.kind !== 'mag') return
      mags++
      const row = names.indexOf(genome.name)
      const q = genome.quality
      const now = q === null ? [] : [q.completeness, q.redundancy, q.weightedCompleteness, q.weightedRedundancy]
      if (stored.some((values, k) => values[row] !== now[k])) differs.push(genome.name)
    })
    expect(mags).toBe(50)
    // Its table's numbers are the validation's, of the 92 contigs it had before
    // mge --reassign took 29 into elements — one of them a second Enolase_C;
    // these are miComplete's on its 63 contigs as they are.
    expect(differs).toEqual(['MM133_metator_00706_00000'])
    const q = state.genomes.find((genome) => genome.name === 'MM133_metator_00706_00000')?.quality
    expect(q && [q.completeness, q.redundancy, q.weightedCompleteness, q.weightedRedundancy]).toEqual([0.9905, 1.0192, 0.9814, 1.0294])
  })
})
