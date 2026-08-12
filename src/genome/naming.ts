/**
 * Chromosome names, reconciled across the conventions that write them.
 *
 * Two files of the same genome disagree about its names more often than they
 * agree. UCSC writes `chr1`, Ensembl writes `1`, a `.hic` off 4DN writes `1`,
 * a yeast cooler writes `chrI` and the `chrom.sizes` beside it writes `01`.
 * Every one of those is the first chromosome, and until now every one of them
 * was a different sequence to this viewer: a companion panel asked for `chr1`
 * against a file that calls it `1` got `unknown-label`, and a bigWig of the
 * same assembly drew nothing beside a map that had it under another spelling.
 *
 * So this module answers one question — *does this name, in this file, mean the
 * same sequence as that name, in that one* — and it answers it under three
 * constraints, which are what the rest of the file is for.
 *
 * **1. It never silently matches two different sequences.** A wrong match is
 * worse than no match: no match is a blank panel and a sentence saying why, and
 * a wrong one is somebody else's chromosome drawn under your label, which
 * nothing on screen would show. So every step below is a rule with a reason,
 * `length` vetoes rather than persuades, and a name whose shape this module does
 * not recognise is matched **by its spelling and not otherwise** — case folded,
 * with the `chr` prefix off if it had one, and nothing interpreted. That clause
 * is the load-bearing one for a metacool: assembler contigs (`NODE_1_length_…`,
 * `k141_9`, `tig00000001`) are opaque ids from independently assembled
 * organisms and two of them agree by coincidence (§8.5), so no numeral, no
 * accession and no organelle table is ever applied to one.
 *
 * **2. The decisions are made from the whole list, not one name at a time.**
 * `X` is the tenth chromosome of *S. cerevisiae* and the sex chromosome of
 * everything else, and the string cannot tell you which. The list can: a file
 * that also holds `IX` and `XI` is counting in Roman numerals and its `X` is
 * ten; a file whose Roman numerals stop at `V` — *C. elegans* is `I`…`V`, `X` —
 * is naming a sex chromosome. That is why the entry point is
 * {@link NameIndex.of}, over a whole file's sequences, rather than a
 * `canonicalise(name)` anybody could call on a string in isolation.
 *
 * **3. Length corroborates; it never matches.** Two sequences of equal length
 * are not the same sequence — a metagenome has thousands of equal-length
 * contigs — so no pair is ever matched *because* the lengths agree. The
 * implication runs the other way: where a name match is proposed and both
 * lengths are known and they differ, the match is reported as such
 * ({@link NameMatch.lengths}) so the caller can refuse it, warn about it, or —
 * for the navigation lock, which has its own tolerance for a short last bin
 * (§16.4) — decide for itself. hg19's `chrM` and hg38's `chrM` are the case
 * that matters: same name, different sequence, two bases apart.
 *
 * ## The ladder
 *
 * A match carries the {@link MatchTier} that reached it, ordered by how much
 * interpretation it took:
 *
 * | tier | example |
 * | --- | --- |
 * | `exact` | `chr1` = `chr1` |
 * | `case` | `Chr1` = `chr1` |
 * | `decorated` | `ref\|NC_001133\|` = `NC_001133` |
 * | `prefix` | `chr1` = `1` |
 * | `padded` | `01` = `1` |
 * | `roman` | `chrXII` = `12` |
 * | `organelle` | `chrM` = `MT` = `MtDNA` |
 * | `accession` | `NC_000001.11` = `chr1`; `chrUn_GL000220v1` = `GL000220.1` |
 * | `version` | `NC_000001.10` ≈ `NC_000001.11` |
 *
 * `version` is last and is the only tier that is *known* to be shaky: the same
 * locus at two assembly versions is two sequences, so it is offered and
 * flagged rather than taken.
 *
 * ## What is deliberately not equated
 *
 * - **A chromosome arm is not its chromosome.** *Drosophila*'s `2L` and `2R`
 *   are separate sequences and neither is `2`. The trailing letter stays in the
 *   key, which also keeps wheat's `1A`, `1B` and `1D` — three homoeologues, one
 *   number — apart from each other and from `1`.
 * - **A linkage group is not a chromosome number.** `LG1` keeps its `LG`,
 *   because a linkage map is numbered by linkage and an assembly by length, and
 *   the two orders agree only by luck.
 * - **`_random`, `_alt`, `_fix` and `_hapN` stay.** A patch is a different
 *   sequence from the chromosome it patches.
 * - **Genome and MAG names.** This module is about sequences. A metacool's
 *   genome layer is a list of independently assembled organisms and nothing
 *   about their names is a convention.
 */

/** One sequence, as any file reports one. `length` where the file knows it. */
export interface NamedSequence {
  name: string
  length?: number
}

/**
 * How a match was reached, weakest interpretation first.
 *
 * Ordered, and the order is used: {@link NameIndex.find} takes the strongest
 * available match, and where two of this file's names answer to one foreign
 * name the tier is what breaks the tie.
 */
