/**
 * Range resolution — a mirror of `metacooler.ops.range` and, underneath it,
 * cooler's `parse_region` / `Cooler.extent` (spec §5.4).
 *
 * The same string must mean the same bins in the browser and in the CLI, so
 * the parsing is ported rather than reimplemented, humanised units and all.
 */

import { UNBINNED_NAME } from '../constants'
import { NameIndex, type NameContext } from '../genome/naming'
import { truncateNames, ViewerError } from '../errors'
import { pyRepr } from '../format'
import type { Extent, ParsedRange, Table } from '../types'

/**
 * The slice of the reader {@link parseMetacoolerRange} needs.
 *
 * Structural rather than the concrete `MetaCooler` for two reasons: it breaks
 * what would otherwise be an import cycle between the class and this module,
 * and it lets the worker's `ReaderApi` — the same object seen through a
 * narrower interface — be passed straight in.
 */
export interface RangeTarget {
  /** `null` for a plain cooler: there are no genome names to resolve. */
  readonly genomes: Table | null
  readonly contigs: Table
  /**
   * This file's sequences under every convention that might name one.
   *
   * Optional because a synthesised target need not carry one, and because it is
   * only ever reached on the path where the strict answer was already an error
   * — see {@link parseMetacoolerRange}. Absent, one is built from the contig
   * table, which is the same index a moment later and costs the same.
   */
  readonly names?: NameIndex
  /** Row indices of {@link genomes} that may be shown (§7.4). */
  displayGenomes(): number[]
  genomeExtent(genome: string): Extent
  extent(region: string): Extent
}

/** Multipliers cooler's `parse_humanized` understands, after upper-casing. */
const UNITS: Record<string, number> = {
  K: 1e3,
  KB: 1e3,
  M: 1e6,
  MB: 1e6,
  G: 1e9,
  GB: 1e9,
}

/** Throw a malformed-range refusal carrying cooler's own wording. */
function badRange(message: string, detail: Record<string, unknown> = {}): never {
  throw new ViewerError('bad-range', message, detail)
}

/**
 * Port of cooler's `parse_humanized`: `"1,000"`, `"1.5kb"`, `"2M"` → an integer.
 *
 * The comma strip happens first, so thousands separators are legal everywhere;
 * the result is truncated toward zero exactly as Python's `int(float)` is.
 */
export function parseHumanized(text: string): number {
  const parts = text.replace(/,/g, '').split(/([0-9.]+)/)
  // Python unpacks the split into exactly three names, so anything with a
  // second numeric run (`"1k2"`) is an error there and must be one here.
  if (parts.length !== 3 || parts[0] !== '') badRange(`Unexpected token "${text}"`, { token: text })
  const [, digits, rawUnit] = parts
  if (rawUnit.length === 0) {
    if (!/^[0-9]+$/.test(digits)) badRange(`Unexpected token "${text}"`, { token: text })
    return Number(digits)
  }
  const value = Number.parseFloat(digits)
  if (!Number.isFinite(value)) badRange(`Unexpected token "${text}"`, { token: text })
  const unit = rawUnit.toUpperCase().trim()
  const multiplier: number | undefined = UNITS[unit]
  if (multiplier === undefined) badRange(`Unknown unit '${unit}'`, { unit })
  return Math.trunc(value * multiplier)
}

/** One token of a coordinate suffix, as cooler's `_tokenize` yields them. */
type Token = { kind: 'HYPHEN' | 'COORD' | 'OTHER'; text: string }

/** Port of cooler's `_tokenize`: hyphens, coordinates, and everything else. */
function tokenize(text: string): Token[] {
  const re = /\s*(-)|\s*([0-9,]+(?:\.[0-9]*)?(?:[a-z]+)?)|\s*(.+)/gi
  const tokens: Token[] = []
  for (const match of text.matchAll(re)) {
    const hyphen: string | undefined = match[1]
    const coord: string | undefined = match[2]
    const other: string | undefined = match[3]
    if (hyphen !== undefined) tokens.push({ kind: 'HYPHEN', text: hyphen })
    else if (coord !== undefined) tokens.push({ kind: 'COORD', text: coord })
    else tokens.push({ kind: 'OTHER', text: other ?? '' })
  }
  return tokens
}

/**
 * Port of cooler's `parse_region_string`.
 *
 * Splits on the first `:` only, so a contig whose name contains a colon is
 * unaddressable — a cooler limitation this viewer inherits deliberately rather
 * than diverging from.
 *
 * @returns `[chrom, start, end]` with `null` for coordinates the string omits.
 */
