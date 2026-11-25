/**
 * The review's questions (SPECS §33.3): the suggestions on offer, grouped as a
 * curator decides them — "these three MAGs are one organism" is one answer,
 * not three. One key takes a question whole, as one gesture; its members can
 * still be answered one by one.
 *
 * - **Merges** at {@link LIKELY} or more are grouped by the genomes they join:
 *   each connected group one question, merged into its most complete member
 *   (the longest on a tie), at the confidence of its **weakest needed link** —
 *   the least sure pair of the surest tree that joins them, so a group is no
 *   surer than the join it cannot do without.
 * - **Moves** at that confidence, by the genome they leave and the one they
 *   join; **recruits**, by the genome they join; **host links and unlinks**, by
 *   the element: each group one question at its least sure member.
 * - What is less sure stays a question of its own.
 *
 * Answered in the queue's order (`model.ts`'s `queueOrder`): the likely first,
 * merges, then moves, recruits and links, since a merge changes every affinity
 * of the genome it makes.
 *
 * A question is shaped as a {@link Suggestion} — its genomes and contigs the
 * union of its members', its step the first of its steps — so every part that
 * draws a suggestion draws a question.
 */

import type { CurationStep } from '../genome/curation'
import type { CurationStateResult } from '../worker/curateProtocol'
import { LIKELY } from './method'
import type { Suggestion } from './suggest'

/** A question: a group of suggestions answered as one. */
export interface Question extends Suggestion {
  /** The suggestions it answers, surest first; one for a question of its own. */
  members: Suggestion[]
  /** The steps taking it makes, one gesture. */
  steps: CurationStep[]
}

/** Contigs as words: a name for one, a count for more. */
function contigs(n: number, one: string): string {
  return n === 1 ? one : `${n.toLocaleString('en-US')} contigs`
}

/** A suggestion as a question of its own. */
export function single(s: Suggestion): Question {
  return { ...s, members: [s], steps: [s.step] }
}

/** The questions the suggestions on offer make, in no order (the caller sorts). */
export function questions(offered: readonly Suggestion[], answer: CurationStateResult, names: readonly string[]): Question[] {
  const out: Question[] = []
  const likely = offered.filter((s) => s.confidence >= LIKELY)
  const rest = offered.filter((s) => s.confidence < LIKELY)
  out.push(...mergeQuestions(likely.filter((s) => s.kind === 'merge'), answer))
  out.push(...groupedBy(likely.filter((s) => s.kind === 'move'), (s) => `${s.genomes[1] ?? -1}>${s.genomes[0] ?? -1}`, (list) => moveQuestion(list, answer, names)))
  out.push(...groupedBy(likely.filter((s) => s.kind === 'recruit'), (s) => String(s.genomes[0] ?? -1), (list) => recruitQuestion(list, answer, names)))
  out.push(...groupedBy(likely.filter((s) => s.kind === 'link' || s.kind === 'unlink'), (s) => String(s.genomes[0] ?? -1), (list) => hostQuestion(list, answer)))
  out.push(...rest.map(single))
  return out
}

/** Group, then make one question of every group of two or more, a single of the others. */
function groupedBy(list: readonly Suggestion[], keyOf: (s: Suggestion) => string, make: (group: Suggestion[]) => Question): Question[] {
  const groups = new Map<string, Suggestion[]>()
  for (const s of list) {
    const key = keyOf(s)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [s])
    else group.push(s)
  }
  const out: Question[] = []
  for (const group of groups.values()) {
    group.sort(surest)
    out.push(group.length === 1 ? single(group[0]) : make(group))
  }
  return out
}

function surest(a: Suggestion, b: Suggestion): number {
  return b.confidence - a.confidence || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

/** The merges' connected groups, each merged into its most complete member. */
function mergeQuestions(merges: readonly Suggestion[], answer: CurationStateResult): Question[] {
  const parent = new Map<number, number>()
  const root = (g: number): number => {
    let r = g
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) as number
    parent.set(g, r)
    return r
  }
  // The surest tree first (Kruskal on confidence): the last pair it needs to
  // join a group is the group's weakest needed link.
  const sorted = [...merges].sort(surest)
  const weakest = new Map<number, number>()
  for (const s of sorted) {
    const [a, b] = s.genomes
    if (a === undefined || b === undefined) continue
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = root(a)
    const rb = root(b)
    if (ra === rb) continue
    const w = Math.min(weakest.get(ra) ?? 1, weakest.get(rb) ?? 1, s.confidence)
    parent.set(ra, rb)
    weakest.set(rb, w)
  }
  const members = new Map<number, Suggestion[]>()
  const genomesOf = new Map<number, Set<number>>()
  for (const s of sorted) {
    const [a] = s.genomes
    if (a === undefined) continue
    const r = root(a)
    const list = members.get(r)
    if (list === undefined) members.set(r, [s])
    else list.push(s)
    const set = genomesOf.get(r) ?? new Set<number>()
    for (const g of s.genomes) set.add(g)
    genomesOf.set(r, set)
  }
  const out: Question[] = []
  for (const [r, list] of members) {
    if (list.length === 1) {
      out.push(single(list[0]))
      continue
    }
    const genomes = [...(genomesOf.get(r) ?? [])]
    // The survivor: the most complete, the longest on a tie, which keeps its name.
    const into = [...genomes].sort((x, y) => {
      const qx = answer.genomes[x]?.quality?.weightedCompleteness ?? -1
      const qy = answer.genomes[y]?.quality?.weightedCompleteness ?? -1
      return qy - qx || (answer.genomes[y]?.length ?? 0) - (answer.genomes[x]?.length ?? 0) || x - y
    })[0]
    const others = genomes.filter((g) => g !== into)
    const step: CurationStep = { op: 'merge', into: answer.genomes[into].id, genomes: others.map((g) => answer.genomes[g].id) }
    const contacts = list.reduce((sum, s) => sum + s.contacts, 0)
    out.push({
      key: `merge:${genomes.map((g) => answer.genomes[g].id).sort().join('+')}`,
      kind: 'merge',
      step,
      words: `merge ${others.length === 1 ? answer.genomes[others[0]].name : `${others.length.toLocaleString('en-US')} MAGs`} into ${answer.genomes[into].name}`,
      confidence: weakest.get(r) ?? Math.min(...list.map((s) => s.confidence)),
      features: list[list.length - 1].features,
      evidence: [`${genomes.length} MAGs, one organism`, `${contacts.toLocaleString('en-US')} contacts`, `least sure join ${Math.round((weakest.get(r) ?? 0) * 100)}%`],
      genomes: [into, ...others],
      contigs: [],
      affinity: Math.min(...list.map((s) => s.affinity)),
      contacts,
      members: list,
      steps: [step],
    })
  }
  return out
}