export const MATCH_TIERS = [
  'exact',
  'case',
  'decorated',
  'prefix',
  'padded',
  'roman',
  'organelle',
  'accession',
  'version',
] as const

export type MatchTier = (typeof MATCH_TIERS)[number]

/** Whether the two sequences' lengths back the match up, where both are known. */
export type LengthVerdict = 'agree' | 'differ' | 'unknown'

/** One name, resolved against one file's list of sequences. */
export interface NameMatch {
  /** The name **as this file writes it** — what to hand a reader or a range. */
  name: string
  /** The name that was asked for, kept so a report can print both. */
  asked: string
  tier: MatchTier
  lengths: LengthVerdict
}

/**
 * The naming convention a whole list is written in.
 *
 * Reported rather than acted on — the matching below is per name and needs no
 * style — because it is the one sentence that makes a mismatch legible in the
 * info panel: *this file is UCSC, that one is Ensembl*.
 */
export type NameStyle =
  | 'ucsc'
  | 'ensembl'
  | 'roman'
  | 'accession'
  | 'assembly'
  | 'mixed'
  | 'empty'

// ---------------------------------------------------------------------------
// Decoration, prefixes and roles
// ---------------------------------------------------------------------------

/**
 * Database tags that appear in a pipe-delimited FASTA header and carry no
 * identity of their own.
 *
 * `gi|568336023|gb|CM000663.2|` is one sequence written by an NCBI tool of a
 * certain vintage, and the only part of it worth keeping is `CM000663.2`.
 */
const DB_TAGS = new Set([
  'gi',
  'gb',
  'ref',
  'emb',
  'dbj',
  'tpg',
  'tpe',
  'tpd',
  'lcl',
  'pir',
  'prf',
  'sp',
  'tr',
  'pdb',
  'ena',
  'bbs',
])

/**
 * Strip a name down to the token that identifies it.
 *
 * Three things come off, in this order, and each is a real thing found in real
 * files:
 *
 * - **everything after the first whitespace**, which is a FASTA description
 *   (`>chr1 AC:CM000663.2 LN:248956422`) and never part of the name — this is
 *   also what `samtools` and every reader of a `.fai` do;
 * - **pipe decoration**, reduced to the last token that is not a database tag
 *   and not the bare numeric id that follows `gi`;
 * - **a trailing comma or semicolon**, which is a `chrom.sizes` written by a
 *   spreadsheet.
 */
export function stripDecoration(raw: string): string {
  let text = raw.trim().split(/\s+/)[0] ?? ''
  text = text.replace(/[,;]+$/, '')
  if (text.includes('|')) {
    const parts = text.split('|').filter((part) => part !== '')
    const useful = parts.filter((part, at) => {
      if (DB_TAGS.has(part.toLowerCase())) return false
      // The number in `gi|568336023|…` is an identifier of the *record*, not of
      // the sequence, and it is the one all-digit token that must not survive.
      return !(/^[0-9]+$/.test(part) && at > 0 && parts[at - 1].toLowerCase() === 'gi')
    })
    if (useful.length > 0) text = useful[useful.length - 1]
  }
  return text
}

/**
 * Prefixes that say "this is a chromosome" and nothing else.
 *
 * `chr` is UCSC's; `chrom` and `chromosome` are what a hand-written
 * `chrom.sizes` and several assembly-report converters produce. Each may be
 * followed by one separator. Longest first, so `chromosome_1` does not lose
 * only its `chr` and keep `omosome_1`.
 */
const CHROM_PREFIX = /^(?:chromosome|chrom|chr)[ _.-]?/i

/**
 * The linkage-group prefix, which is a prefix and **not** a chromosome one.
 *
 * `LG1` and `LG01` are one sequence and want the same padding rule every other
 * number gets. `LG1` and `1` are not, and must not be: a linkage map is
 * numbered by linkage and an assembly by length, and the two orders agree only
 * by luck. So the prefix is recognised — enough to fold `LG1`, `LG_01` and
 * `lg1` together — and then kept in the key, in a namespace of its own.
 */
const GROUP_PREFIX = /^(?:lg|linkage_?group|group)[ _.-]?(?=[0-9])/i

/**
 * Suffixes that make a sequence a *different* sequence from the one it is
 * named after, and therefore stay in the key.
 *
 * `chr1_KI270706v1_random` is an unplaced fragment believed to belong to
 * chromosome 1; `chr6_GL000250v2_alt` is one of the MHC haplotypes. Neither is
 * chromosome 1 or 6, and equating them would draw a 175 kb scaffold under the
 * label of a 249 Mb chromosome.
 */
const ROLE_SUFFIX = /_(random|alt|fix|hap\d+|ctg\d+|maternal|paternal)$/i

/**
 * An INSDC accession as UCSC rewrites it into a name: `GL000220v1`.
 *
 * Bounded by a separator or an end rather than by `\b`, which does not exist
 * between `_` and `G` — `_` is a word character, so a word boundary never fires
 * inside `chrUn_GL000220v1`, which is the only place this pattern is ever
 * looked for.
 */
