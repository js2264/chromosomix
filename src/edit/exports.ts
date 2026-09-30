/**
 * What an edit of the reference is written as, and read back from (SPECS §27.8).
 *
 * The files the tools downstream of a curation take: an **AGP 2.1** and a
 * **chrom.sizes** of the edited assembly, a Juicebox **`.assembly`** for round
 * trips with JBAT, 3D-DNA and YaHS, and a **liftOver chain** from the original
 * to the edited coordinates for everything else. The AGP and the `.assembly` are
 * also read back as an edit — one step, *lay out as in the file* (`LayoutStep`).
 *
 * ## What of the set-aside stretches is written
 *
 * A stretch set aside as **unplaced** is still sequence of the assembly, only
 * not placed: every file writes it as a sequence of its own, named for where it
 * came from (`IV_unplaced1`). A stretch set aside as **debris**, a
 * **contaminant** or a **haplotig** is not part of the assembly: the AGP names it
 * in a comment, so that the file reads back as the edit it was, and the
 * `.assembly` keeps it as a fragment marked `:::debris`, Juicebox's own
 * convention, which has no word for the other two.
 *
 * Pure: text in, text out, against an {@link EditedAssembly}.
 */

import {
  ASIDE_REASONS,
  isGap,
  type AsideReason,
  type EditedAssembly,
  type LayoutPart,
  type LayoutStep,
  type OriginalAssembly,
  type Part,
  type Piece,
} from '../genome/edit'
import { JOIN_GAP } from './gestures'

/** Where a file came from, for the comment lines that carry it. */
export interface ExportContext {
  /** The file the edit was made on. */
  file: string
  /** The app that wrote it, with its version. */
  by: string
  /** When, as an ISO date. */
  created: string
  /** The applied history, one line per step, in words. */
  steps: readonly string[]
}

/** One sequence as the files write it: an edited sequence, or a stretch set aside as unplaced. */
export interface AssemblyObject {
  name: string
  parts: readonly Part[]
  length: number
  /** The stretch it is, where it is one set aside as unplaced. */
  unplaced: boolean
}

/**
 * The sequences every file writes, in order: the edited assembly's, then each
 * stretch set aside as unplaced, named for the sequence it came from.
 */
export function assemblyObjects(assembly: EditedAssembly): AssemblyObject[] {
  const out: AssemblyObject[] = assembly.sequences.map((sequence) => ({
    name: sequence.name,
    parts: sequence.parts,
    length: assembly.lengthOf(sequence.name) ?? 0,
    unplaced: false,
  }))
  const taken = new Set(out.map((object) => object.name))
  const count = new Map<string, number>()
  for (const item of assembly.aside) {
    if (item.why !== 'unplaced') continue
    const base = `${item.piece.sequence}_unplaced`
    let k = count.get(base) ?? 0
    let name: string
    do {
      k += 1
      name = `${base}${k}`
    } while (taken.has(name))
    count.set(base, k)
    taken.add(name)
    out.push({ name, parts: [item.piece], length: item.piece.end - item.piece.start, unplaced: true })
  }
  return out
}

/** The comment lines a text file begins with: what it is of, by what, and the history. */
function provenance(context: ExportContext, what: string): string[] {
  return [
    `# ${what} of the edit of ${context.file}`,
    `# written by ${context.by} on ${context.created}`,
    ...(context.steps.length === 0 ? ['# the file as it is: no steps'] : context.steps.map((step, i) => `# ${i + 1}. ${step}`)),
  ]
}

// ---------------------------------------------------------------------------
// AGP 2.1
// ---------------------------------------------------------------------------

/** The gap type, linkage and evidence of every gap the stage makes: a join the map supports. */
const GAP_COLUMNS = ['scaffold', 'yes', 'proximity_ligation']

/**
 * The edited assembly as an AGP 2.1: every sequence as the components it is
 * built from, 1-based and inclusive as the format counts, reversed pieces `-`,
 * each run of `N` a gap line typed `scaffold` with `proximity_ligation` as its
 * evidence — which is what a join on the stage is.
 */