/** Moves from one genome to another, as one step. */
function moveQuestion(list: Suggestion[], answer: CurationStateResult, names: readonly string[]): Question {
  const contigsMoved = list.flatMap((s) => s.contigs)
  const to = list[0].genomes[0]
  const from = list[0].genomes[1]
  const step: CurationStep = { op: 'move', contigs: contigsMoved.map((c) => names[c]), to: answer.genomes[to].id }
  return {
    key: `move:${answer.genomes[from]?.id ?? ''}>${answer.genomes[to].id}`,
    kind: 'move',
    step,
    words: `move ${contigs(contigsMoved.length, names[contigsMoved[0]] ?? '')} from ${answer.genomes[from]?.name ?? 'its genome'} to ${answer.genomes[to].name}`,
    confidence: Math.min(...list.map((s) => s.confidence)),
    features: list[list.length - 1].features,
    evidence: [`${list.length} contigs`, `${list.reduce((sum, s) => sum + s.contacts, 0).toLocaleString('en-US')} contacts`],
    genomes: [to, ...(from === undefined ? [] : [from])],
    contigs: contigsMoved,
    affinity: Math.min(...list.map((s) => s.affinity)),
    contacts: list.reduce((sum, s) => sum + s.contacts, 0),
    members: list,
    steps: [step],
  }
}

/** Recruits into one genome, as one step. */
function recruitQuestion(list: Suggestion[], answer: CurationStateResult, names: readonly string[]): Question {
  const contigsTaken = [...new Set(list.flatMap((s) => s.contigs))]
  const to = list[0].genomes[0]
  const step: CurationStep = { op: 'move', contigs: contigsTaken.map((c) => names[c]), to: answer.genomes[to].id }
  return {
    key: `recruit:${answer.genomes[to].id}`,
    kind: 'recruit',
    step,
    words: `recruit ${contigs(contigsTaken.length, names[contigsTaken[0]] ?? '')} into ${answer.genomes[to].name}`,
    confidence: Math.min(...list.map((s) => s.confidence)),
    features: list[list.length - 1].features,
    evidence: [`${list.length} suggestions`, `${list.reduce((sum, s) => sum + s.contacts, 0).toLocaleString('en-US')} contacts`],
    genomes: [to],
    contigs: contigsTaken,
    affinity: Math.min(...list.map((s) => s.affinity)),
    contacts: list.reduce((sum, s) => sum + s.contacts, 0),
    members: list,
    steps: [step],
  }
}

/** An element's links and unlinks, as one gesture. */
function hostQuestion(list: Suggestion[], answer: CurationStateResult): Question {
  const e = list[0].genomes[0]
  const element = answer.genomes[e]
  const links = list.filter((s) => s.kind === 'link').map((s) => answer.genomes[s.genomes[1]]?.name ?? '')
  const unlinks = list.filter((s) => s.kind === 'unlink').map((s) => answer.genomes[s.genomes[1]]?.name ?? '')
  const parts: string[] = []
  if (links.length > 0) parts.push(`link ${element.name} to ${links.join(', ')}`)
  if (unlinks.length > 0) parts.push(`${links.length > 0 ? 'unlink it' : `unlink ${element.name}`} from ${unlinks.join(', ')}`)
  const steps = list.map((s) => s.step)
  return {
    key: `host:${element.id}`,
    kind: links.length > 0 ? 'link' : 'unlink',
    step: steps[0],
    words: parts.join(' · '),
    confidence: Math.min(...list.map((s) => s.confidence)),
    features: list[list.length - 1].features,
    evidence: [`${list.length} links`],
    genomes: [e, ...list.map((s) => s.genomes[1]).filter((g): g is number => g !== undefined)],
    contigs: [],
    affinity: Math.min(...list.map((s) => s.affinity)),
    contacts: list.reduce((sum, s) => sum + s.contacts, 0),
    members: list,
    steps,
  }
}

/**
 * A question's number as the review's band, the suggestions card and the
 * pictures print it — the likely ones (at `likely` or more) from 1, the less
 * sure from 1 again — found by its key or a member's (a member stepped into
 * wears its question's); `null` for one the queue does not hold.
 */
export function questionNumber(
  queue: ReadonlyArray<{ key: string; confidence: number; members: ReadonlyArray<{ key: string }> }>,
  key: string,
  likely: number,
): number | null {
  let at = queue.findIndex((q) => q.key === key)
  if (at < 0) at = queue.findIndex((q) => q.members.some((m) => m.key === key))
  if (at < 0) return null
  const first = queue.filter((q) => q.confidence >= likely).length
  return at < first ? at + 1 : at - first + 1
}