const UCSC_ACCESSION = /(?:^|[_.-])([A-Z]{2}[0-9]{5,6})v([0-9]+)(?:$|[_.-])/

/** RefSeq (`NC_000001`), INSDC (`CM000663`, `U00096`) and WGS master accessions. */
const REFSEQ_ACCESSION = /^(N[CGTWZ]|AC)_([0-9]{5,})$/i
/**
 * INSDC accessions, and the case sensitivity is the point.
 *
 * Accessions are upper case, always, and requiring that is what keeps an
 * assembler's `contig00001` — six letters and five digits, the same shape — out
 * of the accession namespace and safely opaque.
 */
const INSDC_ACCESSION = /^[A-Z]{1,6}[0-9]{5,8}$/

// ---------------------------------------------------------------------------
// Organelles, plasmids and sex chromosomes
// ---------------------------------------------------------------------------

/**
 * The organelle spellings worth knowing, and the reason there is a table at
 * all.
 *
 * Everything else in this module is a *rule* — strip a prefix, read a numeral,
 * drop a version. The organelles are the one place where the names are
 * genuinely arbitrary and no rule relates them: nothing derives `MtDNA` from
 * `chrM`, or `dmel_mitochondrion_genome` from `MT`. The table is small and
 * closed on purpose; it is spellings of three things, not a genome database.
 *
 * The four accessions are the reference organelle sequences a pipeline is
 * likeliest to have written instead of a name: the human rCRS, its GenBank
 * twin, the *S. cerevisiae* mitochondrion and the *A. thaliana* plastid.
 */
const ORGANELLES: Array<[key: string, spellings: string[]]> = [
  [
    'mito',
    [
      'm',
      'mt',
      'mtdna',
      'mito',
      'mitochondrion',
      'mitochondria',
      'mitochondrial',
      'mitochondrion_genome',
      'dmel_mitochondrion_genome',
      'mitochondrial_genome',
      'mitochondrion_dna',
      'chrmt',
      'nc_012920',
      'j01415',
      'nc_001224',
      'nc_005089',
    ],
  ],
  [
    'plastid',
    [
      'c',
      'pt',
      'cp',
      'chloroplast',
      'plastid',
      'chloroplast_genome',
      'chrc',
      'nc_000932',
    ],
  ],
  ['2micron', ['2-micron', '2micron', '2u', '2-micron_plasmid', 'nc_001398']],
]

/** Spelling → organelle key, built once. */
const ORGANELLE_OF = new Map<string, string>()
for (const [key, spellings] of ORGANELLES) {
  for (const spelling of spellings) ORGANELLE_OF.set(spelling, key)
}

/** The sex-chromosome letters, including the ZW system birds and moths use. */
const SEX_LETTERS = new Set(['x', 'y', 'z', 'w'])

// ---------------------------------------------------------------------------
// Roman numerals
// ---------------------------------------------------------------------------

/**
 * Roman numerals as chromosome names go — `I` to `XLVIII`, and no further.
 *
 * **`C`, `D` and `M` are excluded from the numeral system entirely**, which is
 * the whole reason this is a hand-rolled regex rather than a general Roman
 * parser. No genome has a hundredth chromosome, so a `C` in a chromosome list
 * is a chloroplast and an `M` is a mitochondrion — every time, in every file
 * this viewer will ever be shown. Reading them as 100 and 1000 would be
 * arithmetically correct and biologically absurd, and it would make `chrM` and
 * `chrMT` two different sequences.
 */
const ROMAN = /^(XL|L|X{0,3})(IX|IV|V?I{0,3})$/i

const ROMAN_TENS: Record<string, number> = { '': 0, x: 10, xx: 20, xxx: 30, xl: 40, l: 50 }
const ROMAN_UNITS: Record<string, number> = {
  '': 0,
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
}

/** The value of a chromosome-shaped Roman numeral, or `0` for anything else. */
export function romanValue(text: string): number {
  const match = ROMAN.exec(text)
  if (match === null) return 0
  const tens = ROMAN_TENS[match[1].toLowerCase()]
  const units = ROMAN_UNITS[match[2].toLowerCase()]
  if (tens === undefined || units === undefined) return 0
  return tens + units
}

// ---------------------------------------------------------------------------
// Accession tables
// ---------------------------------------------------------------------------

/**
 * RefSeq's chromosome accessions for the two assemblies that account for most
 * of the world's Hi-C, and the only per-species knowledge in this file.
 *
 * They are a range and not a list: NCBI assigned human chromosomes 1–22, X and
 * Y the consecutive block `NC_000001`–`NC_000024`, and mouse 1–19, X and Y the
 * block `NC_000067`–`NC_000087`. Both are stable across assembly versions —
 * only the `.N` suffix moves — so a file naming its sequences `NC_000001.11`
 * lines up with one naming them `chr1` by arithmetic rather than by table.
 *
 * Nothing else is hard-coded, and this is where the line is: two ranges buy the
 * overwhelming majority of accession-named files, and a real alias table for
 * every assembly is megabytes, needs a network, and would have to be told which
 * assembly a file is of — which is the question this module exists to avoid
 * asking.
 */
