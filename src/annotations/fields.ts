/**
 * The columns a feature set can be *coloured by*, discovered from the file.
 *
 * A `FeatureSet` is a struct of arrays with one loose end: {@link
 * FeatureSet.detail}, which holds everything the parsers kept that has no
 * column of its own — a GTF's `source` and `biotype`, a narrowPeak's `signal`
 * and its two `-log10` columns, a VCF's `QUAL`, `filter` and `SVTYPE`. That is
 * deliberate and §8.3 defends it: a 41,000-line GTF as an array of objects is
 * four megabytes of pointer chasing to draw a picture with three hundred glyphs
 * in it, and a column per attribute would be a schema this app does not have.
 *
 * The cost of that is paid here. A reader who wants their genes coloured by
 * biotype is asking about a fact that exists only inside a joined string, so
 * this module does two things and nothing else: it says **which keys the file
 * writes**, by sampling rows and reading the `key value` shape the parsers all
 * use, and it says **what one row's value is** for a key, by scanning that
 * row's own string.
 *
 * Both are cheap where it matters. Discovery is sampled, capped and cached per
 * set; the per-row read happens once per *placement*, which the layout has
 * already bounded by the pixels on screen (`render/features.ts`) — the same
 * bargain `render/variants.ts` makes, and for the same reason.
 *
 * No DOM, no canvas, no colour: this module answers *what is in the file*. What
 * that is drawn in is `render/featureInk.ts`.
 */

import { DETAIL_SEP, type AnnotationKind, type FeatureSet } from './types'

/**
 * What kind of answer a field gives, which is what decides how it is inked.
 *
 * `strand` and `base` are the two the file cannot be asked about in general —
 * they are columns of the set and of the VCF detail respectively — and each has
 * an ink rule of its own that predates this module (§8.14).
 */
export type FeatureFieldKind = 'lane' | 'strand' | 'base' | 'number' | 'category'

/** One offered colouring. */
export interface FeatureField {
  /** What is stored in the style and matched against a detail part. */
  key: string
  /** What the picker shows. */
  label: string
  kind: FeatureFieldKind
  /** The `title` on the option, for the keys whose meaning is not the word. */
  hint: string
}

/** One colour for the whole lane — the way every feature lane used to be drawn. */
export const FIELD_LANE = ''

/** The set's own strand column: the default everywhere but a VCF. */
export const FIELD_STRAND = 'strand'

/** The set's own score column. */
export const FIELD_SCORE = 'score'

/** A called variant's `REF>ALT`, which is §8.14's rule and a VCF lane's default. */
export const FIELD_BASE = 'base'

/**
 * How many rows are read to find out which keys a file writes.
 *
 * Sampled **across the whole file** rather than taken from its head, which is
 * the difference between a control that works and one that works on sorted
 * files only: a BED is in contig order, so a `source` that only appears on the
 * last chromosome is invisible to any number of rows read from the front. The
 * stride costs exactly the same and cannot miss a category that is more than
 * one twenty-thousandth of the file.
 *
 * Twenty thousand because the work is a string split per sampled row and this is
 * done once per set, on the main thread, the first time a picker is opened.
 */
const FIELD_SCAN = 20_000

/**
 * The most categories a colouring resolves, the `other` bucket included.
 *
 * `CATEGORY_PALETTE` is twelve colours and the last four of them are already
 * darker variants reached only when nothing is going to be perfectly
 * distinguishable (`render/meta.ts`). Past that the honest thing is not a
 * thirteenth colour but a bucket that says *the rest*, which is what the legend
 * then names.
 */
export const MAX_LEVELS = 12

/** What the rarest values are gathered into once {@link MAX_LEVELS} is reached. */
export const OTHER_LEVEL = 'other'

/** What a row that does not carry the field at all is called, in the legend. */
export const ABSENT_LEVEL = 'not set'

