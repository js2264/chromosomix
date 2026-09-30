/**
 * An edit of the reference, and the lens it makes (SPECS §27.2).
 *
 * The **original** is the assembly the opened file names — its sequences, as
 * spelt, at their lengths. An **edit** is what the reader has done to it: a
 * history of **steps**, each one operation, whose fold from the identity is the
 * **edited assembly** — edited sequences, each an ordered list of **pieces**
 * (a stretch of one original sequence, forward or reversed) and **gaps** of
 * `N`. A stretch taken out is **set aside**, with a reason. The mapping between
 * the two assemblies is the **lens**, and the whole session is drawn through
 * it; the file itself is read exactly as it would be without one (§13).
 *
 * Pure: no DOM, no worker, no reader. The reader worker builds its slot maps
 * from {@link EditedAssembly}, the axes build their segments from it, the stage
 * folds steps into it, the exports write it, and the command line replays it —
 * so it is one module, and every question about where a base went is answered
 * here or nowhere.
 *
 * ## The two directions
 *
 * **Edited → original is a function** ({@link EditedAssembly.toOriginal}): every
 * edited base lies in exactly one piece or one gap. **Original → edited is a
 * relation** ({@link EditedAssembly.landings}): a base lands once, not at all
 * (set aside), or more than once (duplicated) — the shape §8.15 gave circular
 * sequences, and the reason every caller that draws *at* a locus draws at every
 * landing.
 *
 * ## Coordinates
 *
 * 0-based and half-open, in base pairs, everywhere in this module — the machine
 * form of §26.1. A step is recorded in the **edited** coordinates it was made
 * in, and the history is replayed from the identity, so a step always means
 * what it meant when it was made.
 */

/** A stretch of one original sequence, placed in an edited sequence. */
export interface Piece {
  /** Stable across later steps, so a label, a suggestion or a test can name it. */
  id: string
  /** An original sequence's name, exactly as the file spells it. */
  sequence: string
  /** 0-based, half-open, on the original. */
  start: number
  end: number
  /** `-1`: read from `end` to `start`, and complemented. */
  strand: 1 | -1
}

/** A run of `N` between two pieces, as an AGP types it. */
export interface Gap {
  gap: number
}

export type Part = Piece | Gap

export function isGap(part: Part): part is Gap {
  return (part as Gap).gap !== undefined
}

/** One sequence of the edited assembly. */
export interface EditedSequence {
  name: string
  parts: Part[]
  /** Declared circular: its last base is followed by its first (§8.15). */
  circular?: boolean
  /**
   * Named by the reader (§27.3): it keeps the name it was given where its
   * parts are an original's, whole, again — which would otherwise take the
   * original's name back.
   */
  named?: boolean
}

/** Why a stretch was taken out of the assembly. */
export type AsideReason = 'debris' | 'contaminant' | 'haplotig' | 'unplaced'

/** Every reason, in the order a menu offers them. */
export const ASIDE_REASONS: readonly AsideReason[] = ['debris', 'contaminant', 'haplotig', 'unplaced']

/** A stretch taken out of the edited assembly, and why. */
export interface Aside {
  piece: Piece
  why: AsideReason
  /**
   * The genome of a metagenome it belongs to instead (§27.10), where it was
   * sent to one: a contaminant of this genome, and a contig of that one.
   */
  genome?: string
}

/** Which end of a sequence. */
export type SequenceEnd = 'start' | 'end'

/**
 * One operation, in the edited coordinates it was made in.
 *
 * `from` and `to` are a half-open stretch of `sequence`; `at` is a position
 * *between* two bases. Every position is clamped to its sequence, so a step
 * replayed on an edit that has since changed underneath it can only become
 * smaller, never refer outside.
 */