const REFSEQ_RANGES: Array<{ from: number; to: number; first: number; tail: string[] }> = [
  // Human: NC_000001–NC_000022 are 1–22, then X, then Y.
  { from: 1, to: 22, first: 1, tail: ['x', 'y'] },
  // Mouse: NC_000067–NC_000085 are 1–19, then X, then Y.
  { from: 67, to: 85, first: 1, tail: ['x', 'y'] },
]

/**
 * The chromosome an `NC_` accession names, as a canonical body, or `null`.
 *
 * `NC_000001` → `1`; `NC_000023` → `x`; `NC_000086` → `x` (mouse). Deliberately
 * one-way: `1` is not turned into an accession, because which accession depends
 * on the species and that is exactly what is not known here.
 */
function refseqChromosome(digits: number): string | null {
  for (const range of REFSEQ_RANGES) {
    if (digits >= range.from && digits <= range.to) {
      return String(range.first + (digits - range.from))
    }
    const after = digits - range.to - 1
    if (after >= 0 && after < range.tail.length) return range.tail[after]
  }
  return null
}

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

/** What a name was reduced to, and what it cost to get there. */
interface Canon {
  /**
   * The key two names must share to be the same sequence.
   *
   * Namespaced by kind — `num:12`, `sex:x`, `org:mito`, `acc:nc_000001`,
   * `raw:node_1` — so that a chromosome numbered 12 and a contig literally
   * called `num:12` cannot collide, and so that an opaque name can never key
   * into the same bucket as an interpreted one.
   */
  key: string
  /** The interpretations applied, for reporting which tier a match used. */
  via: MatchTier[]
  /** The accession's version, where the key dropped one. */
  version: string | null
  /** `true` when nothing about this name was interpreted — exact match only. */
  opaque: boolean
}

/**
 * The assembly-wide decisions a list makes on behalf of its own names.
 *
 * Carried rather than recomputed because it belongs to the list a name came
 * *from*, not to the one it is being looked up in: `X` out of a yeast file is
 * chromosome ten however the file it is being matched against numbers its own.
 */
export interface NameContext {
  /** `true` where `X` in this list is the tenth chromosome rather than the sex one. */
  xIsTen: boolean
  /** `true` where this list counts in Roman numerals at all. */
  roman: boolean
}

/**
 * Unambiguous Roman numerals — the ones that cannot be read as anything else.
 *
 * `I`, `V` and `X` are all three of a numeral, a letter and (for `X`) a sex
 * chromosome, so none of them is evidence of anything. `II`, `IV`, `IX`, `XII`
 * are evidence, and two of them settle it.
 */
function readsAsRoman(body: string): boolean {
  if (body.length < 2) return false
  if (SEX_LETTERS.has(body.toLowerCase())) return false
  return romanValue(body) > 0
}

/**
 * What a whole list decides about its own numerals, before any name is read.
 *
 * **The Roman question** is settled by two or more unambiguous numerals: one
 * `II` could be a contig, but `II` and `IV` together in a list of sixteen names
 * is *S. cerevisiae*.
 *
 * **The `X` question** is settled by its Roman neighbours, and this is the
 * sharpest rule in the module. A list holding `IX` or `XI` is counting past
 * nine in Roman, so its `X` is ten — sixteen yeast chromosomes, `I` to `XVI`.
 * A list whose numerals stop at `V` and then jumps to `X` is *C. elegans*:
 * `I`, `II`, `III`, `IV`, `V`, `X`, five autosomes and a sex chromosome, and
 * there is no chromosome ten to be confused with. The same test gets
 * *S. pombe* right (`I`, `II`, `III` and no `X` at all) and gets every numeric
 * assembly right by never reaching the question.
 */
export function contextOf(names: readonly string[]): NameContext {
  const bodies = names.map((name) => bodyOf(name))
  const evidence = bodies.filter((body) => readsAsRoman(body))
  const roman = evidence.length >= 2
  const has = (want: string): boolean => bodies.some((body) => body.toLowerCase() === want)
  return { roman, xIsTen: roman && (has('ix') || has('xi')) }
}

/** A name stripped of decoration, chromosome prefix and role suffix. */
function bodyOf(name: string): string {
  const bare = stripDecoration(name)
  const unprefixed = bare.replace(CHROM_PREFIX, '')
  // Never strip a prefix down to nothing: a bacterial replicon genuinely called
  // `chromosome` is its own name, and an empty key would collide with every
  // other file's empty key.
  const core = unprefixed === '' ? bare : unprefixed
  return core.replace(ROLE_SUFFIX, '')
}

/**
 * Reduce one name to the key that decides what it is.
 *
 * The order of the tests is the order of confidence, and each one that fires
 * ends the reduction. What falls through every test is opaque, keyed under its
 * own lowercased text, and can from then on only match something spelled the
 * same way — which is the guarantee the module header opens with.
 */
