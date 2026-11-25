/**
 * A curation's steps in words (SPECS §33.2), as the stage's history lists them:
 * what was done, to which genomes and contigs, in the names the genomes had
 * when it was done — the history keeps a genome's whole name (§33.3), and a
 * step names a genome by its id, which its name may have changed from since.
 *
 * A gesture's steps (§33.1) are one row: *dissolve A, B, C*, *link E, F to M*,
 * or their words one after the other where they are steps of several kinds.
 *
 * Pure: no DOM. The suggestions card says what it turned down with
 * {@link declinedWords}, and prints every suggestion's words with short names
 * through {@link shortWords}.
 */

import type { BaseBinning, CurationEntry, CurationStep, GenomeKind } from '../genome/curation'
import type { StepAuthor } from '../genome/history'

/** A genome's name as a row prints it, by its id. */
export type NameOf = (id: string) => string

/** How many names a list prints before it counts the rest. */
const LISTED = 3

/** Text from an untrusted step's field: a record read back may hold anything. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '?'
}

/** An untrusted step's contigs: names only. */
function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
}

/** `4,573` as the history prints counts, whatever the reader's locale. */
function count(n: number): string {
  return n.toLocaleString('en-US')
}

/** Contigs as words: its name for one, a count for more. */
export function contigWords(contigs: readonly string[]): string {
  if (contigs.length === 0) return 'no contig'
  return contigs.length === 1 ? contigs[0] : `${count(contigs.length)} contigs`
}

/** Names as a list: `A, B, C`, then `and 23 more`. */
export function listWords(list: readonly string[]): string {
  if (list.length <= LISTED) return list.join(', ')
  return `${list.slice(0, LISTED).join(', ')} and ${count(list.length - LISTED)} more`
}

function kindWord(kind: GenomeKind, plural = false): string {
  if (plural) return kind === 'mag' ? 'MAGs' : 'elements'
  return kind === 'mag' ? 'MAG' : 'element'
}

/**
 * One step in words: *merge A, B into C*, *recruit 27 contigs into C*, *move X
 * to C*, *unbin X*, *dissolve C*, *new MAG N of 12 contigs*, *make X a MAG*,
 * *link E to M*, *unlink E from M*, *rename C to D*.
 *
 * @param nameOf A genome's name by its id, as it was when the step was made.
 * @param recruited Whether a move's contigs were all in the pool before it:
 *   a recruit, said as one.
 */
export function curationStepText(step: CurationStep, nameOf: NameOf = (id) => id, recruited = false): string {
  const name = (id: unknown): string => nameOf(text(id))
  switch (step.op) {
    case 'move': {
      const contigs = contigWords(names(step.contigs))
      if (step.to === null) return `unbin ${contigs}`
      return recruited ? `recruit ${contigs} into ${name(step.to)}` : `move ${contigs} to ${name(step.to)}`
    }
    case 'create':
      return `new ${kindWord(step.kind === 'element' ? 'element' : 'mag')} ${text(step.name)} of ${contigWords(names(step.contigs))}`
    case 'merge':
      return `merge ${listWords(names(step.genomes).map((id) => nameOf(id)))} into ${name(step.into)}`
    case 'dissolve':
      return `dissolve ${name(step.genome)}`
    case 'rename':
      return `rename ${name(step.genome)} to ${text(step.name)}`
    case 'retype':
      return `make ${name(step.genome)} ${step.kind === 'element' ? 'an element' : 'a MAG'}`
    case 'link':
      return `link ${name(step.element)} to ${name(step.mag)}`
    case 'unlink':
      return `unlink ${name(step.element)} from ${name(step.mag)}`
    default:
      // A step a newer build wrote, kept and not applied (§33.2).
      return 'a step this version does not know'
  }
}

/**
 * A gesture's steps (§33.1) in words, for its one row: steps of one kind said
 * once — *dissolve A, B, C*, *make A, B elements*, *link E, F to M*, *move 12
 * contigs to C* —, steps of several kinds one after the other.
 */
