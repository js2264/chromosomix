/**
 * The origin and terminus, run — in the annotations worker, beside the
 * residues and the coverage track.
 *
 * Per sequence: the GC skew in windows of `window` bases every `step`, its
 * cumulative sum and that sum's two turning points; the parS and matS sites;
 * the coverage sampled at 5 kb and smoothed by a cubic spline, where a coverage
 * track was chosen; and then `callOriTer`, which is the whole of the decision
 * and is tested on its own (`analysis/oriter.ts`).
 *
 * The sequences are the map's where there is one, so the loci land on the map's
 * names; with no map they are the reference's own. A declared-circular sequence
 * (§8.15) is windowed round its origin and its sites clustered as angles, which
 * matters exactly here: most assemblies start at `dnaA`, so the origin is the
 * one locus a linear reading would split in two.
 */

import { FeatureBuilder } from '../../annotations/featureset'
import { compileMotif, findMotif, isMotifRefusal, type Motif } from '../../annotations/motif'
import {
  baseCounts,
  cumulativeOf,
  gcSkewOf,
  windowCounts,
} from '../../annotations/composition'
import {
  callOriTer,
  oriTerRatio,
  skewTurns,
  splineFit,
  type OriTerCall,
  type TerminusRule,
} from '../oriter'
import { idParam, numParam, tickedSequences, type TrackTaskRunner } from '../job'
import { sitePattern } from '../tasks/oriter'
import type {
  IntervalsOutput,
  ProfileOutput,
  TableOutput,
  TaskOutput,
} from '../types'
import { gridContigs } from './motif'

/** The resolution coverage is sampled at before it is smoothed, as Bacchus does. */
const COVERAGE_STEP = 5000

/** How the table says which step decided the terminus. */
const RULE_WORDS: Record<TerminusRule, string> = {
  matS: 'nearest the matS cluster',
  parS: 'farthest from the parS cluster',
  coverage: 'lower coverage',
  skew: 'skew maximum',
}

/** Sites found on one sequence: midpoints for the call, and the intervals to draw. */
interface Sites {
  mids: number[]
  starts: number[]
  ends: number[]
  strands: number[]
  mismatches: number[]
}

function sitesOf(seq: Uint8Array, motif: Motif | null, mismatches: number): Sites {
  const out: Sites = { mids: [], starts: [], ends: [], strands: [], mismatches: [] }
  if (motif === null) return out
  // Both strands: a binding site is where it is whichever strand the assembly
  // wrote it on, and both consensuses are palindromes, reported once per place.
  for (const hit of findMotif(seq, motif, { bothStrands: true, mismatches }).hits) {
    out.mids.push((hit.start + hit.end) / 2)
    out.starts.push(hit.start)
    out.ends.push(hit.end)
    out.strands.push(hit.strand)
    out.mismatches.push(hit.mismatches)
  }
  return out
}