export function canonicalise(name: string, context: NameContext): Canon {
  const via: MatchTier[] = []
  const bare = stripDecoration(name)
  if (bare !== name.trim()) via.push('decorated')

  const unprefixed = bare.replace(CHROM_PREFIX, '')
  const prefixed = unprefixed !== bare && unprefixed !== ''
  const withRole = prefixed ? unprefixed : bare
  if (prefixed) via.push('prefix')

  const role = ROLE_SUFFIX.exec(withRole)
  const body = role === null ? withRole : withRole.slice(0, role.index)
  const tail = role === null ? '' : `+${role[1].toLowerCase()}`
  const lower = body.toLowerCase()

  // An accession UCSC has rewritten into a name — `chrUn_GL000220v1`,
  // `chr11_KI270733v1_random`. The accession is the identity; the chromosome
  // the name hangs it off and the role suffix are both commentary, and Ensembl
  // writes the same sequence as `GL000220.1` with neither.
  const rewritten = UCSC_ACCESSION.exec(withRole)
  if (rewritten !== null) {
    via.push('accession')
    return {
      key: `acc:${rewritten[1].toLowerCase()}`,
      via,
      version: rewritten[2],
      opaque: false,
    }
  }

  // The version comes off before anything else is recognised, because every
  // test below is about the accession and none of them is about which assembly
  // it came from. Kept, not discarded: two versions of one accession are the
  // same locus in two assemblies, which is a match worth offering and never
  // worth taking silently.
  const versioned = /^(.*?)\.([0-9]+)$/.exec(body)
  const unversioned = versioned === null ? body : versioned[1]
  const version = versioned === null ? null : versioned[2]

  // Organelles **first**, and this order is load-bearing: the reference
  // mitochondrial and plastid sequences are accessions (`NC_012920.1` is the
  // human rCRS) and the accession branch below would key them by their number
  // rather than as what they are, leaving `chrM` and `NC_012920.1` two
  // different sequences in the one case a table exists to prevent.
  const organelle = ORGANELLE_OF.get(lower) ?? ORGANELLE_OF.get(unversioned.toLowerCase())
  if (organelle !== undefined) {
    if (organelle !== lower) via.push('organelle')
    return { key: `org:${organelle}`, via, version, opaque: false }
  }

  const refseq = REFSEQ_ACCESSION.exec(unversioned)
  if (refseq !== null) {
    via.push('accession')
    const chromosome = refseqChromosome(Number(refseq[2]))
    // A RefSeq accession this module can name is keyed as the chromosome, so
    // `NC_000001.11` and `chr1` land in one bucket. One it cannot is still an
    // accession, and two files writing the same one still meet.
    if (chromosome !== null) {
      return {
        key: SEX_LETTERS.has(chromosome) ? `sex:${chromosome}${tail}` : `num:${chromosome}${tail}`,
        via,
        version,
        opaque: false,
      }
    }
    return { key: `acc:${unversioned.toLowerCase()}${tail}`, via, version, opaque: false }
  }

  if (INSDC_ACCESSION.test(unversioned)) {
    via.push('accession')
    return { key: `acc:${unversioned.toLowerCase()}${tail}`, via, version, opaque: false }
  }

  // A plain number, with its leading zeros gone. `01`, `1` and `chr1` are one
  // chromosome in every file that writes any of them.
  if (/^[0-9]+$/.test(body)) {
    if (/^0[0-9]/.test(body)) via.push('padded')
    return { key: `num:${Number(body)}${tail}`, via, version: null, opaque: false }
  }

  // A number with a letter welded to it: a *Drosophila* arm (`2L`), a wheat
  // homoeologue (`1A`), a rice pseudomolecule (`01g`). The letter stays. See
  // the module header — an arm is not its chromosome.
  const armed = /^([0-9]+)([a-z]{1,2})$/i.exec(body)
  if (armed !== null) {
    if (/^0[0-9]/.test(armed[1])) via.push('padded')
    return {
      key: `num:${Number(armed[1])}${armed[2].toLowerCase()}${tail}`,
      via,
      version: null,
      opaque: false,
    }
  }

  // A linkage group, folded on its number and kept out of the chromosomes'
  // namespace. See {@link GROUP_PREFIX}.
  const group = GROUP_PREFIX.exec(body)
  if (group !== null) {
    const digits = body.slice(group[0].length)
    if (/^[0-9]+$/.test(digits)) {
      if (/^0[0-9]/.test(digits)) via.push('padded')
      return { key: `lg:${Number(digits)}${tail}`, via, version: null, opaque: false }
    }
  }

  // The sex chromosomes, and the one place the whole list has already voted.
  if (SEX_LETTERS.has(lower) && !(lower === 'x' && context.xIsTen)) {
    return { key: `sex:${lower}${tail}`, via, version: null, opaque: false }
  }

  if (context.roman) {
    const value = romanValue(body)
    if (value > 0) {
      via.push('roman')
      return { key: `num:${value}${tail}`, via, version: null, opaque: false }
    }
  }

  // Everything else: an assembler's contig, a linkage group, a scaffold, a
  // plasmid nobody has named twice the same way. Case-folded and no more.
  return { key: `raw:${lower}${tail}`, via, version: null, opaque: true }
}