export function gestureText(steps: readonly CurationStep[], nameOf: NameOf = (id) => id, recruited: readonly boolean[] = []): string {
  if (steps.length === 0) return ''
  if (steps.length === 1) return curationStepText(steps[0], nameOf, recruited[0] === true)
  const all = <S extends CurationStep>(test: (step: CurationStep) => step is S): readonly S[] | null => (steps.every(test) ? (steps as readonly S[]) : null)
  const same = <T>(values: readonly T[]): boolean => values.every((value) => value === values[0])
  const dissolved = all((step): step is Extract<CurationStep, { op: 'dissolve' }> => step.op === 'dissolve')
  if (dissolved !== null) return `dissolve ${listWords(dissolved.map((step) => nameOf(text(step.genome))))}`
  const retyped = all((step): step is Extract<CurationStep, { op: 'retype' }> => step.op === 'retype')
  if (retyped !== null && same(retyped.map((step) => step.kind))) {
    return `make ${listWords(retyped.map((step) => nameOf(text(step.genome))))} ${kindWord(retyped[0].kind === 'element' ? 'element' : 'mag', true)}`
  }
  for (const op of ['link', 'unlink'] as const) {
    const linked = all((step): step is Extract<CurationStep, { op: typeof op }> => step.op === op)
    if (linked === null) continue
    const by = op === 'link' ? 'to' : 'from'
    if (same(linked.map((step) => step.mag))) return `${op} ${listWords(linked.map((step) => nameOf(text(step.element))))} ${by} ${nameOf(text(linked[0].mag))}`
    if (same(linked.map((step) => step.element))) return `${op} ${nameOf(text(linked[0].element))} ${by} ${listWords(linked.map((step) => nameOf(text(step.mag))))}`
  }
  const moved = all((step): step is Extract<CurationStep, { op: 'move' }> => step.op === 'move')
  if (moved !== null && same(moved.map((step) => step.to))) {
    const contigs = moved.flatMap((step) => names(step.contigs))
    return curationStepText({ op: 'move', contigs, to: moved[0].to }, nameOf, recruited.length === steps.length && recruited.every(Boolean))
  }
  return steps.map((step, k) => curationStepText(step, nameOf, recruited[k] === true)).join('; ')
}

/** A row of the history: one step, or a gesture's steps. */
export interface HistoryRow {
  /** The history's entries it holds, `from` to `to` (exclusive): `to` is where a press puts the cursor. */
  from: number
  to: number
  /** The row in words. */
  text: string
  /** Each step in words, for its title. */
  steps: string[]
  /** Who made it: a gesture's steps are all one author's. */
  by: StepAuthor
  /** The suggestion it was, as the history keeps it, where it was one. */
  suggestion?: string
}

/**
 * The history's rows, each in the names the genomes had when it was made: the
 * steps replayed for their names and for where their contigs came from, a
 * gesture's steps one row.
 *
 * Every step is one pass over what it names. The file's contigs are read only
 * for the contigs a step moves, and only those not in `homes` — where each
 * moved contig is in the file, kept by the caller from one history to the
 * next — until the last of them is found.
 *
 * @param homes Each contig's genome in the file by name (`null` for the pool),
 *   filled here as contigs are looked up.
 */
