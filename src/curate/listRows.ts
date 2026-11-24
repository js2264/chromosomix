/**
 * The rows of the curation stage's genome list (SPECS §33.3), as plain data:
 * three sections — the MAGs, the elements, the unbinned pool — each a head and
 * its rows, a genome's contigs under it while it is open, filtered, sorted and
 * narrowed by the chips. The list draws these rows and nothing else, so what it
 * shows is decided, and tested, here.
 */

import type { CurationStateResult } from '../worker/curateProtocol'
import { shortName } from './names'

/** The list's three sections. */
export type ListSection = 'mags' | 'elements' | 'pool'

/** One row of the list. */
export type ListRow =
  | { kind: 'section'; section: ListSection; genomes: number; contigs: number; length: number; open: boolean; shown: number }
  /** A genome; `byFilter` where the filter shows it on its hits, open until the reader closes it. */
  | { kind: 'genome'; genome: number; id: string; open: boolean; byFilter?: boolean }
  | { kind: 'contig'; contig: number; genome: number }

/** How a genome section is sorted. */
export type GenomeSort = 'order' | 'length' | 'completeness' | 'redundancy' | 'contigs' | 'suggestions' | 'name'

/** How the pool is sorted: its likeliest recruits first, or by length, or name. */
export type PoolSort = 'likeliest' | 'length' | 'name'

/** The chips that narrow the list, each lit or not. */
export type ListChip = 'changed' | 'suggested' | 'complete' | 'redundant' | 'unhosted'

/** A genome is complete enough for the chip at this weighted completeness, and redundant above this. */
export const CHIP_COMPLETE = 0.5
export const CHIP_REDUNDANT = 1.1

/** What a filter box holds, read. */
export type ListFilter =
  | { kind: 'text'; text: string }
  | { kind: 'regex'; pattern: RegExp }
  | { kind: 'names'; names: ReadonlySet<string> }
  /** A `/…/` that is not a pattern: it finds nothing, and says why. */
  | { kind: 'invalid'; reason: string }

/**
 * A filter box's text, read: `/…/` a pattern, several names (split on spaces,
 * commas or lines) a pasted list matched exactly, anything else — one name,
 * whatever separator was copied with it — a substring matched in any case.
 * `null` for an empty box; a `/…/` that does not compile finds nothing and
 * says why.
 */
