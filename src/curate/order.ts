/**
 * The order the curation stage lays its genomes out in (SPECS §33.3): the MAGs,
 * chained so that genomes which meet densely sit side by side — an organism's
 * fragments become one bright block beside the diagonal of the contact map, a
 * merge seen at a glance — then the elements, each in the place of the MAG it
 * meets most.
 *
 * **A chain of the densest pairs** (the greedy "multiple fragment" chain): every
 * two MAGs in contact, densest first, are made neighbours when both are still
 * the end of a chain and not of the same one. A pair of fragments is never
 * split by a weaker pair, and every pair costs one look, so a few thousand MAGs
 * order in a few milliseconds from the sparse list of pairs the method already
 * keeps. The chains then follow one another, the longest first, each read from
 * its longer end. Deterministic: ties go to the lower indices.
 *
 * **Kept across steps**: the stage orders once and then keeps each genome where
 * it was, a new one beside the genome its contigs came from (see
 * {@link keepOrder}), so the picture does not reshuffle under the reader's hand.
 */

/** Every two genomes in contact, with their affinity (the method's `GenomePairs`). */
export interface PairList {
  a: ArrayLike<number>
  b: ArrayLike<number>
  affinity: ArrayLike<number>
}

/**
 * The order of a set of MAGs: chains of the densest pairs, the longest chain
 * first.
 *
 * @param mags The MAGs to order, as genome indices.
 * @param pairs Every two genomes in contact; pairs naming a genome outside `mags` are left out.
 * @param size A genome's size, its length: what chains and their ends are ordered by.
 */
export function chainOrder(mags: readonly number[], pairs: PairList, size: (g: number) => number): number[] {
  const member = new Set(mags)
  const order: number[] = []
  for (let k = 0; k < pairs.a.length; k++) {
    const a = pairs.a[k]
    const b = pairs.b[k]
    if (a !== b && pairs.affinity[k] > 0 && member.has(a) && member.has(b)) order.push(k)
  }
  const low = (k: number): number => Math.min(pairs.a[k], pairs.b[k])
  const high = (k: number): number => Math.max(pairs.a[k], pairs.b[k])
  order.sort((x, y) => pairs.affinity[y] - pairs.affinity[x] || low(x) - low(y) || high(x) - high(y))

  // Each MAG's neighbours in its chain (at most two), and its chain by union-find.
  const neighbours = new Map<number, number[]>(mags.map((g) => [g, []]))
  const parent = new Map<number, number>(mags.map((g) => [g, g]))
  const root = (g: number): number => {
    let r = g
    while (parent.get(r) !== r) r = parent.get(r) as number
    // Path halving would do; full compression keeps it short.
    let x = g
    while (x !== r) {
      const next = parent.get(x) as number
      parent.set(x, r)
      x = next
    }
    return r
  }
  for (const k of order) {
    const a = pairs.a[k]
    const b = pairs.b[k]
    const na = neighbours.get(a) as number[]
    const nb = neighbours.get(b) as number[]
    if (na.length >= 2 || nb.length >= 2) continue
    const ra = root(a)
    const rb = root(b)
    if (ra === rb) continue
    na.push(b)
    nb.push(a)
    parent.set(ra, rb)
  }

  // Read each chain from an end: the end that is the larger genome.
  const seen = new Set<number>()
  const chains: Array<{ genomes: number[]; size: number; first: number }> = []
  const ends = mags.filter((g) => (neighbours.get(g) as number[]).length <= 1)
  for (const end of ends) {
    if (seen.has(end)) continue
    const walk: number[] = []
    let previous = -1
    let at = end
    for (;;) {
      walk.push(at)
      seen.add(at)
      const next = (neighbours.get(at) as number[]).find((g) => g !== previous)
      if (next === undefined) break
      previous = at
      at = next
    }
    const head = walk[0]
    const tail = walk[walk.length - 1]
    if (size(tail) > size(head) || (size(tail) === size(head) && tail < head)) walk.reverse()
    let total = 0
    for (const g of walk) total += size(g)
    chains.push({ genomes: walk, size: total, first: Math.min(...walk) })
  }
  chains.sort((x, y) => y.size - x.size || x.first - y.first)
  return chains.flatMap((chain) => chain.genomes)
}

/**
 * The elements' order: each in the place of the MAG it meets most densely, in
 * that MAG's place in the MAGs' order, densest first among the elements of one
 * MAG; elements meeting no MAG last, largest first.
 */
export function elementOrder(elements: readonly number[], magOrder: readonly number[], pairs: PairList, size: (g: number) => number): number[] {
  const rank = new Map(magOrder.map((g, k) => [g, k]))
  const isElement = new Set(elements)
  const host = new Map<number, { rank: number; affinity: number }>()
  for (let k = 0; k < pairs.a.length; k++) {
    let e = pairs.a[k]
    let m = pairs.b[k]
    if (!isElement.has(e)) [e, m] = [m, e]
    const r = rank.get(m)
    if (!isElement.has(e) || r === undefined) continue
    const affinity = pairs.affinity[k]
    if (!(affinity > 0)) continue
    const held = host.get(e)
    if (held === undefined || affinity > held.affinity || (affinity === held.affinity && r < held.rank)) host.set(e, { rank: r, affinity })
  }
  const keyOf = (e: number): { rank: number; affinity: number } => host.get(e) ?? { rank: Number.POSITIVE_INFINITY, affinity: 0 }
  return [...elements].sort((x, y) => {
    const kx = keyOf(x)
    const ky = keyOf(y)
    return kx.rank - ky.rank || ky.affinity - kx.affinity || size(y) - size(x) || x - y
  })
}

/**
 * An order carried across a step (SPECS §33.3): the genomes still there keep
 * their places, by id; one that is new goes just after the first genome it took
 * contigs from, else last of its kind; one that is gone leaves no hole.
 *
 * @param before The ids in their previous order.
 * @param after Every id now, with its kind and the ids it took contigs from.
 */
export function keepOrder(before: readonly string[], after: ReadonlyArray<{ id: string; kind: 'mag' | 'element'; from: readonly string[] }>): string[] {
  const now = new Map(after.map((genome) => [genome.id, genome]))
  const order = before.filter((id) => now.has(id))
  const kept = new Set(order)
  for (const genome of after) {
    if (kept.has(genome.id)) continue
    const anchor = genome.from.map((id) => order.indexOf(id)).filter((k) => k >= 0)
    let at: number
    if (anchor.length > 0) at = Math.min(...anchor) + 1
    else {
      // Last of its kind: after the last genome of the same kind.
      let last = -1
      order.forEach((id, k) => {
        if (now.get(id)?.kind === genome.kind) last = k
      })
      at = last + 1
    }
    order.splice(at, 0, genome.id)
    kept.add(genome.id)
  }
  return order
}
