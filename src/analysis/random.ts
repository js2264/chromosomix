/**
 * The only source of randomness an analysis is allowed to use.
 *
 * §18.4 states the requirement in one sentence — *a figure must come out the
 * same twice* — and it is the sentence that rules out `Math.random()`. The
 * platform generator is unseeded by specification: there is no way to ask an
 * engine for the stream it produced last time, and there is no way to write down
 * in a provenance line what it did. A bootstrap band drawn from it is a band
 * whose width changes when you press **Run** again, and a distance-matched
 * pileup drawn from it is a picture nobody can reproduce, including the person
 * who made it.
 *
 * So every task that samples takes a {@link SeedParam}, and the seed is part of
 * the provenance: it travels in the exported session, it is printed at the top
 * of the TSV, and identical seeds with identical parameters give bit-identical
 * output. That last property is tested directly (§18.10), which is only possible
 * because the generator lives here rather than being whatever the engine felt
 * like.
 *
 * The algorithm is **mulberry32**, written out in full below rather than
 * imported, since a seeded PRNG is thirty lines and a dependency is forever. It
 * has a 32-bit state and a period of 2³², which is a poor choice for a
 * simulation and an entirely adequate one for resampling a few thousand rows a
 * few thousand times: what is being asked of it is that draws be uncorrelated
 * and repeatable, not that the sequence be unguessable or astronomically long.
 * Nothing here is a cryptographic generator and nothing here should be used as
 * one.
 */

/**
 * A generator seeded by `seed`, yielding uniform values in `[0, 1)`.
 *
 * Each call advances the state, so two generators made from the same seed
 * produce the same sequence and a generator handed to two consumers produces one
 * sequence shared between them — which is why a task that samples twice for two
 * different purposes should make two generators from two derived seeds rather
 * than interleaving draws from one, or reordering its own steps changes the
 * numbers.
 *
 * The seed is folded to a 32-bit unsigned integer, so a non-integer or negative
 * value is accepted rather than refused; a form that offers a spinner and a
 * session written by an older build both eventually hand this something it did
 * not expect, and a generator that throws at that point takes a whole job with
 * it.
 */
export function makeRandom(seed: number): () => number {
  // `>>> 0` after `Math.trunc` because a seed arriving as `1e10` or `-7` must
  // still land somewhere in the state space rather than becoming `NaN` and
  // poisoning every draw. `Number.isFinite` guards the one input that cannot be
  // folded at all.
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A whole number in `[lo, hi)`.
 *
 * The empty range answers `lo`, because the alternative is a caller that has to
 * check before every draw and one that forgets. The `Math.min` is not
 * defensive noise either: `rng()` is specified to stay below one, but the
 * division above is a rounding operation, and an index equal to `hi` reaches a
 * caller as an `undefined` element several frames later.
 */
export function randomInt(rng: () => number, lo: number, hi: number): number {
  const from = Math.ceil(lo)
  const to = Math.floor(hi)
  if (to <= from) return from
  return Math.min(to - 1, from + Math.floor(rng() * (to - from)))
}

/**
 * A shuffled copy of `items`. The input is never touched.
 *
 * Fisher–Yates walked from the end, which is the version that is uniform over
 * permutations; the naive `sort` with a random comparator is not, and its bias
 * is invisible on a list of five and obvious on a list of five thousand. A copy
 * rather than an in-place shuffle because the callers are subsetting feature
 * lists that other outputs of the same task still refer to in their original
 * order.
 */
export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, 0, i + 1)
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}