export function parseRegionString(text: string): [string, number | null, number | null] {
  const parts = text.split(':')
  const chrom = parts[0].trim()
  if (chrom.length === 0) badRange('Chromosome name cannot be empty', { region: text })
  if (parts.length < 2) return [chrom, null, null]

  // Only `parts[1]` is tokenised, as in cooler: a second colon and anything
  // after it is discarded rather than being an error.
  const tokens = tokenize(parts[1])
  let i = 0
  const next = (): Token | undefined => tokens[i++]

  const expect = (token: Token | undefined, kinds: Token['kind'][]): Token => {
    if (token === undefined) badRange(`Expected ${kinds.join(' or ')} token missing`, { region: text })
    if (!kinds.includes(token.kind)) badRange(`Unexpected token "${token.text}"`, { region: text })
    return token
  }

  const start = parseHumanized(expect(next(), ['COORD']).text)
  expect(next(), ['HYPHEN'])
  const tail = next()
  if (tail === undefined) return [chrom, start, null]
  const end = parseHumanized(expect(tail, ['COORD']).text)
  if (end < start) badRange('End coordinate less than start', { region: text, start, end })
  return [chrom, start, end]
}

/**
 * Port of cooler's `parse_region`: fill in the open ends and bounds-check.
 *
 * Note what this is *not*: despite the UCSC-looking syntax, cooler applies no
 * 1-based-to-0-based conversion anywhere — `parse_region_string` returns the
 * digits as written and `parse_region` uses them as a 0-based half-open
 * interval. The docstrings in both cooler and metacooler say "1-based, fully
 * closed"; the code does not, and the code is what the CLI actually does, so
 * it is what this mirrors. Diverging would silently shift every region view by
 * one bin relative to `metacooler show --range`.
 */
export function parseRegion(
  region: string,
  chromsizes: Map<string, number>,
): [string, number, number] {
  const [chrom, rawStart, rawEnd] = parseRegionString(region)
  const clen = chromsizes.get(chrom)
  if (clen === undefined) {
    throw new ViewerError('unknown-label', `Unknown sequence label: ${chrom}`, { label: chrom })
  }
  const start = rawStart === null ? 0 : rawStart
  const end = rawEnd === null ? clen : rawEnd
  if (end < start) badRange('End cannot be less than start', { region, start, end })
  if (start < 0 || end > clen) {
    badRange(`Genomic region out of bounds: [${start}, ${end})`, { region, start, end, length: clen })
  }
  return [chrom, start, end]
}

// ---------------------------------------------------------------------------
// metacooler-level range resolution (ops/range.py)
// ---------------------------------------------------------------------------

/**
 * Resolve a range string to a half-open bin interval, mirroring
 * `parse_metacooler_range` including every one of its refusals.
 *
 * Resolution order, and it matters: the label (everything before the first
 * `:`) is tested against **genome** names first. Genome and contig namespaces
 * can collide, and Python lets the genome win; matching contigs first would
 * make the same string mean different things in the two implementations.
 *
 * Three refusals, each distinct on purpose:
 * - `__unbinned__` → `unbinned-not-displayable`. Unassigned contigs are not a
 *   genome (§7.4); folding this into "unknown label" would leave the user
 *   doubting a name they read off the file.
 * - a coordinate suffix on a genome name → `genome-coordinate-suffix`. Python
 *   raises rather than silently ignoring the suffix, so a user who asks for
 *   part of a genome is told that genome ranges are whole-genome.
 * - anything else → `unknown-label`, listing both namespaces truncated to 20.
 *
 * ...except that the last of those three is now tried twice. Before refusing, a
 * label is offered to {@link NameIndex}, which knows that `chr1`, `1`, `01` and
 * `I` are one chromosome under four conventions (§5.9). `context` is the naming
 * context of the file the label came *out of*, where the caller has one — a
 * companion panel following a lead of another nomenclature — because a Roman
 * numeral is Roman by virtue of the list it was written in.
 */
