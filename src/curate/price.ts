/**
 * A step's price (SPECS §33.3): what it does to the genomes it touches, in the
 * reader's own grades — every changed genome's completeness and redundancy,
 * before → after — printed before a key is pressed. Pure: two answers, the
 * binning as it stands and as it would be.
 */

import type { CurationStateResult } from '../worker/curateProtocol'
import type { Quality } from './quality'
import { grade } from './ui/grade'

/** One genome a step changes. */
export interface PriceRow {
  id: string
  name: string
  kind: 'mag' | 'element'
  /** Its quality as it would be; `null` without markers. */
  after: Quality | null
  /** The genomes its contigs come from, with their quality now, itself first where it was there. */
  from: Array<{ id: string; name: string; quality: Quality | null; contigs: number }>
  /** Its grade now (its own, or its first source's) and after. */
  gradeBefore: ReturnType<typeof grade>
  gradeAfter: ReturnType<typeof grade>
}

/** The genomes a step changes, as it would leave them, MAGs first. */
export function priceOf(before: CurationStateResult, after: CurationStateResult): PriceRow[] {
  const sources = new Map<number, Map<number, number>>()
  const n = Math.min(before.genomeOf.length, after.genomeOf.length)
  const touched = new Set<number>()
  for (let c = 0; c < n; c++) {
    const a = after.genomeOf[c]
    const b = before.genomeOf[c]
    const was = b < 0 ? null : before.genomes[b].id
    const now = a < 0 ? null : after.genomes[a].id
    if (was === now) continue
    if (a >= 0) touched.add(a)
    // A genome that lost a contig is touched too, where it is still there.
    if (b >= 0) {
      const still = after.genomes.findIndex((genome) => genome.id === was)
      if (still >= 0) touched.add(still)
    }
  }
  for (let c = 0; c < n; c++) {
    const a = after.genomeOf[c]
    if (a < 0 || !touched.has(a)) continue
    const b = before.genomeOf[c]
    if (b < 0) continue
    let from = sources.get(a)
    if (from === undefined) sources.set(a, (from = new Map()))
    from.set(b, (from.get(b) ?? 0) + 1)
  }
  const rows: PriceRow[] = []
  for (const a of touched) {
    const genome = after.genomes[a]
    const self = before.genomes.findIndex((g) => g.id === genome.id)
    const from = [...(sources.get(a) ?? new Map<number, number>())]
      .sort((x, y) => (x[0] === self ? -1 : y[0] === self ? 1 : y[1] - x[1] || x[0] - y[0]))
      .map(([b, contigs]) => ({ id: before.genomes[b].id, name: before.genomes[b].name, quality: before.genomes[b].quality, contigs }))
    if (self >= 0 && !from.some((f) => f.id === genome.id)) from.unshift({ id: genome.id, name: before.genomes[self].name, quality: before.genomes[self].quality, contigs: 0 })
    const first = from[0]?.quality ?? null
    rows.push({
      id: genome.id,
      name: genome.name,
      kind: genome.kind,
      after: genome.quality,
      from,
      gradeBefore: first === null ? null : grade(first.weightedCompleteness, first.weightedRedundancy),
      gradeAfter: genome.quality === null ? null : grade(genome.quality.weightedCompleteness, genome.quality.weightedRedundancy),
    })
  }
  return rows.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'mag' ? -1 : 1) || x.name.localeCompare(y.name))
}

/** A grade's rank: higher is better; contaminated is the lowest. */
function rank(g: ReturnType<typeof grade>): number {
  switch (g) {
    case 'high':
      return 4
    case 'medium':
      return 3
    case 'low':
      return 2
    case null:
      return 1
    case 'contaminated':
      return 0
  }
}

/** Whether a row's grade falls, and whether it reaches high quality. */
export function priceVerdict(row: PriceRow): 'demoted' | 'promoted' | null {
  if (row.kind !== 'mag' || row.after === null) return null
  const before = rank(row.gradeBefore)
  const after = rank(row.gradeAfter)
  if (after < before) return 'demoted'
  if (row.gradeAfter === 'high' && row.gradeBefore !== 'high') return 'promoted'
  return null
}

/** `64% + 35% → 99%` and `1.01 + 1.00 → 1.04`: a row's numbers, weighted, in a line each. */
export function priceLines(row: PriceRow): { completeness: string; redundancy: string } | null {
  if (row.after === null) return null
  const parts = row.from.filter((f) => f.quality !== null)
  const pct = (x: number): string => `${Math.round(x * 100)}%`
  const ratio = (x: number): string => x.toFixed(2)
  const was = (pick: (q: Quality) => number, form: (x: number) => string): string =>
    parts.length === 0 ? 'none' : parts.map((f) => form(pick(f.quality as Quality))).join(' + ')
  return {
    completeness: `${was((q) => q.weightedCompleteness, pct)} → ${pct(row.after.weightedCompleteness)}`,
    redundancy: `${was((q) => q.weightedRedundancy, ratio)} → ${ratio(row.after.weightedRedundancy)}`,
  }
}
