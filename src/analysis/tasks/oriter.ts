/**
 * The replication origin and terminus of each sequence, as a descriptor.
 *
 * The first step of every analysis of a bacterial chromosome's folding, and one
 * that had to be done elsewhere: the map is read *from* the origin — its arms
 * are aligned about it, its secondary diagonal crosses the main one there, and a
 * figure puts it in the middle — so a reader needs to know where it is before
 * the map means anything. Nothing in a `.cool` says, and most assemblies only
 * happen to start near it.
 *
 * The sequence says, and `analysis/oriter.ts` reads it: the turning points of
 * the cumulative GC skew are the two candidates, and which is the terminus is
 * decided by the sites that mark each end — matS round the terminus of the
 * enterobacteria, parS round the origin of most other bacteria — and, failing
 * both, by the Hi-C coverage, which is highest where the chromosome was copied
 * first. The motifs are parameters and default to the published consensuses:
 * parS `TGTTNCACGTGNAACA` (Livny, Yamaichi & Waldor 2007), searched allowing
 * one mismatch because each genome carries variants of it, and matS
 * `GTGACRNYGTCAC` (Mercier et al. 2008), searched exactly because at one
 * mismatch it turns up dozens of times by chance in a genome with no MatP.
 *
 * What it makes is **loci**: an `ori` and a `ter` per sequence, and the parS and
 * matS sites they were placed against, as interval sets that draw on the map and
 * leave as BED. The origin it finds is also the one the rest of the app reads
 * the arms from (§8.15): the declaration is filled in on the Chromosomes table
 * for every sequence the reader has not already given one.
 */

import { compileMotif, isMotifRefusal } from '../../annotations/motif'
import { tickedContigs } from '../context'
import type { AnalysisTask, CostEstimate, Params, ParamSpec, TableOutput, TaskOutput } from '../types'
import { READY, waitingFor } from '../types'

/** parS, the ParB binding site: the bacterial consensus of Livny, Yamaichi & Waldor (2007). */
export const PARS_CONSENSUS = 'TGTTNCACGTGNAACA'

/** matS, the MatP binding site, as Mercier et al. (2008) give it. */
export const MATS_CONSENSUS = 'GTGACRNYGTCAC'

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequence',
    key: 'sequence',
    label: 'reference',
    hint: 'The FASTA to read the skew and the sites from.',
  },
  { kind: 'sequences', key: 'sequences', label: 'sequences' },
  {
    kind: 'track',
    key: 'coverage',
    label: 'coverage',
    optional: true,
    noneLabel: 'Do not use coverage',
    hint: 'Raw Hi-C coverage: breaks a tie, and gives the ori/ter ratio.',
    startsEmpty: true,
  },
  {
    kind: 'number',
    key: 'window',
    label: 'skew window',
    unit: 'bp',
    default: 5000,
    min: 100,
    integer: true,
    section: 'GC skew',
  },
  {
    kind: 'number',
    key: 'step',
    label: 'skew step',
    unit: 'bp',
    default: 1000,
    min: 10,
    integer: true,
    section: 'GC skew',
  },
  {
    kind: 'text',
    key: 'parS',
    label: 'parS motif',
    default: PARS_CONSENSUS,
    placeholder: PARS_CONSENSUS,
    hint: 'Sites cluster round the origin; empty skips them.',
    section: 'Sites',
  },
  {
    kind: 'number',
    key: 'parSMismatches',
    label: 'parS mismatches',
    default: 1,
    min: 0,
    max: 4,
    integer: true,
    section: 'Sites',
  },
  {
    kind: 'text',
    key: 'matS',
    label: 'matS motif',
    default: MATS_CONSENSUS,
    placeholder: MATS_CONSENSUS,
    hint: 'Ten or more sites place the terminus; empty skips them.',
    section: 'Sites',
  },
  {
    kind: 'number',
    key: 'matSMismatches',
    label: 'matS mismatches',
    default: 0,
    min: 0,
    max: 4,
    integer: true,
    section: 'Sites',
  },
  {
    kind: 'number',
    key: 'knots',
    label: 'spline knots',
    hint: 'Of the cubic spline the coverage is smoothed with.',
    default: 10,
    min: 4,
    max: 40,
    integer: true,
    section: 'Coverage',
    when: (params) => typeof params.coverage === 'string' && params.coverage !== '',
  },
]