export type EditStep =
  | { op: 'cut'; sequence: string; at: number }
  | { op: 'invert'; sequence: string; from: number; to: number }
  | {
      op: 'move'
      sequence: string
      from: number
      to: number
      /** The sequence it goes into — the same one, or another. */
      into: string
      /** Where in `into`, measured **after** the stretch has been taken out. */
      at: number
      strand: 1 | -1
    }
  | {
      op: 'duplicate'
      sequence: string
      from: number
      to: number
      into: string
      /** Where in `into`, the original still in place. */
      at: number
      strand: 1 | -1
    }
  | {
      op: 'join'
      a: string
      aEnd: SequenceEnd
      b: string
      bEnd: SequenceEnd
      gap: number
      /**
       * Whose place in the order the joined sequence takes: `a`'s, which is
       * the default, or `b`'s — a sequence dropped on another's start lands
       * where the other was, as the hand said.
       */
      place?: 'a' | 'b'
    }
  | { op: 'split'; sequence: string; at: number; name?: string }
  | {
      op: 'aside'
      sequence: string
      from: number
      to: number
      why: AsideReason
      /** Where it belongs instead: another genome of the metagenome (§27.10). */
      genome?: string
    }
  | {
      /**
       * A contig of another genome brought into this one's edit (§27.10), whole,
       * as a sequence of its own after the others: one of the original's
       * {@link OriginalAssembly.elsewhere}.
       */
      op: 'bring'
      sequence: string
    }
  | { op: 'rotate'; sequence: string; at: number }
  | { op: 'rename'; sequence: string; name: string }
  | { op: 'reorder'; names: string[] }
  | LayoutStep

/**
 * The whole assembly laid out as a file describes it — an AGP or a Juicebox
 * `.assembly` read back (SPECS §27.8). Unlike every other step it is written in
 * the **original's** coordinates, since that is what such a file names, and it
 * replaces whatever the history had built: the steps after it apply to it.
 * Whatever of the original it leaves out is set aside, unplaced.
 */
export interface LayoutStep {
  op: 'layout'
  /** The file it was read from, as the history names it. */
  from: string
  sequences: Array<{ name: string; parts: LayoutPart[]; circular?: boolean }>
  aside: Array<{ sequence: string; start: number; end: number; why: AsideReason; genome?: string }>
}

/** A stretch of an original sequence, or a run of `N`, as a layout names it. */
export type LayoutPart = { sequence: string; start: number; end: number; strand: 1 | -1 } | { gap: number }

/** Who made a step. */
export type StepAuthor = 'reader' | 'suggestion' | 'auto'

/** A step, with what the history keeps about it. */
export interface HistoryEntry {
  step: EditStep
  by: StepAuthor
  /** Milliseconds since the epoch. */
  when: number
  /** The suggestion it was, where it was one. */
  suggestion?: string
}

/** The assembly an edit was made against: names and lengths, in file order. */
export interface OriginalAssembly {
  names: readonly string[]
  lengths: readonly number[]
  /**
   * The genome of a metagenome the edit is of (§27.10), where it is of one:
   * its sequences are that genome's contigs, in the file's order — some of the
   * file's, not all of them — and the file's other genomes are not the edit's.
   */
  genome?: string
  /**
   * Contigs of the file's other genomes the edit may bring in (§27.10), each
   * with the genome it is of: none of the edit's assembly until a step brings
   * it, and the edit's own after.
   */
  elsewhere?: ReadonlyArray<{ name: string; length: number; genome: string }>
}

/** Every sequence an edit's steps may name, and its length: the original's, and those it may bring in. */
export function lengthsOf(original: OriginalAssembly): Map<string, number> {
  const out = new Map(original.names.map((name, i) => [name, original.lengths[i]]))
  for (const contig of original.elsewhere ?? []) if (!out.has(contig.name)) out.set(contig.name, contig.length)
  return out
}

/** An edit as it is kept: the original it applies to, and its history. */
export interface ReferenceEdit {
  version: 1
  original: OriginalAssembly
  history: HistoryEntry[]
  /** How many of {@link history} are applied; undo moves it back. */
  cursor: number
}

/** A position in an original sequence, with the strand it is read on there. */
export interface OriginalPlace {
  sequence: string
  bp: number
  strand: 1 | -1
}

/** A position in an edited sequence. */
export interface EditedPlace {
  sequence: string
  bp: number
  /** The strand of the piece it lands in: `-1` where the original is read backwards. */
  strand: 1 | -1
}

/** A stretch of an original sequence as one piece of an edited sequence covers it. */
export interface Landing {
  /** The edited sequence. */
  sequence: string
  /** Where the piece begins in it. */
  offset: number
  piece: Piece
}

// ---------------------------------------------------------------------------
// The identity, and names
// ---------------------------------------------------------------------------

/** An edit that has done nothing yet, against `original`. */
export function emptyEdit(original: OriginalAssembly): ReferenceEdit {
  return {
    version: 1,
    original: {
      names: [...original.names],
      lengths: [...original.lengths],
      ...(original.genome === undefined ? {} : { genome: original.genome }),
      ...(original.elsewhere === undefined ? {} : { elsewhere: original.elsewhere.map((contig) => ({ ...contig })) }),
    },
    history: [],
    cursor: 0,
  }
}