export function agpOf(assembly: EditedAssembly, context: ExportContext): string {
  const lines = ['##agp-version\t2.1', ...provenance(context, 'AGP')]
  const objects = assemblyObjects(assembly)
  for (const object of objects) if (object.unplaced) lines.push(`# aside\tunplaced\t${object.name}`)
  for (const item of assembly.aside) {
    if (item.why === 'unplaced') continue
    const { sequence, start, end } = item.piece
    lines.push(`# aside\t${item.why}\t${sequence}:${start + 1}-${end}`)
  }
  for (const object of objects) {
    let at = 1
    let number = 1
    for (const part of object.parts) {
      if (isGap(part)) {
        lines.push([object.name, at, at + part.gap - 1, number, 'N', part.gap, ...GAP_COLUMNS].join('\t'))
        at += part.gap
      } else {
        const length = part.end - part.start
        lines.push([object.name, at, at + length - 1, number, 'W', part.sequence, part.start + 1, part.end, part.strand === 1 ? '+' : '-'].join('\t'))
        at += length
      }
      number += 1
    }
  }
  return `${lines.join('\n')}\n`
}

/** A file read back, or why it could not be. */
export type ReadBack = { ok: true; step: LayoutStep; notes: string[] } | { ok: false; why: string }

/**
 * An AGP read back as a layout of the original.
 *
 * Every component must be a sequence of the file the edit is made on — an AGP
 * of another assembly is refused, naming the first that is not — and inside
 * its length. Gaps keep their lengths. Whatever of the original no component
 * covers is set aside, unplaced; the comment lines this app writes restore what
 * was set aside and why.
 */
export function readAgp(text: string, original: OriginalAssembly, from: string): ReadBack {
  const lengthOf = new Map(original.names.map((name, i) => [name, original.lengths[i]]))
  const order: string[] = []
  const objects = new Map<string, LayoutPart[]>()
  const asideObjects = new Set<string>()
  const aside: LayoutStep['aside'] = []
  const notes: string[] = []
  let lineNumber = 0
  for (const raw of text.split(/\r?\n/)) {
    lineNumber += 1
    const line = raw.trimEnd()
    if (line === '') continue
    if (line.startsWith('#')) {
      const comment = line.replace(/^#+\s*/, '').split(/\t|\s+/)
      if (comment[0] !== 'aside' || comment.length < 3) continue
      const why = comment[1] as AsideReason
      if (!ASIDE_REASONS.includes(why)) continue
      if (why === 'unplaced' && !comment[2].includes(':')) {
        asideObjects.add(comment[2])
        continue
      }
      const match = /^(.+):(\d+)-(\d+)$/.exec(comment[2])
      if (match !== null) aside.push({ sequence: match[1], start: Number(match[2]) - 1, end: Number(match[3]), why })
      continue
    }
    const columns = line.includes('\t') ? line.split('\t') : line.split(/\s+/)
    if (columns.length < 8) return { ok: false, why: `line ${lineNumber} has ${columns.length} columns, and an AGP line has at least 8` }
    const [object, , , , type] = columns
    let parts = objects.get(object)
    if (parts === undefined) {
      parts = []
      objects.set(object, parts)
      order.push(object)
    }
    if (type === 'N' || type === 'U') {
      const gap = Number(columns[5])
      if (!Number.isFinite(gap) || gap < 0) return { ok: false, why: `line ${lineNumber}: a gap of ${columns[5]}` }
      parts.push({ gap })
      continue
    }
    const sequence = columns[5]
    const length = lengthOf.get(sequence)
    if (length === undefined) {
      return { ok: false, why: `it names ${sequence} (line ${lineNumber}), which the map does not have: it is an AGP of another assembly` }
    }
    const start = Number(columns[6]) - 1
    const end = Number(columns[7])
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > length || end <= start) {
      return { ok: false, why: `line ${lineNumber}: ${sequence}:${columns[6]}-${columns[7]} is not inside ${sequence}, which is ${length.toLocaleString('en-US')} bp` }
    }
    parts.push({ sequence, start, end, strand: columns[8] === '-' ? -1 : 1 })
  }
  if (order.length === 0) return { ok: false, why: 'it has no components' }
  const sequences: LayoutStep['sequences'] = []
  for (const name of order) {
    const parts = objects.get(name) ?? []
    const pieces = parts.filter((part): part is Exclude<LayoutPart, { gap: number }> => !('gap' in part))
    if (asideObjects.has(name) && pieces.length === 1) {
      aside.push({ sequence: pieces[0].sequence, start: pieces[0].start, end: pieces[0].end, why: 'unplaced' })
      continue
    }
    sequences.push({ name, parts })
  }
  const duplicated = duplicatedBases(sequences, aside)
  if (duplicated > 0) notes.push(`${duplicated.toLocaleString('en-US')} bp are placed more than once`)
  return { ok: true, step: { op: 'layout', from, sequences, aside }, notes }
}

