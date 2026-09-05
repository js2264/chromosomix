/**
 * The ink a called variant is drawn in.
 *
 * One rule: **a substitution takes the colour of the base it substitutes to**,
 * and everything else takes the lane's own colour. That is the whole of it, and
 * the reason it is worth a module is what it buys vertically. Open a FASTA, a
 * BAM and a VCF over one locus and a heterozygous A>G reads as one column in
 * three inks that agree — the sequence row writes a green `A`, the pile puts
 * blue `G` marks through half its reads, and the variant row draws a blue box
 * saying somebody called it. The colours come from the one table
 * `render/sequence.ts` holds, which `render/alignments.ts` already borrows for
 * exactly this reason, so there is no second palette to keep in step.
 *
 * ## The record with no base to be coloured by
 *
 * An insertion's bases are not in the reference at all and a deletion's ALT is
 * the padding base that did not change, so neither has a single base the mark
 * could be *about*. Those take `BASE_COLOURS`' fifth slot — the grey the
 * sequence lane and the pile already draw an `N` in, which in this application
 * means exactly *no single-base answer*. Same claim, same ink, and it is the
 * one entry in that table that is a neutral rather than a hue, so it can never
 * be mistaken for one of the four.
 *
 * The lane's **own** colour was tried there first and is wrong, visibly:
 * the default is `#1f5fa9` and `C` is `#2f6fb5`, so on a stock lane an
 * insertion and a substitution to C were the same blue. A reader's colour is
 * not out of the picture — it is what the density rung is drawn in, which is
 * where it does the work of telling two variant files apart at a zoom where no
 * individual mark is legible anyway.
 *
 * ## What this deliberately does not distinguish
 *
 * An insertion from a deletion: both are grey. Inventing two more inks would
 * put two colours on the lane that mean something other than what every other
 * colour on it means, and this application's own rule (§8.12, and
 * `VARIANT_COLOUR` at `render/tracks.ts`) is that an ink says one thing.
 *
 * What tells them apart instead is **extent**, which is free and exact: a
 * forty-kilobase deletion is a forty-kilobase box and a SNV is one base, so the
 * two classes a reader most needs to separate are separated by the strongest
 * channel on the lane. The rest — insertion against one-base deletion, which do
 * look alike — is in the box's detail and in the card behind a click, where
 * `A>AGGT` and `AT>A` are two strings nobody can confuse.
 */

import { BASE_COLOURS } from './sequence'

/**
 * The narrowest a variant box is drawn, in pixels.
 *
 * A single base is a hairline at every zoom a reader browses a chromosome at —
 * `laneRect` floors it to one pixel, which is enough to *exist* and not enough
 * to see or to hit. Three is where a mark reads as a mark beside the
 * one-pixel-wide guides this application already draws, and it is small enough
 * that a lane of them still packs into rows rather than merging.
 *
 * Grown from the variant's *start*, never centred on it: a mark centred on a
 * single base sits half a mark before the position it is about, and at the zoom
 * where that matters — a reader checking a call against the residue under it —
 * being one base out is the whole question.
 */
export const VARIANT_MIN_WIDTH = 3

/** `BASE_CODE`'s order, which is {@link BASE_COLOURS}' order. */
const BASES = 'ACGT'

/**
 * The colour for one variant, from the `REF>ALT` its detail string opens with.
 *
 * Reading it back out of the detail rather than carrying a colour column,
 * because a `FeatureSet` is a struct of arrays sized for millions of rows and
 * this is asked a few hundred times per frame — once per *placement*, which the
 * layout has already capped. The same pass that writes the labels.
 *
 * A record with several ALTs falls back even when they are all single bases:
 * `A>G,T` is two substitutions to two different bases and there is no single
 * honest colour for it, so it takes the lane's rather than picking one of them.
 */
export function variantInk(detail: string, fallback: string): string {
  const arrow = detail.indexOf('>')
  // Not a `REF>ALT` at all, which is a detail string from some other parser and
  // therefore a bug rather than a variant. A bug must not paint: the lane's own
  // colour is the answer that says nothing.
  if (arrow <= 0) return fallback
  const ref = detail.slice(0, arrow)
  // The detail's first part ends at the separator, wherever the joiner put it.
  const stop = detail.indexOf(' ', arrow)
  const alt = stop < 0 ? detail.slice(arrow + 1) : detail.slice(arrow + 1, stop).replace(/·$/, '')
  if (ref.length !== 1 || alt.length !== 1) return NO_SINGLE_BASE
  const at = BASES.indexOf(alt.toUpperCase())
  return at < 0 ? NO_SINGLE_BASE : BASE_COLOURS[at]
}

/**
 * The ink for a record with no single base behind it.
 *
 * `BASE_COLOURS`' fifth slot, which is what the sequence lane and the pile draw
 * an `N` in — so it already means *no single-base answer* everywhere else on
 * screen, and this is the same sentence rather than a new one. It is also the
 * one entry in that table that is a neutral rather than a hue, which is why it
 * cannot be confused with a letter the way the lane's own colour could.
 */
const NO_SINGLE_BASE = BASE_COLOURS[4]
