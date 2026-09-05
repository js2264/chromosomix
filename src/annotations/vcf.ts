/**
 * VCF: the variants somebody called, as a lane.
 *
 * ## Why this is a module of its own
 *
 * For the reason `annotations/signal.ts` is one, and it is the same failure.
 * `sniffFormat` reads a file's first *data* row and asks where the integers
 * are; `forEachRow` strips every `#` line on the way, so a VCF arrives there
 * with its `##fileformat` and its `#CHROM` header already gone. What is left —
 * `chrV 1000 rs100 A G 60 PASS …` — has an integer in column 1 and a word in
 * column 2, which matches nothing, and the sniffer's last line is
 * `return 'bed'`. A dropped VCF was refused with *"all 7 lines failed the
 * contig, start, end test that every BED-like format begins with"*: a message
 * naming a format the reader never handed over, about a file this app has every
 * piece needed to read.
 *
 * ## What a variant is, here
 *
 * An interval on one axis with a name and some attributes — which is a
 * {@link FeatureSet}, the same shape a BED and a GTF finish into. There is no
 * new payload, no new renderer and no new cache: a variant lane packs, draws,
 * hit-tests, exports, searches and collapses through the code a peak set
 * already uses. What it gets of its own is a `kind`, because the *controls* and
 * the *card* differ — a reader colours a variant set by what changed, and clicks
 * one to read `REF>ALT`, not to read a score.
 *
 * ## The interval, which is the one thing that can silently lie
 *
 * A record's span is the reference bases it is **about**, and for three of the
 * four record shapes that is `POS .. POS + len(REF)`:
 *
 * - a SNV `A → G` is one base;
 * - an MNV `AT → GC` is two;
 * - an indel carries VCF's padding base, so `CTTT → C` at 2000 spans 2000–2003
 *   and `G → GAA` spans the single base 2500. That is what the record says, and
 *   it is what every browser draws.
 *
 * The fourth shape is the one that has to be read out of `INFO`. A symbolic ALT
 * — `<DEL>`, `<DUP>`, `<INV>`, `<CNV>` — writes `N` in REF whatever the event's
 * size, so `len(REF)` is 1 and a forty-kilobase deletion would draw as a
 * one-pixel tick. `INFO/END` gives its end, and `INFO/SVLEN` gives its length
 * where `END` is absent. Reading them is not a decoration: without it the lane
 * draws a wrong answer that looks like an answer, which is the one thing §10
 * will not have.
 *
 * ## What is not read
 *
 * The **genotype columns**. A VCF's samples are a matrix of variants × samples,
 * and a matrix of that is a second application's worth of picture for a question
 * a contact map is not asking (SPECS §13). They are counted, and the count is
 * said out loud in the lane's summary — *"1,284 variants · 2 samples not
 * drawn"* — because a reader who brought a thousand-genome VCF should be told
 * what the lane is showing them rather than left to infer it.
 */

import { FeatureBuilder } from './featureset'
import { DETAIL_SEP, type FeatureSet } from './types'

/**
 * Whether these lines are a VCF.
 *
 * Two roads, and both are needed. The **declaration** is the format's own name
 * for itself and settles it outright: `##fileformat=VCFv4.2` is required by
 * every version of the spec and nothing else begins that way.
 *
 * The **shape** is what answers when the declaration is gone, which is not an
 * edge case here — it is the indexed path. `tabix.ts` serves one contig's byte
 * span out of a bgzipped file, and those spans begin at the first *record*, so
 * a `.vcf.gz` with a `.tbi` beside it reaches this function as bare data rows
 * with every `#` line left behind in the part that was never fetched. A sniffer
 * that only read the declaration would work on a plain VCF and fail on the
 * indexed one, which is the case the index exists for.
 *
 * The shape test is the same *where are the integers* rule the other sniffers
 * use, and it is exclusive against all four of them: a VCF row has an integer in
 * column 1 and a **non**-integer in column 2, which no BED (2 and 3 are
 * integers), no BEDPE (the same) and no GTF (column 1 is a source word) has. On
 * top of that the two allele columns have to look like alleles, which is what
 * keeps a headed TSV whose second column happens to be a word from landing here.
 */