// ---------------------------------------------------------------------------
// One file's names, ready to be asked questions
// ---------------------------------------------------------------------------

/** Where a tier sits on the ladder; higher is more interpretation. */
function tierRank(tier: MatchTier): number {
  return MATCH_TIERS.indexOf(tier)
}

/**
 * The tier to report for a match between two canonical forms.
 *
 * The *most interpreted* step either side took to get to the shared key, which
 * is the honest thing to print: `chrI` against `1` is a `roman` match even
 * though the prefix came off first, because the numeral is the part a reader
 * would want to check.
 */
function tierOf(a: Canon, b: Canon): MatchTier {
  let best: MatchTier = 'case'
  for (const tier of [...a.via, ...b.via]) {
    if (tierRank(tier) > tierRank(best)) best = tier
  }
  return best
}

/** Whether two lengths are close enough to call the same sequence. */
function lengthsVerdict(a: number | undefined, b: number | undefined): LengthVerdict {
  if (a === undefined || b === undefined || a <= 0 || b <= 0) return 'unknown'
  return a === b ? 'agree' : 'differ'
}

/**
 * One file's sequences, indexed every way a foreign name might arrive.
 *
 * Built once per file and held for as long as the file is open: it is three
 * `Map`s over the contig table, which for the 154 k-contig metacool that sets
 * every other budget in this viewer is a few megabytes of strings that were
 * already in memory, and the alternative — canonicalising the whole list per
 * lookup — is a linear scan on every navigation.
 */
export class NameIndex {
  /** The file's names, in file order. */
  readonly names: readonly string[]
  readonly style: NameStyle
  /** What this file decided about its own numerals — see {@link NameContext}. */
  readonly context: NameContext
  private readonly exact = new Map<string, NamedSequence>()
  private readonly folded = new Map<string, NamedSequence[]>()
  private readonly keyed = new Map<string, Array<{ sequence: NamedSequence; canon: Canon }>>()

  private constructor(sequences: readonly NamedSequence[]) {
    this.names = sequences.map((sequence) => sequence.name)
    this.context = contextOf(this.names)
    this.style = styleOf(this.names, this.context)
    for (const sequence of sequences) {
      // First writer wins throughout. A file with two sequences of one name is
      // corrupt (`parseChromSizes` says so for a `chrom.sizes`), and the first
      // is the one every other index in this app resolves to.
      if (!this.exact.has(sequence.name)) this.exact.set(sequence.name, sequence)
      push(this.folded, sequence.name.toLowerCase(), sequence)
      const canon = canonicalise(sequence.name, this.context)
      push(this.keyed, canon.key, { sequence, canon })
    }
  }

  static of(sequences: readonly NamedSequence[]): NameIndex {
    return new NameIndex(sequences)
  }

  /** Build from names alone — a tabix index, a BED, a bigWig header. */
  static ofNames(names: readonly string[]): NameIndex {
    return new NameIndex(names.map((name) => ({ name })))
  }

  /** `true` when this file writes this exact name. */
  has(name: string): boolean {
    return this.exact.has(name)
  }

  /**
   * The name **this file** uses for a sequence another file calls `name`.
   *
   * The ladder in order: the same string, then the same string in another case,
   * then the canonical key. `length`, where the caller knows it, never finds a
   * match and only ever judges one — see the module header.
   *
   * `from` is the context of the list the name **came out of**, and passing it
   * is what makes an asymmetric pair work: `chrI` is chromosome one because the
   * file it came from counts in Roman numerals, and the file being searched —
   * which may number its own sequences `01` to `16` — has no way to know that.
   * Omitted, this file's own context stands in, which is the right reading for
   * a name somebody typed into the locus box.
   *
   * `null` where nothing answers, and where more than one thing answers
   * *ambiguously*: a file holding both `1` and `01` cannot say which one a
   * foreign `chr1` meant, and guessing would be the silent wrong match this
   * module exists to refuse.
   */
  find(name: string, options: { length?: number; from?: NameContext } = {}): NameMatch | null {
    const { length } = options
    const direct = this.exact.get(name)
    if (direct !== undefined) {
      return {
        name: direct.name,
        asked: name,
        tier: 'exact',
        lengths: lengthsVerdict(length, direct.length),
      }
    }

    const folded = this.folded.get(name.toLowerCase())
    if (folded !== undefined && folded.length === 1) {
      return {
        name: folded[0].name,
        asked: name,
        tier: 'case',
        lengths: lengthsVerdict(length, folded[0].length),
      }
    }

    const context = options.from ?? this.context
    const found = this.byKey(name, canonicalise(name, context), length)
    if (found !== null) return found

    // The numeral nobody declared. A name arrives with no context of its own —
    // typed into the locus box, or read off a BED that carries no list — and
    // `XII` is then a numeral this file has no reason to expect. It is also a
    // numeral that cannot be anything else, so it is tried a second time under
    // a Roman reading.
    //
    // **`X` is excluded, and that exclusion is the whole safety of this
    // retry.** `X` unqualified is the sex chromosome far more often than it is
    // ten, and the only thing that can say otherwise is the list it came from —
    // which is precisely what this path does not have. `L` goes with it: a
    // fiftieth chromosome is not a thing, so a bare `L` is a name.
    if (!context.roman) {
      const body = bodyOf(name).toLowerCase()
      if (body !== 'x' && body !== 'l' && romanValue(body) > 0) {
        return this.byKey(name, canonicalise(name, { roman: true, xIsTen: false }), length)
      }
    }
    return null
  }