/**
 * The name an edited sequence gets when it is no longer an original one.
 *
 * `_e1`, `_e2`, … per original, never a suffix §5.9's matcher strips: `IV.1`
 * would be matched to `IV` by the `version` tier, and the tracks of `IV` drawn on
 * a sequence that is not it.
 */
function freshName(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const name = `${base}_e${n}`
    if (!taken.has(name)) return name
  }
}

// ---------------------------------------------------------------------------
// Parts arithmetic
// ---------------------------------------------------------------------------

function partLength(part: Part): number {
  return isGap(part) ? part.gap : part.end - part.start
}

/** The length of a list of parts, in base pairs. */
export function partsLength(parts: readonly Part[]): number {
  let total = 0
  for (const part of parts) total += partLength(part)
  return total
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

/**
 * Split a part `k` bases into it, in edited order.
 *
 * A reversed piece's first `k` edited bases are the **last** `k` of its original
 * stretch, which is the whole of what reversal means for arithmetic.
 */
function splitPart(part: Part, k: number, ids: IdSource): [Part, Part] {
  if (isGap(part)) return [{ gap: k }, { gap: part.gap - k }]
  if (part.strand === 1) {
    return [
      { ...part, id: ids.next(part.id), end: part.start + k },
      { ...part, id: ids.next(part.id), start: part.start + k },
    ]
  }
  return [
    { ...part, id: ids.next(part.id), start: part.end - k },
    { ...part, id: ids.next(part.id), end: part.end - k },
  ]
}

/** The parts before and after an edited position, cutting the part it falls in. */
function cutParts(parts: readonly Part[], at: number, ids: IdSource): [Part[], Part[]] {
  const left: Part[] = []
  const right: Part[] = []
  let offset = 0
  for (const part of parts) {
    const length = partLength(part)
    if (offset + length <= at) left.push(part)
    else if (offset >= at) right.push(part)
    else {
      const [a, b] = splitPart(part, at - offset, ids)
      left.push(a)
      right.push(b)
    }
    offset += length
  }
  return [left, right]
}

/** Before, inside and after a stretch of an edited sequence. */
function extractParts(
  parts: readonly Part[],
  from: number,
  to: number,
  ids: IdSource,
): [Part[], Part[], Part[]] {
  const [before, rest] = cutParts(parts, from, ids)
  const [middle, after] = cutParts(rest, to - from, ids)
  return [before, middle, after]
}

/** A list of parts read the other way: order reversed, every piece's strand flipped. */
export function reverseParts(parts: readonly Part[]): Part[] {
  const out: Part[] = []
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    out.push(isGap(part) ? { gap: part.gap } : { ...part, strand: part.strand === 1 ? -1 : 1 })
  }
  return out
}

/**
 * Adjacent pieces that continue each other are one piece again.
 *
 * Cut a sequence and put it back, and the history should leave a single piece
 * rather than two touching halves — which is what the AGP an export writes, and
 * the junctions a suggestion scores, would otherwise say was an edit.
 */
function merge(parts: readonly Part[]): Part[] {
  const out: Part[] = []
  for (const part of parts) {
    if (partLength(part) === 0) continue
    const last = out[out.length - 1]
    if (last !== undefined && isGap(last) && isGap(part)) {
      out[out.length - 1] = { gap: last.gap + part.gap }
      continue
    }
    if (last !== undefined && !isGap(last) && !isGap(part) && last.sequence === part.sequence && last.strand === part.strand) {
      if (part.strand === 1 && last.end === part.start) {
        out[out.length - 1] = { ...last, end: part.end }
        continue
      }
      if (part.strand === -1 && last.start === part.end) {
        out[out.length - 1] = { ...last, start: part.start }
        continue
      }
    }
    out.push(part)
  }
  return out
}