/**
 * Every colouring this set can offer, in the order the picker lists them.
 *
 * Ordered by how likely a reader is to want it rather than by where it came
 * from: the two columns every set has come first, then the file's own keys in
 * the order the parser wrote them — which for a GTF is biotype, then source,
 * and for a narrowPeak is signal, then the two p-values.
 *
 * `undefined` for a set that has not arrived yet, which is a real state: the
 * card is built while the worker is still parsing, and a picker that was empty
 * then and full a second later would lose the reader's choice in between. The
 * built-ins are offered regardless, because they are properties of the *shape*
 * rather than of the contents.
 */
export function featureFields(
  set: FeatureSet | undefined,
  kind: AnnotationKind,
): FeatureField[] {
  const out: FeatureField[] = [
    {
      key: FIELD_LANE,
      label: 'one colour',
      kind: 'lane',
      hint: 'The lane’s own colour, everywhere — what to pick when the point is where the features are rather than what they are.',
    },
    {
      key: FIELD_STRAND,
      label: 'strand',
      kind: 'strand',
      hint: 'Forward, reverse, and the features whose file carries no strand at all. The default, because it is the one fact every one of these formats can be asked for.',
    },
  ]
  if (kind === 'variants') {
    out.push({
      key: FIELD_BASE,
      label: 'substituted base',
      kind: 'base',
      hint: 'The base the record substitutes to, so the lane agrees in a column with the sequence and the pile (§8.14). A variant lane’s default.',
    })
  }
  out.push({
    key: FIELD_SCORE,
    label: 'score',
    kind: 'number',
    hint: 'The set’s own score column — a BED’s column 5, a peak’s signal. Drawn as a ramp between the smallest and largest in the file.',
  })
  if (set === undefined) return out
  const seen = new Set(out.map((field) => field.key))
  for (const [key, numeric] of scanKeys(set)) {
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      label: key,
      kind: numeric ? 'number' : 'category',
      hint: numeric
        ? `${key}, as the file writes it — a ramp between the smallest and largest value sampled.`
        : `${key}, as the file writes it — a colour per distinct value.`,
    })
  }
  return out
}

/** The field this key names, or `null` where the file no longer carries it. */
export function fieldFor(
  fields: readonly FeatureField[],
  key: string,
): FeatureField | null {
  return fields.find((field) => field.key === key) ?? null
}

/**
 * One row's value for one key, as the file wrote it.
 *
 * `''` where the row does not carry the key, which is a different answer from
 * every other and is drawn as one: a GTF where half the genes have a biotype
 * and half do not is a file saying two things, and colouring the silent half as
 * if they were some category would be inventing the fact.
 */
export function fieldText(set: FeatureSet, index: number, key: string): string {
  if (key === FIELD_STRAND) return strandText(set.strand[index])
  if (key === FIELD_SCORE) {
    const score = set.score[index]
    return Number.isFinite(score) ? String(score) : ''
  }
  const detail = set.detail[index] ?? ''
  if (detail === '') return ''
  // `startsWith(key + ' ')` rather than a split-and-compare: the parts are
  // joined, the key is known, and this is the one function in the module that
  // runs per placement per frame.
  const lead = `${key} `
  for (const part of detail.split(DETAIL_SEP)) {
    if (part.startsWith(lead)) return part.slice(lead.length)
  }
  return ''
}

/** The same, as a number. `NaN` for a row that does not carry it. */
export function fieldNumber(set: FeatureSet, index: number, key: string): number {
  if (key === FIELD_SCORE) return set.score[index]
  const text = fieldText(set, index, key)
  return text === '' ? Number.NaN : Number(text)
}

/** `+`, `−` or the em dash that means the file said nothing. */
export function strandText(strand: number): string {
  return strand > 0 ? '+' : strand < 0 ? '−' : ABSENT_LEVEL
}