  /** The canonical-key rung of {@link find}'s ladder. */
  private byKey(asked: string, canon: Canon, length?: number): NameMatch | null {
    // Every key is namespaced by kind, so an opaque name can only ever reach a
    // bucket of other opaque names — which is what makes "a name this module
    // does not recognise matches by its spelling, and not otherwise" true by
    // construction rather than by a guard that could be forgotten.
    const candidates = this.keyed.get(canon.key)
    if (candidates === undefined || candidates.length === 0) return null
    const chosen = pick(candidates, length)
    if (chosen === null) return null
    const tier = tierOf(canon, chosen.canon)
    const drifted =
      canon.version !== null &&
      chosen.canon.version !== null &&
      canon.version !== chosen.canon.version
    return {
      name: chosen.sequence.name,
      asked,
      tier: drifted && tierRank(tier) < tierRank('version') ? 'version' : tier,
      lengths: lengthsVerdict(length, chosen.sequence.length),
    }
  }
}

/**
 * Which of several sequences sharing a key a foreign name meant, or `null`.
 *
 * One candidate is the answer. More than one is a file that spells the same
 * chromosome two ways — `1` and `01` side by side — and the only thing that can
 * break the tie honestly is the length, because it is the only evidence that
 * comes from the sequence rather than from its spelling. Without a length, or
 * with two candidates of the same length, the answer is that there is no
 * answer.
 */
function pick<T extends { sequence: NamedSequence }>(candidates: T[], length?: number): T | null {
  if (candidates.length === 1) return candidates[0]
  if (length === undefined || length <= 0) return null
  const agreeing = candidates.filter((entry) => entry.sequence.length === length)
  return agreeing.length === 1 ? agreeing[0] : null
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const held = map.get(key)
  if (held === undefined) map.set(key, [value])
  else held.push(value)
}

/**
 * What convention a list is written in, for the one sentence an info panel
 * shows.
 *
 * Reported and never acted on. The tests are over the *whole* list and are
 * deliberately coarse: a handful of names decide, because a real assembly is a
 * couple of dozen chromosomes and several hundred unplaced scaffolds and it is
 * the chromosomes that carry the convention.
 */
export function styleOf(names: readonly string[], context = contextOf(names)): NameStyle {
  if (names.length === 0) return 'empty'
  let prefixed = 0
  let bare = 0
  let accession = 0
  let opaque = 0
  for (const name of names) {
    const canon = canonicalise(name, context)
    if (canon.opaque) {
      opaque++
      continue
    }
    // By what the name *is*, not by what it was keyed as: a RefSeq accession
    // this module can name resolves to `num:1`, and counting it as a bare
    // Ensembl-style number would report a file of accessions as an Ensembl one.
    if (canon.via.includes('accession')) accession++
    else if (CHROM_PREFIX.test(stripDecoration(name))) prefixed++
    else bare++
  }
  const named = prefixed + bare + accession
  if (named === 0 || opaque > named * 4) return 'assembly'
  if (context.roman && prefixed <= bare) return 'roman'
  if (accession > prefixed && accession > bare) return 'accession'
  if (prefixed > 0 && bare > 0) return 'mixed'
  if (prefixed > 0) return context.roman ? 'roman' : 'ucsc'
  return context.roman ? 'roman' : 'ensembl'
}

// ---------------------------------------------------------------------------
// Two files at once
// ---------------------------------------------------------------------------

/** What matching one file's sequences onto another's produced. */
export interface Alignment {
  /** Source name → the target's name for it. Only sequences that matched. */
  pairs: Map<string, NameMatch>
  /** Source names nothing in the target answered to. */
  unmatched: string[]
  /** Matches whose two lengths are known and disagree. */
  contested: NameMatch[]
  /** How many pairs needed more than an exact string match. */
  renamed: number
}

/**
 * Match every sequence of one file onto another file's list.
 *
 * **One to one, by construction.** A target sequence is claimed by at most one
 * source name, and the claim goes to the strongest tier — so a file holding
 * both `1` and `chr1` gives each of them to its own counterpart rather than
 * letting the second one overwrite the first. Two source names left fighting
 * over one target at the same tier is exactly the ambiguity {@link
 * NameIndex.find} refuses, and both lose.
 *
 * This is what the info panel reports and what {@link compareRefusal} asks
 * before refusing two files for having different chromosome lists (§16.4).
 */