/** Mints piece ids that are stable for a given history: a replay makes the same ones. */
class IdSource {
  private counter = 0
  next(from: string): string {
    this.counter += 1
    return `${from.split('~')[0]}~${this.counter}`
  }
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/** The state a history folds into. */
interface Folded {
  sequences: EditedSequence[]
  aside: Aside[]
}

function identity(original: OriginalAssembly): Folded {
  return {
    sequences: original.names.map((name, i) => ({
      name,
      parts: [{ id: name, sequence: name, start: 0, end: original.lengths[i], strand: 1 }],
    })),
    aside: [],
  }
}

function find(folded: Folded, name: string): EditedSequence | null {
  return folded.sequences.find((sequence) => sequence.name === name) ?? null
}

/** Clamp a stretch to its sequence, and order its two ends. */
function stretch(sequence: EditedSequence, from: number, to: number): [number, number] {
  const length = partsLength(sequence.parts)
  const a = clamp(Math.round(from), 0, length)
  const b = clamp(Math.round(to), 0, length)
  return a <= b ? [a, b] : [b, a]
}

/**
 * Apply one step. A step that no longer applies — a sequence renamed away by a
 * later edit of the same history is impossible, but a stretch of no length is
 * not — leaves the state as it was, rather than failing the whole replay.
 */
function apply(state: Folded, step: EditStep, original: OriginalAssembly, ids: IdSource): Folded {
  const sequences = state.sequences.map((sequence) => ({ ...sequence, parts: [...sequence.parts] }))
  const next: Folded = { sequences, aside: [...state.aside] }
  const taken = new Set(sequences.map((sequence) => sequence.name))
  const originals = new Set(lengthsOf(original).keys())

  switch (step.op) {
    case 'cut': {
      const target = find(next, step.sequence)
      if (target === null) return state
      const at = clamp(Math.round(step.at), 0, partsLength(target.parts))
      const [left, right] = cutParts(target.parts, at, ids)
      target.parts = [...left, ...right]
      return next
    }
    case 'invert': {
      const target = find(next, step.sequence)
      if (target === null) return state
      const [from, to] = stretch(target, step.from, step.to)
      if (to === from) return state
      const [before, middle, after] = extractParts(target.parts, from, to, ids)
      target.parts = merge([...before, ...reverseParts(middle), ...after])
      return next
    }
    case 'move':
    case 'duplicate': {
      const source = find(next, step.sequence)
      const into = find(next, step.into)
      if (source === null || into === null) return state
      const [from, to] = stretch(source, step.from, step.to)
      if (to === from) return state
      const [before, middle, after] = extractParts(source.parts, from, to, ids)
      const carried = step.strand === 1 ? middle : reverseParts(middle)
      if (step.op === 'move') source.parts = merge([...before, ...after])
      else carried.forEach((part, i) => {
        if (!isGap(part)) carried[i] = { ...part, id: ids.next(part.id) }
      })
      const at = clamp(Math.round(step.at), 0, partsLength(into.parts))
      const [left, right] = cutParts(into.parts, at, ids)
      into.parts = merge([...left, ...carried, ...right])
      if (source !== into && source.parts.length === 0) {
        next.sequences = next.sequences.filter((sequence) => sequence !== source)
      }
      return next
    }
    case 'join': {
      const a = find(next, step.a)
      const b = find(next, step.b)
      if (a === null || b === null || a === b) return state
      // Orient both so that `a`'s joined end is its end and `b`'s is its start.
      const aParts = step.aEnd === 'end' ? a.parts : reverseParts(a.parts)
      const bParts = step.bEnd === 'start' ? b.parts : reverseParts(b.parts)
      const gap: Part[] = step.gap > 0 ? [{ gap: Math.round(step.gap) }] : []
      a.parts = merge([...aParts, ...gap, ...bParts])
      if (originals.has(a.name) && !isWhole(a, original)) {
        taken.delete(a.name)
        a.name = freshName(a.name, taken)
      }
      if (step.place === 'b') {
        // `a` leaves its own place and takes `b`'s.
        next.sequences = next.sequences.filter((sequence) => sequence !== a)
        next.sequences.splice(next.sequences.indexOf(b), 1, a)
      } else {
        next.sequences = next.sequences.filter((sequence) => sequence !== b)
      }
      return next
    }
    case 'split': {
      const target = find(next, step.sequence)
      if (target === null) return state
      const at = clamp(Math.round(step.at), 0, partsLength(target.parts))
      if (at === 0 || at === partsLength(target.parts)) return state
      const [left, right] = cutParts(target.parts, at, ids)
      target.parts = merge(left)
      const base = baseName(target.name)
      // The left half first, so the two halves are numbered in the order they
      // are read: `I_e1` then `I_e2`, never the right before the left.
      if (originals.has(target.name)) {
        taken.delete(target.name)
        target.name = freshName(base, taken)
        taken.add(target.name)
      }
      const name = step.name !== undefined && !taken.has(step.name) ? step.name : freshName(base, taken)
      taken.add(name)
      const index = next.sequences.indexOf(target)
      next.sequences.splice(index + 1, 0, { name, parts: merge(right) })
      return next
    }
    case 'aside': {
      const target = find(next, step.sequence)
      if (target === null) return state
      const [from, to] = stretch(target, step.from, step.to)
      if (to === from) return state
      const [before, middle, after] = extractParts(target.parts, from, to, ids)
      const genome = typeof step.genome === 'string' && step.genome !== '' ? step.genome : undefined
      for (const part of middle) if (!isGap(part)) next.aside.push({ piece: part, why: step.why, ...(genome === undefined ? {} : { genome }) })
      target.parts = merge([...before, ...after])
      if (target.parts.length === 0) next.sequences = next.sequences.filter((sequence) => sequence !== target)
      return next
    }
    case 'bring': {
      const contig = original.elsewhere?.find((candidate) => candidate.name === step.sequence)
      if (contig === undefined || !(contig.length > 0)) return state
      // Once: a contig already somewhere in the edit — brought before, or set
      // aside since — is not brought again.
      const held = (piece: Piece): boolean => piece.sequence === contig.name
      if (next.sequences.some((sequence) => sequence.parts.some((part) => !isGap(part) && held(part))) || next.aside.some((item) => held(item.piece))) {
        return state
      }
      const name = taken.has(contig.name) ? freshName(contig.name, taken) : contig.name
      next.sequences.push({ name, parts: [{ id: ids.next(contig.name), sequence: contig.name, start: 0, end: contig.length, strand: 1 }] })
      return next
    }
    case 'rotate': {
      const target = find(next, step.sequence)
      if (target === null) return state
      const at = clamp(Math.round(step.at), 0, partsLength(target.parts))
      const [left, right] = cutParts(target.parts, at, ids)
      target.parts = merge([...right, ...left])
      return next
    }
    case 'rename': {
      const target = find(next, step.sequence)
      if (target === null || step.name === '' || (taken.has(step.name) && step.name !== target.name)) return state
      // A name of the file's own is that sequence's, whole, and no other's.
      if (originals.has(step.name) && wholeOriginal(target, original) !== step.name) return state
      target.name = step.name
      target.named = true
      return next
    }
    case 'reorder': {
      const rank = new Map(step.names.map((name, i) => [name, i]))
      next.sequences.sort((a, b) => (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity))
      return next
    }
    case 'layout':
      return laidOut(step, original, ids)
  }
}

/**
 * The state a layout describes, checked against the original: a stretch of a
 * sequence it does not have, or past its end, is dropped rather than trusted —
 * and whatever of the original no part covers is set aside, unplaced, so that
 * every base of the file is still somewhere.
 */
function laidOut(step: LayoutStep, original: OriginalAssembly, ids: IdSource): Folded {
  const lengthOf = lengthsOf(original)
  const covered = new Map<string, Array<[number, number]>>()
  const cover = (sequence: string, start: number, end: number): void => {
    const list = covered.get(sequence) ?? []
    list.push([start, end])
    covered.set(sequence, list)
  }
  const valid = (sequence: string, start: number, end: number): [number, number] | null => {
    const length = lengthOf.get(sequence)
    if (length === undefined) return null
    const a = clamp(Math.round(start), 0, length)
    const b = clamp(Math.round(end), 0, length)
    return b > a ? [a, b] : null
  }
  const taken = new Set<string>()
  const sequences: EditedSequence[] = []
  // A layout kept with a file is read back from storage, so nothing about its
  // shape is taken on trust: a malformed entry is dropped, not thrown on.
  for (const laid of Array.isArray(step.sequences) ? step.sequences : []) {
    if (laid === null || typeof laid !== 'object' || !Array.isArray(laid.parts)) continue
    const parts: Part[] = []
    for (const part of laid.parts) {
      if (part === null || typeof part !== 'object') continue
      if ('gap' in part) {
        if (typeof part.gap === 'number' && part.gap > 0) parts.push({ gap: Math.round(part.gap) })
        continue
      }
      if (typeof part.sequence !== 'string' || typeof part.start !== 'number' || typeof part.end !== 'number') continue
      if (part.strand !== 1 && part.strand !== -1) continue
      const range = valid(part.sequence, part.start, part.end)
      if (range === null) continue
      cover(part.sequence, range[0], range[1])
      parts.push({ id: ids.next(part.sequence), sequence: part.sequence, start: range[0], end: range[1], strand: part.strand })
    }
    // Gaps at either end of a sequence are nothing a sequence can begin or end with.
    while (parts.length > 0 && isGap(parts[0])) parts.shift()
    while (parts.length > 0 && isGap(parts[parts.length - 1])) parts.pop()
    if (parts.length === 0) continue
    const wanted = typeof laid.name === 'string' ? laid.name : ''
    const name = wanted !== '' && !taken.has(wanted) ? wanted : freshName(wanted === '' ? 'seq' : wanted, taken)
    taken.add(name)
    sequences.push({ name, parts: merge(parts), ...(laid.circular === true ? { circular: true } : {}) })
  }
  const aside: Aside[] = []
  for (const item of Array.isArray(step.aside) ? step.aside : []) {
    if (item === null || typeof item !== 'object' || typeof item.sequence !== 'string') continue
    if (!ASIDE_REASONS.includes(item.why)) continue
    const range = valid(item.sequence, item.start, item.end)
    if (range === null) continue
    cover(item.sequence, range[0], range[1])
    const genome = typeof item.genome === 'string' && item.genome !== '' ? item.genome : undefined
    aside.push({
      piece: { id: ids.next(item.sequence), sequence: item.sequence, start: range[0], end: range[1], strand: 1 },
      why: item.why,
      ...(genome === undefined ? {} : { genome }),
    })
  }
  // What no part covers: unplaced, stretch by stretch.
  for (let i = 0; i < original.names.length; i++) {
    const name = original.names[i]
    const spans = (covered.get(name) ?? []).sort((a, b) => a[0] - b[0])
    let at = 0
    for (const [start, end] of spans) {
      if (start > at) aside.push({ piece: { id: ids.next(name), sequence: name, start: at, end: start, strand: 1 }, why: 'unplaced' })
      at = Math.max(at, end)
    }
    if (at < original.lengths[i]) {
      aside.push({ piece: { id: ids.next(name), sequence: name, start: at, end: original.lengths[i], strand: 1 }, why: 'unplaced' })
    }
  }
  return { sequences, aside }
}

/** The original name an edited sequence descends from, for naming what splits off it. */
function baseName(name: string): string {
  return name.replace(/_e\d+$/, '')
}

/**
 * Whether a sequence is exactly one whole original sequence, forward.
 *
 * In content, not in parts: a sequence that has only been *cut* is two forward
 * pieces that still meet end to end, and it is the original with an edit end
 * marked on it — which is no reason to take its name away.
 */
function isWhole(sequence: EditedSequence, original: OriginalAssembly): boolean {
  let expected = 0
  let name: string | null = null
  for (const part of sequence.parts) {
    if (isGap(part) || part.strand !== 1 || part.start !== expected) return false
    if (name !== null && part.sequence !== name) return false
    name = part.sequence
    expected = part.end
  }
  if (name === null) return false
  const index = original.names.indexOf(name)
  if (index >= 0) return expected === original.lengths[index]
  const brought = original.elsewhere?.find((contig) => contig.name === name)
  return brought !== undefined && expected === brought.length
}

/**
 * Give every sequence the name its parts entitle it to.
 *
 * A sequence that is exactly one whole original sequence, forward, is called
 * what the original is called — so an edit to one chromosome leaves the others'
 * names in every link, table and track. Any other sequence that still wears an
 * original's name gets a fresh one: a name kept at a new length is the case
 * §5.9's length veto would flag, and here it cannot happen by construction.
 */
function settleNames(state: Folded, original: OriginalAssembly): Folded {
  const originals = new Set(lengthsOf(original).keys())
  const taken = new Set(state.sequences.map((sequence) => sequence.name))
  for (const sequence of state.sequences) {
    if (originals.has(sequence.name) && !isWhole(sequence, original)) {
      taken.delete(sequence.name)
      sequence.name = freshName(baseName(sequence.name), taken)
      taken.add(sequence.name)
    }
  }
  // …and the mirror: a sequence whose edits have been undone by other edits —
  // an inversion inverted back — is the original again, and takes its name back
  // where it is free, so that the history's net effect is what the names say.
  for (const sequence of state.sequences) {
    // Not one the reader named: the name they gave it is the one it keeps.
    if (sequence.named === true) continue
    const whole = wholeOriginal(sequence, original)
    if (whole !== null && sequence.name !== whole && !taken.has(whole)) {
      taken.delete(sequence.name)
      sequence.name = whole
      taken.add(whole)
    }
  }
  return state
}

/** The original a sequence is exactly, forward and whole, or `null`. */
function wholeOriginal(sequence: EditedSequence, original: OriginalAssembly): string | null {
  if (!isWhole(sequence, original)) return null
  const first = sequence.parts[0]
  return isGap(first) ? null : first.sequence
}

// ---------------------------------------------------------------------------
// The edited assembly
// ---------------------------------------------------------------------------

/**
 * The edited assembly an edit folds into, with the lens between it and the
 * original — read-only, and rebuilt from the edit whenever the edit changes.
 */
export class EditedAssembly {
  readonly original: OriginalAssembly
  readonly sequences: readonly EditedSequence[]
  readonly aside: readonly Aside[]
  /** Per edited sequence: the offset each part begins at, and the total. */
  private readonly offsets = new Map<string, number[]>()
  /** Per original sequence: every piece of it, with where it lands. */
  private readonly byOriginal = new Map<string, Landing[]>()