/**
 * The distinct values of a categorical field, commonest first.
 *
 * Ordered by count for one reason and it is about the picture rather than the
 * list: the palette's first colours are its most distinct, and giving those to
 * the values that cover the most features is what makes the lane readable at a
 * glance. A tail past {@link MAX_LEVELS} becomes one bucket named
 * {@link OTHER_LEVEL}, because a thirteenth colour nobody can name is not an
 * answer.
 *
 * Cached per set and key. The scan is a sample (see {@link FIELD_SCAN}), so a
 * value rarer than one in twenty thousand can land in `other` without appearing
 * in its own right — which is the honest failure for this: the legend says
 * `other`, and the feature card behind a click always says the true value.
 */
export function fieldLevels(set: FeatureSet, key: string): string[] {
  const held = cacheFor(set)
  const known = held.levels.get(key)
  if (known !== undefined) return known
  const counts = new Map<string, number>()
  forEachSampled(set, (index) => {
    const value = fieldText(set, index, key)
    if (value === '' || value === ABSENT_LEVEL) return
    counts.set(value, (counts.get(value) ?? 0) + 1)
  })
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value)
  const levels =
    sorted.length > MAX_LEVELS ? [...sorted.slice(0, MAX_LEVELS - 1), OTHER_LEVEL] : sorted
  held.levels.set(key, levels)
  return levels
}

/**
 * The span a numeric field is drawn across.
 *
 * Exact for {@link FIELD_SCORE}, which is a typed array and costs one pass;
 * sampled for anything read out of a detail string, for the reason the key scan
 * is. A value outside a sampled span is **clamped** to its end rather than left
 * uncoloured — the same thing a track's manual limits do, and the same claim: it
 * is at least this extreme.
 *
 * `min === max` for a column with one value in it, which the ink reads as *put
 * everything at the top of the ramp* rather than dividing by zero.
 */