export function parseMetacoolerRange(
  mc: RangeTarget,
  rangeStr: string,
  context?: NameContext,
): ParsedRange {
  // No trim: Python splits the raw string, so `' MAG_1'` is genuinely unknown.
  const label = rangeStr.split(':')[0]
  // Membership by scanning the name columns, exactly as `ops/range.py` tests
  // `label in mc.genomes["name"].tolist()`.
  const genomeNames = mc.genomes === null ? [] : mc.genomes.strings('name')
  const contigNames = mc.contigs.strings('name')

  if (genomeNames.includes(label)) {
    if (label === UNBINNED_NAME) {
      throw new ViewerError(
        'unbinned-not-displayable',
        `Range ${pyRepr(rangeStr)}: ${pyRepr(UNBINNED_NAME)} holds every contig that binning ` +
          `failed to assign. It is a bookkeeping row, not a genome — there is no coherent ` +
          `contact map to draw for it — so it cannot be displayed. Its share of the file is ` +
          `reported as a QC statistic in the file info panel.`,
        { label },
      )
    }
    if (rangeStr.includes(':')) {
      throw new ViewerError(
        'genome-coordinate-suffix',
        `Range ${pyRepr(rangeStr)}: ${pyRepr(label)} is a genome name — coordinate suffixes ` +
          `are not allowed for genome ranges. Use just ${pyRepr(label)}.`,
        { label, region: rangeStr },
      )
    }
    return { kind: 'genome', label, extent: mc.genomeExtent(label) }
  }

  if (contigNames.includes(label)) {
    return { kind: 'contig', label, extent: mc.extent(rangeStr) }
  }

  // Nothing under that spelling. **This, and only this, is where the naming
  // conventions get a hearing** (§5.9) — after both namespaces have been asked
  // literally and the answer would otherwise be a refusal.
  //
  // Putting it here rather than at the top is the whole of how this stays a
  // faithful port. Every string the file *does* carry resolves exactly as
  // `ops/range.py` resolves it, in the same order, with the same genome-wins
  // rule; a session of one file cannot tell this clause exists. What changes is
  // only the error case: a deck holding a UCSC `.hic` beside an Ensembl `.cool`
  // used to answer one of them `unknown-label` and show a blank panel, and now
  // answers both.
  //
  // Contigs only, deliberately. A genome name in a metacool is a MAG somebody
  // binned, not a chromosome anybody has a convention for, and §8.5's argument
  // — two independently assembled organisms agree about a name by coincidence —
  // applies to those names hardest of all.
  const matched = (mc.names ?? indexOf(mc)).find(label, { from: context })
  if (matched !== null) {
    // Answered here rather than by re-entering this function with the rewritten
    // string. A second pass would start again at the *genome* test, and in a
    // metacool whose MAGs are numerically named a contig matched across
    // conventions would come back as a genome — or, with a coordinate suffix on
    // it, as `genome-coordinate-suffix`. What was matched is a contig; this
    // says so, and it is the only way `parseMetacoolerRange` can be reached
    // twice for one string.
    const suffix = rangeStr.slice(label.length)
    return {
      kind: 'contig',
      label: matched.name,
      extent: mc.extent(`${matched.name}${suffix}`),
      matched,
    }
  }

  // The genome list is the *displayable* one: `__unbinned__` is not selectable
  // in any view (§7.4), so offering it as an available name would contradict
  // the refusal a user gets the moment they take the suggestion.
  throw new ViewerError(
    'unknown-label',
    `Range ${pyRepr(rangeStr)}: ${pyRepr(label)} is not a known genome or contig.\n` +
      `  Genomes: ${truncateNames(mc.displayGenomes().map((i) => genomeNames[i]))}\n` +
      `  Contigs: ${truncateNames(contigNames)}`,
    { label, region: rangeStr },
  )
}

/** A name index over a target that did not bring one. */
function indexOf(mc: RangeTarget): NameIndex {
  const names = mc.contigs.strings('name')
  const lengths = mc.contigs.numbers('length')
  return NameIndex.of(names.map((name, i) => ({ name, length: lengths[i] })))
}

/**
 * The bin extent of a `contig` / `contig:start-end` region, as
 * `cooler.Cooler.extent` computes it for a fixed-bin file —
 * `chrom_offset[cid] + floor(start / binsize)` to
 * `chrom_offset[cid] + ceil(end / binsize)` — **clamped to the contig's own
 * bins**.
 *
 * The clamp is not cosmetic, and it is the one place this port deliberately
 * answers something cooler's arithmetic does not.
 *
 * A coarsened `.mcool` level does not carry `binnify(chromsizes, binsize)`'s
 * bin table. `cooler zoomify` merges the fine bins in groups of the factor, and
 * where a chromosome's fine bin count is not a multiple of it, the remainder is
 * absorbed into the last coarse bin rather than given one of its own — yeast
 * chromosome I at 2 kb ends in a single `228,000–230,218` bin, so the level has
 * 115 bins for it where `ceil(230218 / 2000)` says 116. The extra one is the
 * *first bin of chromosome II*, and the arithmetic hands it back for every
 * chromosome whose fine bin count was odd: I, VI, XII, XIV and XVI in this
 * assembly.
 *
 * What that costs is not one stray column. A block that spans two chromosomes
 * has two axis groups, so the view stops being a single-coordinate one: the
 * base-pair ticks along the edge disappear, the label switches to two names,
 * and the picture quietly gains a row and a column of another chromosome's
 * contacts. `chrom_offset` is the authority on which bins belong to a
 * chromosome — it is what the pixels are indexed by — so it, not the division,
 * decides where the block ends.
 */
export function regionToExtent(
  chromOffset: ArrayLike<number>,
  contigId: number,
  start: number,
  end: number,
  binsize: number,
): Extent {
  const base = chromOffset[contigId]
  const limit = chromOffset[contigId + 1] ?? base
  const lo = Math.min(base + Math.floor(start / binsize), limit)
  const hi = Math.min(base + Math.ceil(end / binsize), limit)
  return [lo, Math.max(lo, hi)]
}