  private constructor(original: OriginalAssembly, folded: Folded) {
    this.original = original
    this.sequences = folded.sequences
    this.aside = folded.aside
    for (const sequence of folded.sequences) {
      const offsets: number[] = []
      let offset = 0
      for (const part of sequence.parts) {
        offsets.push(offset)
        if (!isGap(part)) {
          const list = this.byOriginal.get(part.sequence) ?? []
          list.push({ sequence: sequence.name, offset, piece: part })
          this.byOriginal.set(part.sequence, list)
        }
        offset += partLength(part)
      }
      offsets.push(offset)
      this.offsets.set(sequence.name, offsets)
    }
    for (const list of this.byOriginal.values()) list.sort((a, b) => a.piece.start - b.piece.start)
  }

  /** Fold an edit's applied history into the assembly it describes. */
  static of(edit: ReferenceEdit): EditedAssembly {
    const ids = new IdSource()
    let state = identity(edit.original)
    const cursor = clamp(edit.cursor, 0, edit.history.length)
    for (let i = 0; i < cursor; i++) {
      state = settleNames(apply(state, edit.history[i].step, edit.original, ids), edit.original)
    }
    return new EditedAssembly(edit.original, state)
  }

  /** Whether the edit has changed anything at all. */
  get isIdentity(): boolean {
    return (
      this.aside.length === 0 &&
      this.sequences.length === this.original.names.length &&
      this.sequences.every((sequence, i) => sequence.name === this.original.names[i] && isWhole(sequence, this.original))
    )
  }