export function sniffVcf(text: string): boolean {
  let rows = 0
  let index = 0
  const length = text.length
  while (index < length && rows < 4) {
    let end = text.indexOf('\n', index)
    if (end < 0) end = length
    let stop = end
    if (stop > index && text.charCodeAt(stop - 1) === 13) stop--
    const line = text.slice(index, stop)
    index = end + 1
    if (line === '') continue
    if (line.startsWith('##')) {
      // The declaration has to be the first line of a VCF, but a sliced or
      // concatenated file can put other metadata above it and nothing is lost by
      // accepting one anywhere in the header block.
      if (/^##fileformat=VCF/i.test(line)) return true
      continue
    }
    // `#CHROM POS ID REF ALT` is the column header, and it is as good a
    // declaration as the first line for a file that has lost its first line.
    if (line.startsWith('#')) {
      if (/^#CHROM\s+POS\s+ID\s+REF\s+ALT/i.test(line)) return true
      continue
    }
    const columns = line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/)
    if (!looksLikeRecord(columns)) return false
    rows++
  }
  // Four rows is enough to be sure and cheap enough to always pay — the same
  // number and the same reasoning `sniffSignal` uses. One row that is
  // VCF-shaped by coincidence is not four.
  return rows >= 4
}

/**
 * Whether one row of columns is shaped like a VCF record.
 *
 * The eight mandatory columns, an integer POS, a non-integer ID, and two
 * allele-shaped columns. Deliberately *not* a check that ID is `.` or an rsID:
 * a caller is free to put anything there, and a sniffer that demanded a
 * convention would refuse files that are perfectly legal.
 */
function looksLikeRecord(columns: string[]): boolean {
  if (columns.length < 8) return false
  if (!/^\d+$/.test(columns[1])) return false
  // The column that tells this from a BED: a BED's third column is its end.
  if (/^[+-]?\d+$/.test(columns[2])) return false
  return isAllele(columns[3]) && isAlt(columns[4])
}

/** REF: one or more of the IUPAC bases, and nothing else. */
function isAllele(value: string | undefined): boolean {
  return value !== undefined && /^[ACGTNacgtnRYKMSWBDHVryksmwbdhv]+$/.test(value)
}

/**
 * ALT: a comma-separated list of alleles, symbols, breakends, `*` or `.`.
 *
 * All five forms are in the spec and all five appear in files people have: `*`
 * is the allele overlapped by an upstream deletion, `.` is a monomorphic record
 * that a gVCF is full of, and a breakend is the `]chr2:321681]A` grammar a
 * structural caller writes.
 */
function isAlt(value: string | undefined): boolean {
  if (value === undefined || value === '') return false
  return value
    .split(',')
    .every(
      (one) =>
        one === '.' ||
        one === '*' ||
        isAllele(one) ||
        /^<[^<>]+>$/.test(one) ||
        /[[\]]/.test(one),
    )
}

/**
 * What changed, from REF and ALT.
 *
 * Four classes and a fallback, chosen because they are the four a reader tells
 * apart *by eye on the lane* — a substitution, something inserted, something
 * removed, and something too big or too strange to draw as either. A finer
 * taxonomy (transitions against transversions, tandem duplications against
 * dispersed ones) is a question about the data rather than about the picture,
 * and belongs to whatever asks it.
 *
 * A record with several ALTs takes the class they agree on, and `mixed` where
 * they do not: `A → G,T` is a substitution twice over and says so, while
 * `A → G,ATT` is genuinely two different events at one position and there is no
 * honest single answer.
 */
export type VariantClass = 'snv' | 'insertion' | 'deletion' | 'structural' | 'mixed'

export function variantClass(ref: string, alt: string): VariantClass {
  const alts = alt.split(',').filter((one) => one !== '' && one !== '.' && one !== '*')
  if (alts.length === 0) return 'snv'
  let agreed: VariantClass | null = null
  for (const one of alts) {
    const each: VariantClass =
      /^<[^<>]+>$/.test(one) || /[[\]]/.test(one)
        ? 'structural'
        : one.length === ref.length
          ? 'snv'
          : one.length > ref.length
            ? 'insertion'
            : 'deletion'
    if (agreed === null) agreed = each
    else if (agreed !== each) return 'mixed'
  }
  return agreed ?? 'snv'
}

/** Every class, in the order a key lists them. */
export const VARIANT_CLASSES: VariantClass[] = [
  'snv',
  'insertion',
  'deletion',
  'structural',
  'mixed',
]

/**
 * One `INFO` field's value, or `undefined`.
 *
 * A linear scan rather than a parsed map, because three keys are read out of a
 * column that routinely holds forty and building a `Map` per record would be
 * one allocation per variant for the benefit of the three. Flags — `INFO`
 * entries with no `=` — answer `''`, which is how the spec spells *present*.
 */
function infoOf(info: string, key: string): string | undefined {
  if (info === '' || info === '.') return undefined
  for (const part of info.split(';')) {
    if (!part.startsWith(key)) continue
    if (part.length === key.length) return ''
    if (part.charCodeAt(key.length) === 61) return part.slice(key.length + 1)
  }
  return undefined
}

/** A finite number, or `undefined` for `.` and for anything unparseable. */
function numberOf(value: string | undefined): number | undefined {
  if (value === undefined || value === '' || value === '.') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * How far the reference span of a record reaches, 0-based half-open.
 *
 * `POS + len(REF)` for everything the record spells out, and `INFO/END` or
 * `INFO/SVLEN` for a symbolic ALT, which spells nothing: `<DEL>` writes a single
 * `N` in REF however large the deletion is. Without this a forty-kilobase
 * deletion is a one-pixel tick — a wrong answer that looks like an answer, and
 * the only place in this parser where one is possible.
 *
 * `SVLEN` is negative for a deletion by convention and both signs appear in real
 * files, so its magnitude is what is used. A symbolic record with neither tag
 * keeps its single padding base rather than being dropped: the file says
 * *something happened here* and this app's job is to draw what the file says.
 */
function endOf(start: number, ref: string, alt: string, info: string): number {
  const plain = start + Math.max(1, ref.length)
  if (!/<[^<>]+>/.test(alt)) return plain
  const end = numberOf(infoOf(info, 'END'))
  // `END` is 1-based inclusive and `start` is already 0-based, so the two agree
  // without an adjustment — `END` *is* the half-open end.
  if (end !== undefined && end > start) return end
  const span = numberOf(infoOf(info, 'SVLEN'))
  if (span !== undefined && span !== 0) return start + Math.abs(span)
  return plain
}

/** How many samples a `#CHROM` line names, and whether one was seen at all. */
interface Samples {
  count: number
  named: boolean
}

/**
 * Read a VCF into intervals.
 *
 * Header lines are walked here rather than through `forEachRow`, because two of
 * them are worth reading: `#CHROM` says how many samples the file carries, and
 * that number goes in the lane's summary so a reader is told what is *not*
 * drawn.
 */
export function parseVcf(text: string): FeatureSet {
  const builder = new FeatureBuilder()
  const samples: Samples = { count: 0, named: false }
  let skipped = 0

  eachLine(text, (line) => {
    if (line.startsWith('##')) return
    if (line.startsWith('#')) {
      const columns = splitColumns(line)
      // Nine columns is CHROM..FORMAT, so anything past it is a sample.
      if (/^#CHROM$/i.test(columns[0] ?? '')) {
        samples.count = Math.max(0, columns.length - 9)
        samples.named = true
      }
      return
    }
    const columns = splitColumns(line)
    if (!looksLikeRecord(columns)) {
      skipped++
      return
    }
    const [contig, rawPos, id, ref, alt, qual, filter, info] = columns
    // VCF counts from one and this app counts from zero, everywhere and once —
    // the same conversion `parseWig` makes at its own door.
    const start = Number(rawPos) - 1
    if (!(start >= 0)) {
      skipped++
      return
    }
    builder.add(contig, start, endOf(start, ref, alt, info ?? ''), {
      // The rsID, where the file gives one. Both slots, and deliberately: `name`
      // is what the lane writes on the box and `id` is what the search box reads
      // (§8.1), so an rsID is typeable for free — and `FeatureSet.id` spells
      // "identified but not named" as `name === id`, which is exactly what a
      // variant with an accession and no symbol is.
      ...(id === undefined || id === '.' || id === '' ? {} : { name: id, id }),
      // QUAL, which is the file's own number for the row and the one a reader
      // would sort on. `.` is *not recorded* and stays `NaN` rather than
      // becoming a zero that would draw as a real, low score.
      ...(numberOf(qual) === undefined ? {} : { score: numberOf(qual) as number }),
      detail: detailOf(ref, alt, qual, filter, info ?? ''),
    })
  })

  if (builder.length === 0 && skipped > 0) {
    throw new Error(
      `No usable rows: all ${skipped} data lines failed the "contig, position, ID, REF, ALT" ` +
        'test a VCF record begins with.',
    )
  }
  const set = builder.finish()
  return set
}

/** Whether a set came from a file naming samples, for the summary line. */
export function samplesIn(text: string): number {
  let found = 0
  eachLine(text, (line) => {
    if (found > 0 || !line.startsWith('#') || line.startsWith('##')) return
    const columns = splitColumns(line)
    if (/^#CHROM$/i.test(columns[0] ?? '')) found = Math.max(0, columns.length - 9)
  })
  return found
}

/**
 * The attributes worth showing, in the order they are read.
 *
 * `REF>ALT` first, because it is the answer to the question a click asks. Then
 * the two columns a caller filled in and the two `INFO` keys almost every file
 * carries. Written as `key value` pairs so `FeatureDialog` splits them into
 * labelled rows rather than printing one run-on string — the convention its
 * `KEYED` regex already encodes.
 *
 * `FILTER` is carried whatever it says, `PASS` included. A lane that showed the
 * failures and hid the passes would be answering a question nobody asked, and a
 * reader who has filtered their own file wants to see that it is filtered.
 */
function detailOf(
  ref: string,
  alt: string,
  qual: string | undefined,
  filter: string | undefined,
  info: string,
): string {
  const parts: string[] = [`${ref}>${alt}`, `type ${variantClass(ref, alt)}`]
  if (qual !== undefined && qual !== '.' && qual !== '') parts.push(`QUAL ${qual}`)
  if (filter !== undefined && filter !== '.' && filter !== '') parts.push(`filter ${filter}`)
  const af = infoOf(info, 'AF')
  if (af !== undefined && af !== '') parts.push(`AF ${af}`)
  const dp = infoOf(info, 'DP')
  if (dp !== undefined && dp !== '') parts.push(`DP ${dp}`)
  const svtype = infoOf(info, 'SVTYPE')
  if (svtype !== undefined && svtype !== '') parts.push(`SVTYPE ${svtype}`)
  return parts.join(DETAIL_SEP)
}

/** Every line, blanks dropped and `#` lines *kept* — which is the whole point. */
function eachLine(text: string, visit: (line: string) => void): void {
  let index = 0
  const length = text.length
  while (index < length) {
    let end = text.indexOf('\n', index)
    if (end < 0) end = length
    let stop = end
    if (stop > index && text.charCodeAt(stop - 1) === 13) stop--
    const line = text.slice(index, stop)
    index = end + 1
    if (line !== '') visit(line)
  }
}

/** Tabs where the line has one, whitespace otherwise — `forEachRow`'s rule. */
function splitColumns(line: string): string[] {
  return line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/)
}

/**
 * The contigs a VCF header declares, with their lengths.
 *
 * `##contig=<ID=chrV,length=20000>` is a `chrom.sizes` written inside the file,
 * and it is **declared** rather than inferred — the same tier as a BAM's `@SQ`
 * table and a bigWig's header, and a tier above the "ends at its last feature"
 * lower bound a BED can offer. So a dropped VCF opens a browser session on its
 * own with exact lengths (§5.8), which no other text feature format can do.
 *
 * Empty for a file that declares none, which is legal and common — those fall
 * back to the lower bound every feature file gets.
 */
export function vcfContigs(text: string): Array<{ name: string; length: number }> {
  const out: Array<{ name: string; length: number }> = []
  eachLine(text, (line) => {
    if (!line.startsWith('##contig=<')) return
    const id = /[<,]ID=([^,>]+)/.exec(line)
    const length = /[<,]length=(\d+)/.exec(line)
    if (id === null || length === null) return
    out.push({ name: id[1], length: Number(length[1]) })
  })
  return out
}