export function alignNames(
  from: readonly NamedSequence[],
  to: readonly NamedSequence[],
): Alignment {
  const index = NameIndex.of(to)
  // The source list gets an index of its own for one field of it: the context.
  // See {@link NameIndex.find} — a Roman numeral is Roman because of the list it
  // came out of, and this is the only place both lists are in one hand.
  const from_ = NameIndex.of(from).context
  const proposals: Array<{ source: NamedSequence; match: NameMatch }> = []
  for (const source of from) {
    const match = index.find(source.name, { length: source.length, from: from_ })
    if (match !== null) proposals.push({ source, match })
  }
  // Strongest tier first, so the exact matches take their targets before an
  // interpreted one can. Ties keep file order, which is what makes this stable.
  proposals.sort((a, b) => tierRank(a.match.tier) - tierRank(b.match.tier))

  const claimed = new Map<string, { source: string; tier: MatchTier }>()
  const contestedTargets = new Set<string>()
  for (const proposal of proposals) {
    const held = claimed.get(proposal.match.name)
    if (held === undefined) {
      claimed.set(proposal.match.name, {
        source: proposal.source.name,
        tier: proposal.match.tier,
      })
    } else if (held.tier === proposal.match.tier) {
      // Two names of the same file, equally entitled to one target. Neither
      // wins: this is a genuinely ambiguous list and a guess here is the wrong
      // chromosome drawn under the right label.
      contestedTargets.add(proposal.match.name)
    }
  }

  const pairs = new Map<string, NameMatch>()
  const contested: NameMatch[] = []
  let renamed = 0
  for (const proposal of proposals) {
    const winner = claimed.get(proposal.match.name)
    if (winner === undefined || winner.source !== proposal.source.name) continue
    if (contestedTargets.has(proposal.match.name)) continue
    pairs.set(proposal.source.name, proposal.match)
    if (proposal.match.tier !== 'exact') renamed++
    if (proposal.match.lengths === 'differ') contested.push(proposal.match)
  }
  const unmatched = from
    .map((sequence) => sequence.name)
    .filter((name) => !pairs.has(name))
  return { pairs, unmatched, contested, renamed }
}

/** One list of names, rewritten into another list's spelling. */
export interface Renaming {
  /** The source list, in its own order, each name replaced where there was one. */
  names: string[]
  /** Target's spelling → the source's own, for querying the source under it. */
  sourceOf: Map<string, string>
  /** How many names the rewrite changed. */
  renamed: number
  /**
   * Renames whose two sequences are known to be different lengths.
   *
   * Carried out rather than suppressed. A track and a map that spell one
   * chromosome differently *and* size it differently are probably two assembly
   * versions — hg19 against hg38 — and that is a thing to tell a reader, not a
   * thing to decide for them: the coordinates still mean something, they just
   * do not mean quite the same thing.
   */
  contested: NameMatch[]
}

/**
 * Put one file's sequence names into another file's vocabulary.
 *
 * This is how a **track** joins a map, and doing it once at load is what keeps
 * the rest of the annotation path unchanged: a bigWig of `chr1` dropped on a
 * cooler of `1` has its contig list rewritten to the map's spelling the moment
 * it is read, so every lookup after that — the overlap report, the lane's
 * window, the feature search, the export — is a lookup by the map's own name
 * and has never heard of a convention.
 *
 * {@link Renaming.sourceOf} is the way back, for the one reader that cannot be
 * rewritten: a bigWig is a file on a disk and its `refName`s are whatever it
 * says they are, so a query has to be translated on the way out.
 *
 * Names with no counterpart are **kept as they are**. A track of a different
 * assembly is not renamed into agreement with the map, and the overlap report
 * that follows still says so — that report is the thing this must not silence
 * (§8.2).
 */
export function renameInto(
  source: readonly NamedSequence[],
  target: readonly NamedSequence[],
): Renaming {
  const alignment = alignNames(source, target)
  const sourceOf = new Map<string, string>()
  const names = source.map((sequence) => {
    const match = alignment.pairs.get(sequence.name)
    if (match === undefined) return sequence.name
    sourceOf.set(match.name, sequence.name)
    return match.name
  })
  return { names, sourceOf, renamed: alignment.renamed, contested: alignment.contested }
}

/** {@link NamedSequence}s from a bare list of names, for a source with no lengths. */
export function sequencesOf(names: readonly string[]): NamedSequence[] {
  return names.map((name) => ({ name }))
}

/**
 * How a match reads in a sentence, for the info panel and the panel's own bar.
 *
 * Every tier gets its own words rather than a generic "matched loosely",
 * because the whole point of carrying the tier is that a reader can decide
 * whether to believe it — and "the `chr` prefix" and "the accession's version"
 * warrant very different amounts of belief.
 */
export function describeTier(tier: MatchTier): string {
  switch (tier) {
    case 'exact':
      return 'the same name'
    case 'case':
      return 'the same name, in another case'
    case 'decorated':
      return 'the same accession, undecorated'
    case 'prefix':
      return 'the chr prefix'
    case 'padded':
      return 'leading zeros'
    case 'roman':
      return 'Roman numerals'
    case 'organelle':
      return 'an organelle spelled another way'
    case 'accession':
      return 'the accession'
    case 'version':
      return 'the same accession at another version'
  }
}