  /** An edited sequence by name, or `null`. */
  sequence(name: string): EditedSequence | null {
    return this.sequences.find((sequence) => sequence.name === name) ?? null
  }

  /** An edited sequence's length, in base pairs, or `null` for a name it does not have. */
  lengthOf(name: string): number | null {
    const offsets = this.offsets.get(name)
    return offsets === undefined ? null : offsets[offsets.length - 1]
  }

  /** Names and lengths, in order: the edited assembly as an `Assembly` wants it. */
  contigs(): Array<{ name: string; length: number }> {
    return this.sequences.map((sequence) => ({ name: sequence.name, length: this.lengthOf(sequence.name) ?? 0 }))
  }

  /**
   * Edited → original: the one base an edited position is, or `null` in a gap
   * or outside the sequence.
   */
  toOriginal(sequence: string, bp: number): OriginalPlace | null {
    const found = this.sequence(sequence)
    const offsets = this.offsets.get(sequence)
    if (found === null || offsets === undefined) return null
    const index = partIndexAt(offsets, bp)
    if (index < 0) return null
    const part = found.parts[index]
    if (isGap(part)) return null
    const k = bp - offsets[index]
    return part.strand === 1
      ? { sequence: part.sequence, bp: part.start + k, strand: 1 }
      : { sequence: part.sequence, bp: part.end - 1 - k, strand: -1 }
  }