export function historyRows(file: BaseBinning, history: readonly CurationEntry[], homes: Map<string, string | null> = new Map()): HistoryRow[] {
  const nameNow = new Map<string, string>(file.genomes.map((genome) => [genome.name, genome.name]))
  const nameOf: NameOf = (id) => nameNow.get(id) ?? id
  // Where each moved contig is: a genome's id, or null for the pool; a genome
  // merged away or dissolved an alias of where its contigs went.
  const moved = new Set<string>()
  for (const entry of history) {
    const step = entry.step
    if (step.op === 'move' && step.to !== null) for (const name of names(step.contigs)) moved.add(name)
  }
  const wanted = new Set([...moved].filter((name) => !homes.has(name)))
  for (let c = 0; c < file.names.length && wanted.size > 0; c++) {
    const name = file.names[c]
    if (!wanted.delete(name)) continue
    const g = file.genomeOf[c]
    homes.set(name, g >= 0 ? (file.genomes[g]?.name ?? null) : null)
  }
  const owner = new Map<string, string | null>()
  for (const name of moved) if (homes.has(name)) owner.set(name, homes.get(name) ?? null)
  const alias = new Map<string, string | null>()
  const live = new Set(file.genomes.map((genome) => genome.name))
  const where = (contig: string): string | null => {
    let at = owner.get(contig) ?? null
    for (let hops = 0; at !== null && alias.has(at) && hops < 10_000; hops++) at = alias.get(at) ?? null
    return at
  }
  const replay = (step: CurationStep): void => {
    switch (step.op) {
      case 'move':
        if (step.to === null) {
          for (const name of names(step.contigs)) if (owner.has(name)) owner.set(name, null)
        } else if (live.has(text(step.to))) for (const name of names(step.contigs)) if (owner.has(name) || moved.has(name)) owner.set(name, step.to)
        return
      case 'create':
        if (live.has(text(step.id)) || alias.has(text(step.id))) return
        live.add(text(step.id))
        nameNow.set(text(step.id), text(step.name))
        for (const name of names(step.contigs)) if (owner.has(name) || moved.has(name)) owner.set(name, text(step.id))
        return
      case 'merge': {
        const into = text(step.into)
        if (!live.has(into)) return
        for (const id of names(step.genomes)) {
          if (id === into || !live.has(id)) continue
          live.delete(id)
          alias.set(id, into)
        }
        return
      }
      case 'dissolve':
        if (!live.has(text(step.genome))) return
        live.delete(text(step.genome))
        alias.set(text(step.genome), null)
        return
      case 'rename':
        if (live.has(text(step.genome)) && typeof step.name === 'string' && step.name !== '') nameNow.set(step.genome, step.name)
        return
      default:
        return
    }
  }
  const rows: HistoryRow[] = []
  for (let from = 0; from < history.length; ) {
    const gesture = history[from].gesture
    let to = from + 1
    if (gesture !== undefined) while (to < history.length && history[to].gesture === gesture) to++
    const entries = history.slice(from, to)
    const steps = entries.map((entry) => entry.step)
    // Said in the names the genomes had as the gesture began; then made.
    const texts: string[] = []
    const recruited: boolean[] = []
    for (const step of steps) {
      const contigs = step.op === 'move' && step.to !== null ? names(step.contigs) : []
      const pooled = contigs.length > 0 && contigs.every((name) => where(name) === null)
      recruited.push(pooled)
      texts.push(curationStepText(step, nameOf, pooled))
    }
    const textOf = gestureText(steps, nameOf, recruited)
    for (const step of steps) replay(step)
    const first = entries[0]
    rows.push({ from, to, text: textOf, steps: texts, by: first.by, ...(first.suggestion === undefined ? {} : { suggestion: first.suggestion }) })
    from = to
  }
  return rows
}

/**
 * A suggestion's words with the genomes it names printed short: each whole
 * name in `short` replaced, word by word, so a name inside another is never
 * cut.
 */
export function shortWords(words: string, short: ReadonlyMap<string, string>): string {
  if (short.size === 0) return words
  return words.replace(/[^\s,]+/g, (token) => short.get(token) ?? token)
}

/**
 * What a suggestion turned down was, from its key alone — for one the binning
 * no longer makes, which has no words of its own any more: `merge A and B`,
 * `recruit c into G`, `move c to G`, `link E to M`, `unlink E from M`.
 */
export function declinedWords(key: string, nameOf: NameOf = (id) => id): string {
  const colon = key.indexOf(':')
  if (colon < 0) return key
  const kind = key.slice(0, colon)
  const rest = key.slice(colon + 1)
  const arrow = rest.lastIndexOf('>')
  switch (kind) {
    case 'merge': {
      const ids = rest.split('+').map((id) => nameOf(id))
      return ids.length < 2 ? `merge ${ids.join('')}` : `merge ${listWords(ids.slice(0, -1))} and ${ids[ids.length - 1]}`
    }
    case 'recruit': {
      if (arrow >= 0) return `recruit ${rest.slice(0, arrow)} into ${nameOf(rest.slice(arrow + 1))}`
      // Sure recruits into one MAG, one suggestion: `recruit:<genome>:<contig>,<contig>…`.
      const last = rest.lastIndexOf(':')
      if (last < 0) return key
      return `recruit ${contigWords(rest.slice(last + 1).split(','))} into ${nameOf(rest.slice(0, last))}`
    }
    case 'move':
      return arrow < 0 ? key : `move ${rest.slice(0, arrow)} to ${nameOf(rest.slice(arrow + 1))}`
    case 'link':
      return arrow < 0 ? key : `link ${nameOf(rest.slice(0, arrow))} to ${nameOf(rest.slice(arrow + 1))}`
    case 'unlink':
      return arrow < 0 ? key : `unlink ${nameOf(rest.slice(0, arrow))} from ${nameOf(rest.slice(arrow + 1))}`
    default:
      return key
  }
}