/**
 * The pattern a text parameter holds, cleaned the way the motif task cleans one.
 *
 * **Unanswered is the consensus and empty is none** — two answers, kept apart
 * the way `sequences` keeps its two (§18.2): a job that never met a form, or a
 * session written before a motif was a parameter, searches the published site,
 * while a reader who cleared the box asked for that step to be skipped.
 */
export function sitePattern(params: Params, key: 'parS' | 'matS'): string {
  const value = params[key]
  if (value === undefined || value === null) return key === 'parS' ? PARS_CONSENSUS : MATS_CONSENSUS
  return typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : ''
}

function estimate(context: Parameters<AnalysisTask['estimate']>[0], params: Params): CostEstimate {
  const free = { class: 'free' as const, requests: 0, bytes: 0, note: 'Nothing to read.' }
  const entry = params.sequence
  if (typeof entry !== 'string' || entry === '') {
    return {
      ...free,
      refusal: 'Choose a reference. A FASTA dropped on the Annotations panel is one.',
    }
  }
  for (const key of ['parS', 'matS'] as const) {
    const pattern = sitePattern(params, key)
    if (pattern === '') continue
    const compiled = compileMotif(pattern)
    if (isMotifRefusal(compiled)) return { ...free, refusal: `${key}: ${compiled.reason}` }
  }
  const chosen = context.hasMap ? tickedContigs(context, params, 'sequences') : context.contigs
  if (context.hasMap && chosen.length === 0) {
    return { ...free, refusal: 'Tick at least one sequence.' }
  }
  const bases = chosen.reduce((sum, contig) => sum + contig.length, 0)
  const coverage = typeof params.coverage === 'string' && params.coverage !== ''
  return {
    class: 'free',
    requests: 0,
    bytes: 0,
    note:
      `One pass over ${(bases / 1e6).toFixed(1)} Mb of residues for the skew and the two motifs` +
      `${coverage ? ', and the coverage track sampled at 5 kb' : ''}`,
  }
}

export const ORITER_TASK: AnalysisTask = {
  id: 'oriter',
  title: 'Origin and terminus',
  blurb: 'Where replication starts and ends, from the GC skew, parS, matS and coverage.',
  keywords: ['ori', 'ter', 'replication', 'GC skew', 'dif'],
  group: '1d',
  // The residues are there and nowhere else; the coverage is a track, which is
  // there too.
  venue: 'annotations',
  version: 1,
  availability: (context) =>
    context.entries.some((entry) => entry.kind === 'sequence')
      ? READY
      : waitingFor('Load the FASTA of the genome.'),
  params: PARAMS,
  outputs: ['intervals', 'table', 'profile'],
  estimate,
}

/**
 * The origins a run placed, 0-based, by sequence — what the session declares.
 *
 * Read from the table's `ori`, which is where the call put it, and not from the
 * `ori` locus: that is a window wide and cut at the sequence's ends, so near
 * the first base — where most assemblies of a bacterial chromosome start — its
 * middle is up to half a window from the origin it was drawn round.
 */
export function declaredOrigins(outputs: readonly TaskOutput[]): Record<string, number> {
  const table = outputs.find(
    (output): output is TableOutput => output.kind === 'table' && output.id === 'oriter-table',
  )
  const found: Record<string, number> = {}
  for (const row of table?.rows ?? []) {
    const at = Number(row.ori)
    if (typeof row.sequence === 'string' && Number.isFinite(at) && at >= 1) {
      found[row.sequence] = Math.floor(at) - 1
    }
  }
  return found
}