  /**
   * Original → edited: every place an original base lands — none if it was set
   * aside, two if it was duplicated.
   */
  toEdited(sequence: string, bp: number): EditedPlace[] {
    const out: EditedPlace[] = []
    for (const landing of this.landings(sequence)) {
      const piece = landing.piece
      if (bp < piece.start || bp >= piece.end) continue
      out.push(
        piece.strand === 1
          ? { sequence: landing.sequence, bp: landing.offset + (bp - piece.start), strand: 1 }
          : { sequence: landing.sequence, bp: landing.offset + (piece.end - 1 - bp), strand: -1 },
      )
    }
    return out
  }

  /** Every piece of an original sequence, by where it starts on the original. */
  landings(sequence: string): readonly Landing[] {
    return this.byOriginal.get(sequence) ?? []
  }

  /**
   * The pieces an edited stretch is made of, each clipped to it — what a track
   * query through the lens asks the original for, one window per piece.
   */
  piecesIn(sequence: string, from: number, to: number): Array<{ offset: number; piece: Piece }> {
    const found = this.sequence(sequence)
    const offsets = this.offsets.get(sequence)
    if (found === null || offsets === undefined) return []
    const out: Array<{ offset: number; piece: Piece }> = []
    for (let i = 0; i < found.parts.length; i++) {
      const part = found.parts[i]
      const start = offsets[i]
      const end = offsets[i + 1]
      if (isGap(part) || end <= from || start >= to) continue
      const lo = Math.max(from, start) - start
      const hi = Math.min(to, end) - start
      const clipped: Piece =
        part.strand === 1
          ? { ...part, start: part.start + lo, end: part.start + hi }
          : { ...part, start: part.end - hi, end: part.end - lo }
      out.push({ offset: start + lo, piece: clipped })
    }
    return out
  }