export function readFilter(text: string): ListFilter | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const regex = /^\/(.+)\/([imsu]*)$/.exec(trimmed)
  if (regex !== null) {
    try {
      return { kind: 'regex', pattern: new RegExp(regex[1], regex[2].includes('i') ? regex[2] : `${regex[2]}i`) }
    } catch (error) {
      return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  const names = trimmed.split(/[\s,;]+/).filter((name) => name !== '')
  if (names.length > 1) return { kind: 'names', names: new Set(names) }
  return { kind: 'text', text: (names[0] ?? trimmed).toLowerCase() }
}

/** Whether a name passes a filter. */
export function passes(filter: ListFilter, name: string): boolean {
  switch (filter.kind) {
    case 'text':
      return name.toLowerCase().includes(filter.text)
    case 'regex':
      return filter.pattern.test(name)
    case 'names':
      return filter.names.has(name)
    case 'invalid':
      return false
  }
}

/** Everything the rows are made from. */
export interface ListInput {
  answer: CurationStateResult
  /** The genomes' ids in the stage's order. */
  order: readonly string[]
  names: readonly string[]
  lengths: readonly number[]
  /** Genomes open, by id. */
  open: ReadonlySet<string>
  /** Genomes a filter opened on their contigs that the reader closed, by id. */
  closed?: ReadonlySet<string>
  /** Sections folded. */
  folded: ReadonlySet<ListSection>
  genomeSort: GenomeSort
  poolSort: PoolSort
  /** Descending instead of the sort's own direction. */
  reversed?: boolean
  filter: ListFilter | null
  chips: ReadonlySet<ListChip>
  /** Suggestions on offer naming each genome, by index of the answer's. */
  suggested: ArrayLike<number>
  /** Each pool contig's likeliest recruit's confidence, `0` for none. */
  poolLikeliness: ArrayLike<number>
  /**
   * Whether each genome wears a change (`curate/changes.ts`'s chip), by index
   * of the answer's: what the *changed* chip keeps — a renamed genome too.
   * Without it, the genomes not as in the file.
   */
  changed?: ArrayLike<boolean>
  /** Each section's shared prefix: a pasted list of the names the list prints finds them. */
  prefixes?: { mag: string; element: string }
}

/** What a list holds: its rows, and per section how many of its rows a filter or a chip left. */
export interface ListRows {
  rows: ListRow[]
  /** Names a pasted list holds that no genome and no contig has. */
  missing: string[]
  /** Genomes and contigs a filter found, for *select them*. */
  found: { genomes: number[]; contigs: number[] }
  /** Names of a pasted list that exist but the chips hide. */
  hidden?: number
}

/** The list's rows. */
export function listRows(input: ListInput): ListRows {
  const { answer, names, lengths, filter } = input
  const index = new Map(answer.genomes.map((genome, g) => [genome.id, g]))
  const ordered = input.order.map((id) => index.get(id)).filter((g): g is number => g !== undefined)
  // Genomes not in the order (a count arriving before the order is kept) go last.
  const placed = new Set(ordered)
  answer.genomes.forEach((_, g) => {
    if (!placed.has(g)) ordered.push(g)
  })
  const contigsOf: number[][] = answer.genomes.map(() => [])
  const pool: number[] = []
  answer.genomeOf.forEach((g, c) => (g < 0 ? pool : contigsOf[g]).push(c))
  const longestFirst = (a: number, b: number): number => lengths[b] - lengths[a] || a - b
  for (const list of contigsOf) list.sort(longestFirst)
  const linked = new Set(answer.links.map((link) => link.element))

  // A genome passes the filter on its name — the whole, or the short one the
  // list prints — or on a contig's: then its contigs that pass are shown under
  // it, open.
  const found = { genomes: [] as number[], contigs: [] as number[] }
  const prefixOf = (g: number): string => (answer.genomes[g].kind === 'mag' ? (input.prefixes?.mag ?? '') : (input.prefixes?.element ?? ''))
  const genomePasses = (g: number): boolean => {
    if (filter === null) return true
    const name = answer.genomes[g].name
    if (passes(filter, name)) return true
    return filter.kind === 'names' && filter.names.has(shortName(name, prefixOf(g)))
  }
  const contigPasses = (c: number): boolean => filter === null || passes(filter, names[c] ?? '')
  // A pasted list's names that exist, whatever the chips hide.
  const seen = new Set<string>()
  if (filter?.kind === 'names') {
    answer.genomes.forEach((genome, g) => {
      if (filter.names.has(genome.name)) seen.add(genome.name)
      const short = shortName(genome.name, prefixOf(g))
      if (filter.names.has(short)) seen.add(short)
    })
    for (const name of names) if (filter.names.has(name)) seen.add(name)
  }
  const chipped = (g: number): boolean => {
    const genome = answer.genomes[g]
    for (const chip of input.chips) {
      if (chip === 'changed' && !(input.changed === undefined ? !genome.asInFile : input.changed[g] === true)) return false
      if (chip === 'suggested' && !((input.suggested[g] ?? 0) > 0)) return false
      // Quality is a MAG's word: an element with a marker twice is not redundant.
      if (chip === 'complete' && !(genome.kind === 'mag' && (genome.quality?.weightedCompleteness ?? 0) >= CHIP_COMPLETE)) return false
      if (chip === 'redundant' && !(genome.kind === 'mag' && (genome.quality?.weightedRedundancy ?? 0) > CHIP_REDUNDANT)) return false
      if (chip === 'unhosted' && (genome.kind !== 'element' || linked.has(genome.id))) return false
    }
    return true
  }
  const shownNames = new Set<string>()

  const rows: ListRow[] = []
  for (const section of ['mags', 'elements'] as const) {
    const kind = section === 'mags' ? 'mag' : 'element'
    const members = ordered.filter((g) => answer.genomes[g].kind === kind)
    let contigs = 0
    let length = 0
    for (const g of members) {
      contigs += answer.genomes[g].contigs
      length += answer.genomes[g].length
    }
    const shown: Array<{ genome: number; contigs: number[] | null }> = []
    for (const g of members) {
      if (!chipped(g)) continue
      const genome = answer.genomes[g]
      if (filter === null) {
        shown.push({ genome: g, contigs: null })
        continue
      }
      const byName = genomePasses(g)
      const hits = contigsOf[g].filter(contigPasses)
      if (byName) {
        found.genomes.push(g)
        shownNames.add(genome.name)
        shownNames.add(shortName(genome.name, prefixOf(g)))
      }
      // One by one: a match of every contig is past what one call's arguments hold.
      for (const c of hits) {
        found.contigs.push(c)
        shownNames.add(names[c])
      }
      // Found by its own name, a genome is shown as it is; found by its
      // contigs', it opens on them.
      if (byName) shown.push({ genome: g, contigs: null })
      else if (hits.length > 0) shown.push({ genome: g, contigs: hits })
    }
    sortGenomes(shown, input, answer)
    const open = !input.folded.has(section)
    rows.push({ kind: 'section', section, genomes: members.length, contigs, length, open, shown: shown.length })
    if (!open) continue
    for (const { genome: g, contigs: hits } of shown) {
      const id = answer.genomes[g].id
      // Opened by the filter on its hits until the reader closes it.
      const isOpen = hits !== null ? input.closed?.has(id) !== true : input.open.has(id)
      rows.push(hits !== null ? { kind: 'genome', genome: g, id, open: isOpen, byFilter: true } : { kind: 'genome', genome: g, id, open: isOpen })
      if (!isOpen) continue
      for (const c of hits ?? contigsOf[g]) rows.push({ kind: 'contig', contig: c, genome: g })
    }
  }
  // The pool: its contigs. Of the chips, only *suggested* says anything of a
  // contig — one a suggestion would recruit; the others are about genomes, and
  // leave the pool showing nothing.
  const genomeChips = [...input.chips].some((chip) => chip !== 'suggested')
  const poolShown = genomeChips ? [] : pool.filter((c) => contigPasses(c) && (!input.chips.has('suggested') || (input.poolLikeliness[c] ?? 0) > 0))
  if (filter !== null)
    for (const c of poolShown) {
      found.contigs.push(c)
      shownNames.add(names[c])
    }
  sortPool(poolShown, input)
  let poolLength = 0
  for (const c of pool) poolLength += lengths[c] ?? 0
  const poolOpen = !input.folded.has('pool')
  rows.push({ kind: 'section', section: 'pool', genomes: 0, contigs: pool.length, length: poolLength, open: poolOpen, shown: poolShown.length })
  if (poolOpen) for (const c of poolShown) rows.push({ kind: 'contig', contig: c, genome: -1 })

  const missing = filter?.kind === 'names' ? [...filter.names].filter((name) => !seen.has(name)) : []
  const hidden = filter?.kind === 'names' ? [...seen].filter((name) => !shownNames.has(name)).length : 0
  return { rows, missing, found, hidden }
}

function sortGenomes(shown: Array<{ genome: number }>, input: ListInput, answer: CurationStateResult): void {
  const sort = input.genomeSort
  if (sort === 'order') {
    if (input.reversed === true) shown.reverse()
    return
  }
  const value = (g: number): number | string => {
    const genome = answer.genomes[g]
    switch (sort) {
      case 'length':
        return genome.length
      case 'completeness':
        return genome.quality?.weightedCompleteness ?? -1
      case 'redundancy':
        return genome.quality?.weightedRedundancy ?? -1
      case 'contigs':
        return genome.contigs
      case 'suggestions':
        return input.suggested[g] ?? 0
      case 'name':
        return genome.name
    }
  }
  // Numbers largest first, names A to Z; ties in the stage's order.
  const rank = new Map(shown.map((row, k) => [row.genome, k]))
  const sign = input.reversed === true ? -1 : 1
  shown.sort((a, b) => {
    const va = value(a.genome)
    const vb = value(b.genome)
    let by = 0
    if (typeof va === 'string' && typeof vb === 'string') by = va < vb ? -1 : va > vb ? 1 : 0
    else by = (vb as number) - (va as number)
    return sign * by || (rank.get(a.genome) ?? 0) - (rank.get(b.genome) ?? 0)
  })
}

function sortPool(contigs: number[], input: ListInput): void {
  const { lengths, names } = input
  const sign = input.reversed === true ? -1 : 1
  switch (input.poolSort) {
    case 'likeliest':
      contigs.sort((a, b) => sign * ((input.poolLikeliness[b] ?? 0) - (input.poolLikeliness[a] ?? 0)) || lengths[b] - lengths[a] || a - b)
      return
    case 'length':
      contigs.sort((a, b) => sign * (lengths[b] - lengths[a]) || a - b)
      return
    case 'name':
      contigs.sort((a, b) => sign * (names[a] < names[b] ? -1 : names[a] > names[b] ? 1 : 0) || a - b)
  }
}

/** What a row is, as a key a virtual list keeps a row's element by. */
export function rowKey(row: ListRow): string {
  switch (row.kind) {
    case 'section':
      return `s:${row.section}`
    case 'genome':
      return `g:${row.id}`
    case 'contig':
      return `c:${row.contig}`
  }
}