export function fieldRange(set: FeatureSet, key: string): { min: number; max: number } {
  const held = cacheFor(set)
  const known = held.ranges.get(key)
  if (known !== undefined) return known
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  if (key === FIELD_SCORE) {
    for (let i = 0; i < set.length; i++) {
      const value = set.score[i]
      if (!Number.isFinite(value)) continue
      if (value < min) min = value
      if (value > max) max = value
    }
  } else {
    forEachSampled(set, (index) => {
      const value = Number(fieldText(set, index, key))
      if (!Number.isFinite(value)) return
      if (value < min) min = value
      if (value > max) max = value
    })
  }
  const range =
    min <= max ? { min, max } : { min: 0, max: 0 }
  held.ranges.set(key, range)
  return range
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * The keys this file writes, and whether each is a number.
 *
 * A part is `key value` with the **value as its last token**, which is the same
 * reading `ui/ParamForm.ts` makes of the same strings and for the same reason:
 * it keeps `-log10 p 4.5` a column called `-log10 p` rather than one called
 * `-log10`. A key that is itself a number is rejected — that is `4 exons`, whose
 * number is on the wrong side — and a part with no space at all is rejected too,
 * which is how a VCF's leading `A>G` stays out of the list it has no business
 * in.
 *
 * Numeric until proved otherwise, over the whole sample: one row writing
 * `signal .` does not make a signal column categorical, and one row writing
 * `filter PASS` is enough to keep `filter` out of the ramps.
 */
function scanKeys(set: FeatureSet): Map<string, boolean> {
  const held = cacheFor(set)
  if (held.keys !== null) return held.keys
  const keys = new Map<string, boolean>()
  forEachSampled(set, (index) => {
    const detail = set.detail[index] ?? ''
    if (detail === '') return
    for (const part of detail.split(DETAIL_SEP)) {
      const at = part.lastIndexOf(' ')
      if (at <= 0) continue
      const key = part.slice(0, at).trim()
      const value = part.slice(at + 1)
      if (key === '' || value === '' || Number.isFinite(Number(key))) continue
      const numeric = Number.isFinite(Number(value))
      const before = keys.get(key)
      keys.set(key, before === undefined ? numeric : before && numeric)
    }
  })
  held.keys = keys
  return keys
}

/** Every {@link FIELD_SCAN}th row, so a sample spans the file rather than its head. */
function forEachSampled(set: FeatureSet, visit: (index: number) => void): void {
  const step = Math.max(1, Math.floor(set.length / FIELD_SCAN))
  for (let i = 0; i < set.length; i += step) visit(i)
}

interface FieldCache {
  keys: Map<string, boolean> | null
  levels: Map<string, string[]>
  ranges: Map<string, { min: number; max: number }>
  /** Which strands the file uses; see {@link strandBands}. */
  bands: number[] | null
}

/**
 * What has already been scanned, per set.
 *
 * Weak, because a `FeatureSet` is dropped when its row is closed and nothing
 * here should be the reason a 400 MB parse stays reachable. The set is
 * immutable once the worker has handed it over, so a cached answer cannot go
 * stale — a reloaded file is a new set and a new cache.
 */
const CACHES = new WeakMap<FeatureSet, FieldCache>()

function cacheFor(set: FeatureSet): FieldCache {
  const held = CACHES.get(set)
  if (held !== undefined) return held
  const made: FieldCache = { keys: null, levels: new Map(), ranges: new Map(), bands: null }
  CACHES.set(set, made)
  return made
}

/**
 * Which strands this file uses, in the order their bands are drawn.
 *
 * Unstranded first, then forward, then reverse — outward from the map, which on
 * the 1D browser and on a bottom stack reads top to bottom. The order is a
 * decision and it is this one because the two that mirror each other belong
 * next to each other: `+` above `−` is how every stranded picture in genomics
 * is laid out, from a pair of RNA-seq tracks to a gene model, and the features
 * the file could not say either way are neither of them and so go above both
 * rather than between them.
 *
 * Read from the **file** and not from the window, which is the whole reason it
 * is worth caching. Bands decided per window would be rebuilt on every pan: a
 * region holding only forward genes would draw them across the whole lane, and
 * the first reverse gene to scroll into view would move every glyph on screen.
 * A file's strands do not change, so neither does its layout.
 *
 * One pass over an `Int8Array`, stopped the moment all three have been seen —
 * which on any real annotation is the first few dozen rows.
 */
export function strandBands(set: FeatureSet): number[] {
  const held = cacheFor(set)
  if (held.bands !== null) return held.bands
  let seen = 0
  for (let i = 0; i < set.length && seen !== 0b111; i++) {
    const strand = set.strand[i]
    seen |= strand > 0 ? 0b010 : strand < 0 ? 0b100 : 0b001
  }
  const bands = [0, 1, -1].filter((_, i) => (seen & (1 << i)) !== 0)
  held.bands = bands
  return bands
}

// ---------------------------------------------------------------------------
// What the reader chose
// ---------------------------------------------------------------------------

/**
 * The controls a lane of intervals has that no other kind does.
 *
 * A nested optional record on {@link AnnotationStyle}, in the shape and for the
 * reasons `ReadStyle` is one: the fields mean nothing to a value track, being
 * optional means no existing kind and no stored row changes shape, and the
 * accessor below is what keeps `undefined` from ever reaching a renderer.
 *
 * It lives here rather than beside `ReadStyle` because `colourBy` is a **key of
 * the file**, not a member of a closed set — so the only module that can say
 * what a stored value means is the one that reads the file's keys, and a type
 * whose whole meaning is in this module belongs in it. `annotations/types.ts`
 * takes it as a type-only import, which is erased, so nothing here is in that
 * module's runtime cycle.
 */
export interface FeatureStyle {
  /**
   * Which field the ink comes from: `''`, a built-in, or a key of the file.
   *
   * An open string rather than a union, because the interesting answers are the
   * file's own — `source`, `biotype`, `signal` — and a union could only ever
   * name the built-ins. It is checked where it is *used* (`fieldFor` returns
   * `null` for a key the set does not carry), which is the only place that can
   * check it: the same string is right for one file and meaningless for the
   * next, and a session travels between them.
   */
  colourBy: string
  /**
   * Point a stranded feature the way it runs.
   *
   * On by default. The direction a feature is transcribed in is a fact the file
   * carries and no amount of colour states it — two inks say *which* strand,
   * an arrowhead says *which way*, and a reader following an operon or a
   * cluster of tandem repeats is reading the second. Off is for a figure where
   * the boxes are so small that a head is a smudge on every one of them, and
   * for readers who want the plain rectangles this lane always drew.
   */
  arrows: boolean
  /**
   * What a barChart's bars are measured against (§8.17).
   *
   * `file` is one ceiling for every chart on the lane, and it is the default
   * because it is the only setting under which two glyphs can be *compared*:
   * a tall bar means a big number, here and three windows away, and that is
   * the reading a lane of charts is for.
   *
   * `feature` scales each chart to its own tallest bar, and it exists because
   * the common case defeats the default. Expression is heavy-tailed — a
   * handful of ribosomal genes run a thousand times the median — so against
   * one ceiling the whole lane is flat and the picture says only *where the
   * ribosomal genes are*, which the reader already knew. Per feature, every
   * chart is a **shape**: which condition wins, and by how much relative to
   * the rest of that gene. Two readings, both true, and neither is a default
   * that could serve for the other — so it is a switch rather than a
   * heuristic that guesses from the distribution.
   *
   * Meaningless on every other feature kind, and harmless there: nothing but
   * `drawBarCharts` reads it.
   */
  bars: BarScale
}

/**
 * The two things a bar's height can be measured against; see
 * {@link FeatureStyle.bars}.
 */
export type BarScale = 'file' | 'feature'

/**
 * What a feature lane starts on.
 *
 * **Strand**, everywhere but a VCF. It is the one column every one of these
 * formats can be asked for, it needs no scan of the file to resolve, and it is
 * the fact a reader is most often after — which is why a genome browser has
 * drawn it since there were genome browsers. A VCF starts on §8.14's rule
 * instead, because a called variant has no strand and its `REF>ALT` is what
 * makes the lane agree with the sequence and the pile above it.
 */
export function defaultFeatureStyle(kind: AnnotationKind): FeatureStyle {
  return {
    colourBy: kind === 'variants' ? FIELD_BASE : FIELD_STRAND,
    arrows: true,
    // Comparable before legible: a lane whose glyphs cannot be compared is a
    // row of shapes, and a reader who wants the shapes can ask for them.
    bars: 'file',
  }
}

/**
 * One lane's feature controls, whether or not its style carries any.
 *
 * The accessor every reader goes through, so that the field being optional
 * costs one call rather than a `??` at each site — and so that a session stored
 * before it existed opens on the defaults rather than with `undefined` reaching
 * a renderer. The same contract `readsOf` has.
 */
export function featuresOf(
  style: { features?: FeatureStyle },
  kind: AnnotationKind,
): FeatureStyle {
  return style.features ?? defaultFeatureStyle(kind)
}

/** The longest stored key that could possibly name a column. */
const KEY_LIMIT = 200

/**
 * Read a stored feature style back, clamping every field.
 *
 * Stored state outlives the build that wrote it and arrives from a share link,
 * so this is untrusted input — `isStoredEntry` checks that `style` is an object
 * and no more. `colourBy` cannot be checked against a list (see
 * {@link FeatureStyle.colourBy}); what it can be is a string of a sane length,
 * and anything else becomes the default rather than the row being dropped.
 */
export function featureStyleOf(value: unknown, kind: AnnotationKind): FeatureStyle {
  const fallback = defaultFeatureStyle(kind)
  if (typeof value !== 'object' || value === null) return fallback
  const row = value as Record<string, unknown>
  const by = row['colourBy']
  return {
    colourBy: typeof by === 'string' && by.length <= KEY_LIMIT ? by : fallback.colourBy,
    // Absent means *on*: the default is what a row written before this existed
    // should come back as, and `!== false` is the only reading that gives it.
    arrows: row['arrows'] !== false,
    // …and absent means `file` here, for the same reason: only the one stored
    // string that names the other reading may move a restored lane off the
    // default.
    bars: row['bars'] === 'feature' ? 'feature' : 'file',
  }
}