  /** Every junction of the edited assembly: where two parts meet, as edited positions. */
  junctions(): Array<{ sequence: string; at: number }> {
    const out: Array<{ sequence: string; at: number }> = []
    for (const sequence of this.sequences) {
      const offsets = this.offsets.get(sequence.name) ?? []
      for (let i = 1; i < sequence.parts.length; i++) out.push({ sequence: sequence.name, at: offsets[i] })
    }
    return out
  }
}

/** The index of the part an offset falls in, or `-1` outside. */
function partIndexAt(offsets: readonly number[], bp: number): number {
  if (bp < 0 || bp >= offsets[offsets.length - 1]) return -1
  let low = 0
  let high = offsets.length - 2
  while (low <= high) {
    const mid = (low + high) >> 1
    if (bp < offsets[mid]) high = mid - 1
    else if (bp >= offsets[mid + 1]) low = mid + 1
    else return mid
  }
  return -1
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** The edit with one more step, dropping any that had been undone. */
export function withStep(edit: ReferenceEdit, step: EditStep, by: StepAuthor, when: number, suggestion?: string): ReferenceEdit {
  const history = edit.history.slice(0, edit.cursor)
  history.push({ step, by, when, ...(suggestion === undefined ? {} : { suggestion }) })
  return { ...edit, history, cursor: history.length }
}

/** The edit one step back, or unchanged at the start. */
export function undone(edit: ReferenceEdit): ReferenceEdit {
  return edit.cursor === 0 ? edit : { ...edit, cursor: edit.cursor - 1 }
}

/** The edit one step forward again, or unchanged at the end. */
export function redone(edit: ReferenceEdit): ReferenceEdit {
  return edit.cursor >= edit.history.length ? edit : { ...edit, cursor: edit.cursor + 1 }
}

/**
 * The steps an edit applies, as a short string that changes whenever they do
 * and never with what was undone past them: two edits with one fingerprint draw
 * one assembly. What a mount is keyed by and a task's framing carries (§27.7).
 */
export function editFingerprint(edit: ReferenceEdit): string {
  const text = JSON.stringify(edit.history.slice(0, edit.cursor).map((entry) => entry.step))
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${edit.cursor}:${(hash >>> 0).toString(36)}`
}

/**
 * Whether an edit applies to a file's sequences: the same names, at the same
 * lengths, in the same order. `null` when it does; otherwise the first that
 * differs, for the refusal to name (§10).
 */
export function mismatch(edit: ReferenceEdit, names: readonly string[], lengths: readonly number[]): string | null {
  const original = edit.original
  if (original.genome !== undefined) {
    // One genome's edit: every sequence of it is one of the file's, as long.
    const file = new Map(names.map((name, i) => [name, lengths[i]]))
    for (const [name, wanted] of lengthsOf(original)) {
      const length = file.get(name)
      if (length === undefined) return `the edit names ${name}, which this file does not have`
      if (length !== wanted) return `${name} is ${wanted} bp in the edit and ${length} bp here`
    }
    return null
  }
  if (original.names.length !== names.length) {
    return `the edit was made on ${original.names.length} sequences and this file has ${names.length}`
  }
  for (let i = 0; i < names.length; i++) {
    if (original.names[i] !== names[i]) return `sequence ${i + 1} is ${original.names[i]} in the edit and ${names[i]} here`
    if (original.lengths[i] !== lengths[i]) {
      return `${names[i]} is ${original.lengths[i]} bp in the edit and ${lengths[i]} bp here`
    }
  }
  return null
}