export const runOriTer: TrackTaskRunner = async (job) => {
  const entry = idParam(job.params, 'sequence')
  if (job.residues === undefined) {
    job.note('This session cannot read residues, so there is no reference to read.')
    return []
  }
  if (entry === null) {
    job.note('No reference was chosen. Load the genome’s FASTA and pick it under Reference.')
    return []
  }
  const reader = job.residues(entry)
  if (reader === undefined) {
    job.note('The reference chosen is no longer loaded. Drop the FASTA again, or pick another.')
    return []
  }
  if (reader.refusal !== undefined) {
    job.note(reader.refusal)
    return []
  }

  // The two motifs, either of which may be left empty to skip its step.
  const motifs: Record<'parS' | 'matS', { motif: Motif | null; pattern: string; mismatches: number }> = {
    parS: { motif: null, pattern: '', mismatches: 0 },
    matS: { motif: null, pattern: '', mismatches: 0 },
  }
  for (const key of ['parS', 'matS'] as const) {
    const pattern = sitePattern(job.params, key)
    if (pattern === '') continue
    const compiled = compileMotif(pattern)
    if (isMotifRefusal(compiled)) {
      job.note(`${key}: ${compiled.reason} Its step was skipped.`)
      continue
    }
    const asked = Math.round(numParam(job.params, `${key}Mismatches`, key === 'parS' ? 1 : 0))
    motifs[key] = {
      motif: compiled,
      pattern,
      mismatches: Math.max(0, Math.min(compiled.length - 1, asked)),
    }
  }

  const window = Math.max(100, Math.round(numParam(job.params, 'window', 5000)))
  const step = Math.max(10, Math.min(window, Math.round(numParam(job.params, 'step', 1000))))
  const knots = Math.max(4, Math.min(40, Math.round(numParam(job.params, 'knots', 10))))
  const coverageEntry = idParam(job.params, 'coverage')
  const circular = new Set(job.framing.circular ?? [])

  // The map's sequences where there is a map, under the map's names; the
  // reference's own otherwise. Ticked narrows either.
  const grid = gridContigs(job)
  const everyName = grid.length > 0 ? grid.map((contig) => contig.name) : reader.contigs.map((c) => c.name)
  const ticked = tickedSequences(job.params, 'sequences')
  const names = ticked === null ? everyName : everyName.filter((name) => ticked.includes(name))
  if (names.length === 0) {
    job.note('No sequence is ticked, so there is nothing to read.')
    return []
  }

  const loci = new FeatureBuilder()
  const parSites = new FeatureBuilder()
  const matSites = new FeatureBuilder()
  let parCount = 0
  let matCount = 0
  const rows: Array<Record<string, string | number>> = []
  const fits = new Map<string, (at: number) => number>()
  const skipped: string[] = []

  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    job.progress(i, names.length, name)
    const seq = reader.bases(name)
    if (seq === undefined) {
      skipped.push(name)
      continue
    }
    const length = seq.length
    // A skew needs a few windows to have a shape at all.
    if (length < 4 * window) {
      skipped.push(name)
      continue
    }
    const round = circular.has(name)

    const counts = baseCounts(seq, step)
    const skew = gcSkewOf(windowCounts(counts, Math.max(1, Math.round(window / step)), round))
    const turns = skewTurns(cumulativeOf(skew), step, length)
    if (!Number.isFinite(turns.low) || !Number.isFinite(turns.high)) {
      skipped.push(name)
      continue
    }

    const par = sitesOf(seq, motifs.parS.motif, motifs.parS.mismatches)
    const mat = sitesOf(seq, motifs.matS.motif, motifs.matS.mismatches)

    let coverageAt: ((at: number) => number) | undefined
    let ratio = Number.NaN
    if (coverageEntry !== null) {
      const sampled = await job.sample(
        coverageEntry,
        [{ contig: name, start: 0, end: length }],
        COVERAGE_STEP,
      )
      const region = sampled.regions[0]
      if (region !== undefined && region.values.length > 3) {
        const positions = new Float64Array(region.values.length)
        const values = new Float64Array(region.values.length)
        for (let k = 0; k < region.values.length; k++) {
          positions[k] = (region.starts[k] + region.ends[k]) / 2
          values[k] = region.values[k]
        }
        const fit = splineFit(positions, values, length, knots, round)
        coverageAt = fit.at
        fits.set(name, fit.at)
        ratio = oriTerRatio(fit.fitted).ratio
      }
    }

    const call: OriTerCall = callOriTer({
      length,
      circular: round,
      low: turns.low,
      high: turns.high,
      parS: par.mids,
      matS: mat.mids,
      ...(coverageAt === undefined ? {} : { coverageAt }),
    })

    // A locus a window wide, centred on where the call put it: the skew places
    // a turning point to within a window, and a one-base interval would claim a
    // precision the method has not got.
    const half = Math.floor(window / 2)
    const detail = `${RULE_WORDS[call.rule]}${call.agreesWithSkew ? '' : ' · disagrees with the skew'}`
    for (const [label, at] of [
      ['ori', call.ori],
      ['ter', call.ter],
    ] as const) {
      loci.add(name, Math.max(0, at - half), Math.min(length, at + half), {
        name: label,
        detail: label === 'ter' ? `terminus · ${detail}` : 'origin',
      })
    }
    for (let k = 0; k < par.starts.length; k++) {
      parSites.add(name, par.starts[k], par.ends[k], {
        strand: par.strands[k],
        name: 'parS',
        score: par.mismatches[k],
        detail: `${par.mismatches[k]} ${par.mismatches[k] === 1 ? 'mismatch' : 'mismatches'}`,
      })
    }
    for (let k = 0; k < mat.starts.length; k++) {
      matSites.add(name, mat.starts[k], mat.ends[k], {
        strand: mat.strands[k],
        name: 'matS',
        score: mat.mismatches[k],
        detail: `${mat.mismatches[k]} ${mat.mismatches[k] === 1 ? 'mismatch' : 'mismatches'}`,
      })
    }
    parCount += par.starts.length
    matCount += mat.starts.length

    if (!call.agreesWithSkew) {
      job.note(
        `${name}: the terminus was placed ${RULE_WORDS[call.rule]}, at the cumulative skew’s ` +
          'minimum — which is where the skew alone would put the origin. Check the assembly, or ' +
          'the motifs.',
      )
    }
    rows.push({
      sequence: name,
      length,
      topology: round ? 'circular' : 'linear',
      // Display form: 1-based, as every coordinate a reader sees (§26.1).
      ori: call.ori + 1,
      ter: call.ter + 1,
      rule: RULE_WORDS[call.rule],
      parS: par.starts.length,
      parSCluster: call.parS?.count ?? 0,
      matS: mat.starts.length,
      ratio,
    })
  }
  job.progress(names.length, names.length, 'done')

  if (skipped.length > 0) {
    job.note(
      `${skipped.length.toLocaleString()} ${skipped.length === 1 ? 'sequence was' : 'sequences were'} ` +
        `not placed — not in the reference, or shorter than four skew windows: ` +
        `${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? ', …' : ''}.`,
    )
  }
  if (rows.length === 0) return []
  if (coverageEntry === null) {
    job.note('No coverage track was chosen, so there is no ori/ter ratio and no coverage step.')
  }
  const linear = rows.filter((row) => row.topology === 'linear').length
  if (linear > 0) {
    job.note(
      `${linear.toLocaleString()} ${linear === 1 ? 'sequence was' : 'sequences were'} read as ` +
        'linear. A bacterial chromosome is usually circular — tick it in the Chromosomes table and ' +
        'run this again, or the origin at its first base is split between its two ends.',
    )
  }

  const reference = job.inputs.labels?.[entry] ?? 'reference'
  const outputs: TaskOutput[] = [
    {
      kind: 'intervals',
      id: 'oriter-loci',
      label: `Origin and terminus · ${reference}`,
      payload: { kind: 'features', data: loci.finish() },
      noun: { one: 'locus', many: 'loci' },
      // Places, as the sites below are: a track beside the map, and a point on
      // it where the reader puts them there (§18.7).
      display: 'lane',
      look: 'point',
    } satisfies IntervalsOutput,
  ]
  if (parCount > 0) {
    outputs.push({
      kind: 'intervals',
      id: 'oriter-pars',
      label: `parS sites · ${motifs.parS.pattern}`,
      payload: { kind: 'features', data: parSites.finish() },
      noun: { one: 'site', many: 'sites' },
      display: 'lane',
      look: 'point',
    })
  }
  if (matCount > 0) {
    outputs.push({
      kind: 'intervals',
      id: 'oriter-mats',
      label: `matS sites · ${motifs.matS.pattern}`,
      payload: { kind: 'features', data: matSites.finish() },
      noun: { one: 'site', many: 'sites' },
      display: 'lane',
      look: 'point',
    })
  }

  // The smoothed coverage on the map's own bins, where there is a grid to put
  // it on — the curve the ratio was read from, to be looked at beside the raw.
  const binsize = job.framing.binsize
  if (fits.size > 0 && binsize > 0 && grid.length > 0) {
    const total = grid.reduce((sum, contig) => sum + Math.max(1, Math.ceil(contig.length / binsize)), 0)
    const values = new Float32Array(total).fill(Number.NaN)
    let startBin = 0
    for (const contig of grid) {
      const bins = Math.max(1, Math.ceil(contig.length / binsize))
      const at = fits.get(contig.name)
      if (at !== undefined) {
        for (let b = 0; b < bins; b++) {
          values[startBin + b] = at(Math.min(contig.length - 1, (b + 0.5) * binsize))
        }
      }
      startBin += bins
    }
    const coverageLabel = job.inputs.labels?.[coverageEntry ?? ''] ?? 'coverage'
    outputs.push({
      kind: 'profile',
      id: 'oriter-coverage-fit',
      label: `${coverageLabel} · spline fit`,
      values,
      extent: [0, total],
      binsize,
      unit: '',
    } satisfies ProfileOutput)
  }

  outputs.push({
    kind: 'table',
    id: 'oriter-table',
    label: 'Origin and terminus per sequence',
    columns: [
      { key: 'sequence', label: 'sequence', kind: 'text' },
      { key: 'length', label: 'length', kind: 'number' },
      { key: 'topology', label: 'read as', kind: 'text' },
      { key: 'ori', label: 'ori', kind: 'number', hint: 'Centre of the origin locus, 1-based.' },
      { key: 'ter', label: 'ter', kind: 'number', hint: 'Centre of the terminus locus, 1-based.' },
      { key: 'rule', label: 'terminus placed by', kind: 'text' },
      { key: 'parS', label: 'parS', kind: 'number', hint: 'Sites found on this sequence.' },
      {
        key: 'parSCluster',
        label: 'in cluster',
        kind: 'number',
        hint: 'parS sites within an eighth of the sequence of the densest one.',
      },
      { key: 'matS', label: 'matS', kind: 'number', hint: 'Sites found on this sequence.' },
      {
        key: 'ratio',
        label: 'ori/ter',
        kind: 'number',
        digits: 2,
        hint: 'Highest over lowest smoothed coverage: copies of the origin per copy of the terminus.',
      },
    ],
    rows,
  } satisfies TableOutput)
  return outputs
}