/** How many bases of the original a layout places more than once. */
function duplicatedBases(sequences: LayoutStep['sequences'], aside: LayoutStep['aside']): number {
  const spans = new Map<string, Array<[number, number]>>()
  const add = (sequence: string, start: number, end: number): void => {
    const list = spans.get(sequence) ?? []
    list.push([start, end])
    spans.set(sequence, list)
  }
  for (const sequence of sequences) for (const part of sequence.parts) if (!('gap' in part)) add(part.sequence, part.start, part.end)
  for (const item of aside) add(item.sequence, item.start, item.end)
  let twice = 0
  for (const list of spans.values()) {
    list.sort((a, b) => a[0] - b[0])
    let reach = -1
    for (const [start, end] of list) {
      if (start < reach) twice += Math.min(end, reach) - start
      reach = Math.max(reach, end)
    }
  }
  return twice
}

// ---------------------------------------------------------------------------
// chrom.sizes
// ---------------------------------------------------------------------------

/** One line per sequence: its name and its length. */
export function chromSizesOf(assembly: EditedAssembly): string {
  return `${assemblyObjects(assembly)
    .map((object) => `${object.name}\t${object.length}`)
    .join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Juicebox .assembly
// ---------------------------------------------------------------------------

/** A stretch of an original sequence, as the `.assembly` lists it. */
interface Fragment {
  sequence: string
  start: number
  end: number
  debris: boolean
}

/**
 * The edited assembly as a Juicebox `.assembly`: the original cut into the
 * fragments every piece is made of, listed in the original's order, then one
 * line per sequence of signed fragment numbers — negative for a piece read
 * backwards. Gaps are not written: the format has none, and JBAT puts its own
 * between fragments when it builds a FASTA.
 *
 * Refused where a stretch is placed twice, which the format cannot say: each
 * fragment belongs to one line.
 */
export function juiceboxAssemblyOf(assembly: EditedAssembly): { ok: true; text: string } | { ok: false; why: string } {
  const objects = assemblyObjects(assembly)
  const others = assembly.aside.filter((item) => item.why !== 'unplaced')
  // Every boundary of every piece on each original sequence.
  const cuts = new Map<string, Set<number>>()
  const pieces: Array<{ piece: Piece; debris: boolean }> = []
  for (const object of objects) for (const part of object.parts) if (!isGap(part)) pieces.push({ piece: part, debris: false })
  for (const item of others) pieces.push({ piece: item.piece, debris: true })
  assembly.original.names.forEach((name, i) => cuts.set(name, new Set([0, assembly.original.lengths[i]])))
  for (const { piece } of pieces) {
    cuts.get(piece.sequence)?.add(piece.start)
    cuts.get(piece.sequence)?.add(piece.end)
  }
  // Placed twice: two pieces over the same bases.
  const byOriginal = new Map<string, Array<[number, number]>>()
  for (const { piece } of pieces) {
    const list = byOriginal.get(piece.sequence) ?? []
    list.push([piece.start, piece.end])
    byOriginal.set(piece.sequence, list)
  }
  for (const [sequence, list] of byOriginal) {
    list.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < list.length; i++) {
      if (list[i][0] < list[i - 1][1]) {
        return { ok: false, why: `${sequence} is placed twice from ${(list[i][0] + 1).toLocaleString('en-US')}, and an .assembly lists every fragment once` }
      }
    }
  }
  // The fragments, numbered from 1 in the original's order.
  const fragments: Fragment[] = []
  const index = new Map<string, number>()
  for (const name of assembly.original.names) {
    const bounds = [...(cuts.get(name) ?? [])].sort((a, b) => a - b)
    for (let k = 0; k + 1 < bounds.length; k++) {
      index.set(`${name}:${bounds[k]}`, fragments.length + 1)
      fragments.push({ sequence: name, start: bounds[k], end: bounds[k + 1], debris: false })
    }
  }
  // A debris fragment is every fragment inside a debris piece.
  for (const { piece, debris } of pieces) {
    if (!debris) continue
    for (let n = index.get(`${piece.sequence}:${piece.start}`) ?? 0; n > 0 && n <= fragments.length; n++) {
      const fragment = fragments[n - 1]
      if (fragment.sequence !== piece.sequence || fragment.start >= piece.end) break
      fragment.debris = true
    }
  }
  const count = new Map<string, number>()
  for (const fragment of fragments) count.set(fragment.sequence, (count.get(fragment.sequence) ?? 0) + 1)
  const seen = new Map<string, number>()
  const header = fragments.map((fragment, i) => {
    const k = (seen.get(fragment.sequence) ?? 0) + 1
    seen.set(fragment.sequence, k)
    const name = (count.get(fragment.sequence) ?? 1) === 1 ? fragment.sequence : `${fragment.sequence}:::fragment_${k}`
    return `>${name}${fragment.debris ? ':::debris' : ''} ${i + 1} ${fragment.end - fragment.start}`
  })
  // A piece's fragments, in the order it reads them.
  const signed = (piece: Piece): number[] => {
    const out: number[] = []
    for (let n = index.get(`${piece.sequence}:${piece.start}`) ?? 0; n > 0 && n <= fragments.length; n++) {
      const fragment = fragments[n - 1]
      if (fragment.sequence !== piece.sequence || fragment.start >= piece.end) break
      out.push(n)
    }
    return piece.strand === 1 ? out : out.reverse().map((n) => -n)
  }
  const lines: string[] = []
  for (const object of objects) {
    const row: number[] = []
    for (const part of object.parts) if (!isGap(part)) row.push(...signed(part))
    lines.push(row.join(' '))
  }
  for (const item of others) lines.push(signed(item.piece).join(' '))
  return { ok: true, text: `${[...header, ...lines].join('\n')}\n` }
}

/**
 * A Juicebox `.assembly` read back as a layout of the original.
 *
 * The fragments must add up to the file's sequences, name for name and base for
 * base; a line of fragments is a sequence, `scaffold_1` and on in the order the
 * file lists them. The format has no gaps, so one is put where the stage would
 * have put one: {@link JOIN_GAP} `N` where fragments of two different sequences
 * meet, which is a join, and none where two of one sequence do, which is a turn
 * or a move inside it. A line whose fragments are all `:::debris` is set aside
 * as debris.
 */
export function readJuiceboxAssembly(text: string, original: OriginalAssembly, from: string): ReadBack {
  const lengthOf = new Map(original.names.map((name, i) => [name, original.lengths[i]]))
  const fragments = new Map<number, Fragment>()
  const reach = new Map<string, number>()
  const rows: number[][] = []
  let lineNumber = 0
  for (const raw of text.split(/\r?\n/)) {
    lineNumber += 1
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('>')) {
      const [label, indexText, lengthText] = line.slice(1).split(/\s+/)
      const n = Number(indexText)
      const length = Number(lengthText)
      if (!Number.isInteger(n) || !Number.isInteger(length) || length <= 0) return { ok: false, why: `line ${lineNumber} is not a fragment: ${line}` }
      const sequence = label.split(':::')[0]
      if (!lengthOf.has(sequence)) {
        return { ok: false, why: `it names ${sequence} (line ${lineNumber}), which the map does not have: it is an .assembly of another assembly` }
      }
      const start = reach.get(sequence) ?? 0
      reach.set(sequence, start + length)
      fragments.set(n, { sequence, start, end: start + length, debris: /:::debris/.test(label) })
      continue
    }
    const row = line.split(/\s+/).map(Number)
    if (row.some((n) => !Number.isInteger(n) || n === 0 || !fragments.has(Math.abs(n)))) {
      return { ok: false, why: `line ${lineNumber} names a fragment the file does not list` }
    }
    rows.push(row)
  }
  for (const [sequence, length] of lengthOf) {
    const got = reach.get(sequence) ?? 0
    if (got !== length) {
      return { ok: false, why: `its fragments of ${sequence} add up to ${got.toLocaleString('en-US')} bp, and ${sequence} is ${length.toLocaleString('en-US')} bp` }
    }
  }
  if (rows.length === 0) return { ok: false, why: 'it lists no scaffolds' }
  const sequences: LayoutStep['sequences'] = []
  const aside: LayoutStep['aside'] = []
  let k = 0
  for (const row of rows) {
    const parts: LayoutPart[] = []
    let previous: { sequence: string; start: number; end: number; strand: 1 | -1 } | null = null
    const debris = row.every((n) => fragments.get(Math.abs(n))?.debris === true)
    for (const n of row) {
      const fragment = fragments.get(Math.abs(n)) as Fragment
      const piece = { sequence: fragment.sequence, start: fragment.start, end: fragment.end, strand: (n < 0 ? -1 : 1) as 1 | -1 }
      if (debris) {
        aside.push({ sequence: piece.sequence, start: piece.start, end: piece.end, why: 'debris' })
        continue
      }
      // Two sequences meeting is a join, and a join has a gap; two stretches of
      // one sequence meeting is a turn or a move inside it, which has none.
      if (previous !== null && previous.sequence !== piece.sequence) parts.push({ gap: JOIN_GAP })
      parts.push(piece)
      previous = piece
    }
    if (!debris) {
      k += 1
      sequences.push({ name: `scaffold_${k}`, parts })
    }
  }
  return { ok: true, step: { op: 'layout', from, sequences, aside }, notes: [] }
}

// ---------------------------------------------------------------------------
// liftOver chain
// ---------------------------------------------------------------------------

/**
 * A UCSC chain from the original to the edited assembly: one chain per piece,
 * one ungapped block, the original as the target and the edited sequence as the
 * query — reversed pieces on the query's `-` strand, whose coordinates count
 * from the query's end, as the format has it. A duplicated stretch has two
 * chains, and `liftOver -multiple` follows both; a stretch set aside that is
 * not unplaced has none, and lifts to nowhere.
 */
export function chainOf(assembly: EditedAssembly, context: ExportContext): string {
  const lines = provenance(context, 'liftOver chain')
  const lengthOf = new Map(assembly.original.names.map((name, i) => [name, assembly.original.lengths[i]]))
  let id = 0
  for (const object of assemblyObjects(assembly)) {
    let offset = 0
    for (const part of object.parts) {
      if (isGap(part)) {
        offset += part.gap
        continue
      }
      const size = part.end - part.start
      const qStart = part.strand === 1 ? offset : object.length - offset - size
      id += 1
      lines.push(
        ['chain', size, part.sequence, lengthOf.get(part.sequence) ?? 0, '+', part.start, part.end, object.name, object.length, part.strand === 1 ? '+' : '-', qStart, qStart + size, id].join(' '),
        String(size),
        '',
      )
      offset += size
    }
  }
  return `${lines.join('\n')}\n`
}
