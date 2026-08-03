/**
 * Layout detection and the acceptance gates (spec §3.1, §3.2).
 *
 * Everything here reads *attributes and group names only* — no dataset is
 * touched — so a file is classified and accepted or refused before a single
 * byte of table data is fetched. That is what keeps a remote open inside the
 * §12 request budget even when the answer is "no".
 */

import { COOLER_FORMAT, INT_ATTR_NULL_SENTINELS, METACOOLER_FORMAT, METACOOLER_FORMAT_VERSION, MMETACOOLER_FORMAT, REQUIRED_ORDERING, STORAGE_MODES, type StorageMode } from '../constants'
import { MetaCoolerFormatError, ViewerError } from '../errors'
import { pyInt, pyList, pyRepr } from '../format'
import type { AttrValue, Hdf5Handle } from '../h5/api'
import type { Info, Layout } from '../types'
import { parseUri } from '../uri'

/** Groups a `.metacool` must carry, per `schema.is_metacooler`. */
const METACOOL_GROUPS = ['genomes', 'contigs', 'bins', 'pixels', 'indexes'] as const

/** Attribute keys `MetaCooler.info` casts to plain integers. */
const INFO_INT_KEYS = [
  'bin-size',
  'format-version',
  'nbins',
  'nnz',
  'sum',
  'ngenomes',
  'ncontigs',
] as const

// ---------------------------------------------------------------------------
// Attribute reading
// ---------------------------------------------------------------------------

/** Read an attribute as a string, or `null` when it is absent or not one. */
function strAttr(attrs: Record<string, AttrValue>, key: string): string | null {
  const value = attrs[key]
  return typeof value === 'string' ? value : null
}

/**
 * A verbatim port of `metacooler.schema._int_attr` (correction #3).
 *
 * The idiomatic JS spelling — `Number(attrs[key]) || null` — accepts a
 * variable-bin file, because `Number('null')` is `NaN` and `'null'` is truthy.
 * metacooler omits `bin-size` entirely for variable bins, but a file that has
 * been through cooler can carry the literal *string* `"null"`, and that string
 * is the single thing standing between this viewer and a coordinate model
 * (§3.3) whose every formula would be wrong.
 *
 * So the rules are Python's, in Python's order:
 * - absent → `null`
 * - a string in `{'', 'null', 'none', 'nan'}` after trim + lowercase → `null`
 * - any other string → `int(value)`, throwing if it is not an integer literal
 * - a boolean → **throw** (in Python `bool` is an `int` subclass, and
 *   `bin-size = True` must not silently mean 1)
 * - an integer, or a float with no fractional part → the number
 * - anything else → throw
 *
 * @throws MetaCoolerFormatError when the attribute is present but not integral.
 */
export function intAttr(attrs: Record<string, AttrValue>, key: string): number | null {
  const value = attrs[key]
  if (value === undefined || value === null) return null
  const reject = (): never => {
    throw new MetaCoolerFormatError(
      `attrs[${pyRepr(key)}] must be an integer, got ${pyRepr(value)}`,
      { key, value },
    )
  }
  if (typeof value === 'string') {
    if ((INT_ATTR_NULL_SENTINELS as readonly string[]).includes(value.trim().toLowerCase())) {
      return null
    }
    const parsed = pyInt(value)
    return parsed === null ? reject() : parsed
  }
  // Before the number branch, exactly as in Python: `isinstance(True, int)`.
  if (typeof value === 'boolean') return reject()
  if (typeof value === 'number') {
    // JS has one numeric type, so this single test covers Python's `int`
    // branch and its `float(...).is_integer()` branch at once. NaN and
    // Infinity are not integers and land in `reject`, as they do in Python.
    return Number.isInteger(value) ? value : reject()
  }
  return reject()
}

/**
 * Resolve `storage-mode` from the attribute (spec §3.2: read, never assumed).
 *
 * An absent attribute falls back to `symmetric-upper`: both metacooler and
 * cooler write it, so absence means a writer old enough to predate the
 * attribute, and every such writer stored the upper triangle. A *present* but
 * unrecognised value is refused rather than guessed at, because guessing wrong
 * either doubles the diagonal or blanks half of every panel.
 */
export function resolveStorageMode(attrs: Record<string, AttrValue>): StorageMode {
  const value = attrs['storage-mode']
  if (value === undefined || value === null) return 'symmetric-upper'
  if (typeof value === 'string' && (STORAGE_MODES as readonly string[]).includes(value)) {
    return value as StorageMode
  }
  throw new MetaCoolerFormatError(
    `attrs['storage-mode'] must be one of ${pyList([...STORAGE_MODES].sort())}, got ${pyRepr(value)}`,
    { 'storage-mode': value },
  )
}

// ---------------------------------------------------------------------------
// Detection (spec §3.1)
// ---------------------------------------------------------------------------

/** Bare entry names of an `.mmetacool`, in file order (`schema.list_entry_names`). */
export function listEntryNames(h: Hdf5Handle): string[] {
  return h.has('entries') ? h.keys('entries') : []
}

/**
 * Classify an open handle, **in the spec's order**.
 *
 * The order is the whole point. A `.metacool` also satisfies cooler's
 * `is_cooler()` — it writes `format = "HDF5::Cooler"` and soft-links
 * `/chroms → /contigs` precisely so that it does — so testing for cooler first
 * would silently downgrade every metacool to a contig-only view with no
 * genomes and no error to explain why.
 *
 * @throws ViewerError `not-a-cooler` when nothing matches.
 */
export function detectLayout(h: Hdf5Handle, rootAttrs?: Record<string, AttrValue>): Layout {
  const attrs = rootAttrs ?? h.attrs()
  const format = strAttr(attrs, 'format')

  if (format === MMETACOOLER_FORMAT && h.has('entries')) {
    return { kind: 'mmetacool', group: h.group, entries: listEntryNames(h) }
  }
  if (strAttr(attrs, 'metacooler-format') === METACOOLER_FORMAT) {
    const missing = METACOOL_GROUPS.filter((group) => !h.has(group))
    if (missing.length === 0) return { kind: 'metacool', group: h.group }
    // A file that *claims* to be a metacool but has lost a group is refused,
    // never reclassified. It would otherwise fall through to the cooler branch
    // below and open as a contig-only view with its genomes silently gone —
    // which is not hypothetical: `cooler zoomify` on a metacool copies the
    // chroms, the indexes and every root attribute into `/resolutions/<base>`
    // and drops `/genomes`, producing exactly this file.
    throw new ViewerError(
      'not-a-cooler',
      `${h.uri} declares metacooler-format ${pyRepr(METACOOLER_FORMAT)} but is missing ` +
        `${pyList(missing.map((group) => `/${group}`))}. It cannot be read as a metacool, and ` +
        `reading it as the plain cooler it also is would drop the genome layer it says it has. ` +
        `If this came out of \`cooler zoomify\`, re-derive the resolutions with ` +
        `\`metacooler zoomify\` instead.`,
      { missing: [...missing] },
    )
  }
  // On the group's *contents*, not its mere existence: a cooler that happens to
  // carry a dataset called `resolutions` is a cooler, and classifying it as a
  // ladder would refuse it while naming no resolution to open.
  const resolutions = h.keys('resolutions')
  if (resolutions.length > 0) {
    return { kind: 'mcool', group: h.group, entries: orderEntries(resolutions) }
  }
  if (format === COOLER_FORMAT) {
    return { kind: 'cool', group: h.group }
  }

  throw new ViewerError(
    'not-a-cooler',
    `${h.uri} is HDF5 but not a cooler or metacool file: its 'format' attribute is ` +
      `${pyRepr(format)} and 'metacooler-format' is ${pyRepr(strAttr(attrs, 'metacooler-format'))}. ` +
      `Top-level keys: ${pyList(h.keys('').slice(0, 20))}. ` +
      `Convert a plain cooler with \`metacooler create cool\`.`,
    { format, group: h.group },
  )
}

/**
 * Refuse an `.mmetacool` opened at its root, mirroring the Python `KeyError`.
 *
 * A collection is not itself a cooler (§3.4), so there is nothing to show; the
 * fix is a group path, and the message hands the user a working one.
 *
 * @throws ViewerError `mmetacool-root` always — this function never returns.
 */
export function refuseMMetacoolRoot(h: Hdf5Handle): never {
  const { path } = parseUri(h.uri)
  const entries = listEntryNames(h)
  const paths = entries.map((name) => `/entries/${name}`)
  const example = paths.length > 0 ? paths[0] : '/entries/<name>'
  throw new ViewerError(
    'mmetacool-root',
    `No metacool entry at root of ${path}. Metacool entries found: ${pyList(paths)}. ` +
      `Use '::' to specify a group path, e.g. ${path}::${example}.`,
    { path, entries },
  )
}

/**
 * An `.mcool` addressed at its root: name the resolutions and how to pick one.
 *
 * The mirror of {@link refuseMMetacoolRoot}, and the same shape of answer — a
 * collection is not a map — but the group is `resolutions`, not `entries`, and
 * the names are bin sizes, so the app can open the finest one on the user's
 * behalf instead of making them retype a URI.
 */
/**
 * Put entry names in the order a human expects.
 *
 * HDF5 lists group members lexicographically, which puts `10000` before `5000`
 * and `1000` before `500`. When every name is an integer the names *are* bin
 * sizes — a resolution ladder — and their numeric order is the meaningful one.
 * Anything else is a sample collection with no order to exploit, and keeps the
 * file's own.
 */
export function orderEntries(names: string[]): string[] {
  const allIntegers = names.length > 0 && names.every((name) => /^\d+$/.test(name) && Number(name) > 0)
  return allIntegers ? [...names].sort((a, b) => Number(a) - Number(b)) : names
}

export function refuseMcoolRoot(h: Hdf5Handle, entries: string[]): never {
  const { path } = parseUri(h.uri)
  const paths = entries.map((name) => `/resolutions/${name}`)
  const example = paths.length > 0 ? paths[0] : '/resolutions/<binsize>'
  throw new ViewerError(
    'mcool-root',
    `No cooler at root of ${path}: an .mcool is a collection of resolutions, each a complete ` +
      `cooler. Resolutions found: ${pyList(paths)}. Use '::' to pick one, e.g. ` +
      `${path}::${example}.`,
    { path, entries, group: 'resolutions' },
  )
}

// ---------------------------------------------------------------------------
// Acceptance gates (spec §3.2, §10)
// ---------------------------------------------------------------------------

/**
 * Apply every §3.2 gate, each refusal naming the file's **actual** value.
 *
 * Order is cheapest-and-most-fundamental first: a collection cannot be a map
 * at all, a wrong format version means none of the other attributes are
 * trustworthy, and only then do ordering and bin geometry matter.
 *
 * `contig-ordering` and the format version are metacool-only concepts; a plain
 * cool/mcool carries neither and is gated on bin geometry alone (§9).
 *
 * @throws ViewerError one of `mmetacool-root`, `bad-format-version`,
 *   `bad-ordering`, `variable-bins`, or a `MetaCoolerFormatError` for an
 *   unreadable `bin-size` or `storage-mode`.
 */
export function assertAcceptable(
  h: Hdf5Handle,
  layout: Layout,
  rootAttrs?: Record<string, AttrValue>,
): void {
  if (layout.kind === 'mmetacool') refuseMMetacoolRoot(h)
  // Before the bin-geometry gate, not after: an mcool root carries only
  // `format` and `format-version`, so the fixed-bin check would refuse it as a
  // variable-bin file and tell the user to run `metacooler binnify` on a file
  // that is already binned four ways. What it needs is a resolution.
  if (layout.kind === 'mcool') refuseMcoolRoot(h, layout.entries ?? [])
  const attrs = rootAttrs ?? h.attrs()

  if (layout.kind === 'metacool') {
    // Absent is tolerated, matching `schema.validate`, which only compares the
    // version when the writer wrote one. A *present* mismatch is fatal.
    const version = intAttr(attrs, 'metacooler-format-version')
    if (version !== null && version !== METACOOLER_FORMAT_VERSION) {
      throw new ViewerError(
        'bad-format-version',
        `This file declares metacooler-format-version ${version}; the viewer only ` +
          `understands version ${METACOOLER_FORMAT_VERSION}. Re-create it with a matching ` +
          `metacooler release, or open it with the version of the viewer that reads ${version}.`,
        { found: version, expected: METACOOLER_FORMAT_VERSION },
      )
    }

    const ordering = strAttr(attrs, 'contig-ordering')
    if (ordering !== REQUIRED_ORDERING) {
      throw new ViewerError(
        'bad-ordering',
        `This file's contig-ordering is ${pyRepr(ordering)}; the viewer requires ` +
          `${pyRepr(REQUIRED_ORDERING)}. Only a genome-grouped layout puts every genome in one ` +
          `contiguous block of bins, which is what makes a genome or a genome pair a single ` +
          `bounded read. Re-create the file with ` +
          `\`metacooler create pairs --contig-order ${REQUIRED_ORDERING}\`.`,
        { found: ordering, expected: REQUIRED_ORDERING },
      )
    }
  }

  // `intAttr` is the gate, not `Number()` — see its doc comment.
  const binType = strAttr(attrs, 'bin-type')
  const binSize = intAttr(attrs, 'bin-size')
  if (binType === 'variable' || binSize === null || binSize <= 0) {
    throw new ViewerError(
      'variable-bins',
      `The viewer supports fixed-bin files only; this file's bin-type is ` +
        `${pyRepr(binType)} and its bin-size is ${pyRepr(binSize)}. Fragment-level and ` +
        `contig-level metacools are variable-bin by construction. Produce a fixed-bin file ` +
        `with \`metacooler binnify --binsize <bp>\` and open that.`,
      { 'bin-type': binType, 'bin-size': binSize },
    )
  }

  resolveStorageMode(attrs)
}

// ---------------------------------------------------------------------------
// info / metadata normalisation (mirrors `MetaCooler.info`, api.py:256)
// ---------------------------------------------------------------------------

/**
 * Decode one attribute the way `cooler.api.info` does: every *string* is run
 * through a JSON parse and replaced when it succeeds.
 *
 * That is how the `metadata` attribute becomes a dict — and also why a
 * `bin-size` of `"null"` reads back as `None` from `MetaCooler.info` while
 * still being a string on disk. The acceptance gates therefore read raw
 * attributes through {@link intAttr} and never go through here.
 */
function decodeAttr(value: AttrValue): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

/** Python's `int(x)` under a suppressed `ValueError`/`TypeError`: cast or keep. */
function looseInt(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : value
  if (typeof value === 'string') {
    const parsed = pyInt(value)
    return parsed === null ? value : parsed
  }
  return value
}

/** Narrow to `number | null` for the typed numeric fields of {@link Info}. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Narrow to `string | null` for the typed string fields of {@link Info}. */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Normalise root attributes into {@link Info}, mirroring `MetaCooler.info`.
 *
 * The renames are metacooler's, not cooler's: `metacooler-format` → `format`
 * (so `info.format` is the *metacooler* identity, not `HDF5::Cooler`),
 * `contig-ordering` → `ordering`, `nchroms` → `ncontigs`. `metadata` is
 * removed — it has its own accessor. Unrecognised attributes pass through
 * untouched, which is what lets the UI render whatever a creator wrote.
 *
 * The `assembly` fallback is undocumented but real (correction #8): the file
 * stores cooler's `genome-assembly`, and older metacooler releases wrote
 * `assembly-name` instead, so the legacy key is consulted only when the
 * primary is absent, empty, or the literal `'unknown'`.
 */
export function normaliseInfo(attrs: Record<string, AttrValue>): Info {
  const base: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attrs)) base[key] = decodeAttr(value)

  const take = (key: string): unknown => {
    const value = base[key]
    delete base[key]
    return value
  }

  // One decision, not three: whose identity is this file reporting? A metacool
  // reports the `metacooler-*` triple verbatim — including `null` where the
  // writer omitted a member, as `MetaCooler.info` does — and a plain cooler
  // reports cooler's, so the info panel is not told it has no format at all.
  // Resolving each member separately would stamp a metacool that omitted its
  // version with *cooler's* version 3, a value the `bad-format-version` gate
  // exists to refuse.
  const mcFormat = take('metacooler-format')
  const mcUrl = take('metacooler-format-url')
  const mcVersion = take('metacooler-format-version')
  const isMetacool = mcFormat !== undefined && mcFormat !== null
  const format = isMetacool ? mcFormat : base['format']
  const formatUrl = isMetacool ? mcUrl : base['format-url']
  const formatVersion = isMetacool ? mcVersion : base['format-version']
  const ordering = take('contig-ordering')
  const ncontigs = take('nchroms')

  // Python evaluates `base.pop("assembly", None)` as the *default* of the
  // outer pop, so `assembly` is always removed and `genome-assembly` wins.
  const legacy = take('assembly-name')
  const plain = take('assembly')
  const primary = take('genome-assembly')
  let assembly = primary !== undefined ? primary : plain
  if ((assembly === undefined || assembly === null || assembly === '' || assembly === 'unknown') && legacy !== undefined && legacy !== null) {
    assembly = legacy
  }

  take('metadata')

  const casts: Record<string, unknown> = {
    'bin-size': base['bin-size'],
    'format-version': formatVersion,
    nbins: base['nbins'],
    nnz: base['nnz'],
    sum: base['sum'],
    ngenomes: base['ngenomes'],
    ncontigs,
  }
  for (const key of INFO_INT_KEYS) {
    if (casts[key] !== undefined) casts[key] = looseInt(casts[key])
  }

  // The spread comes first so every explicit key below wins over the raw
  // attribute of the same name; unrecognised attributes survive untouched.
  return {
    ...base,
    format: stringOrNull(format),
    'format-url': stringOrNull(formatUrl),
    'format-version': numberOrNull(casts['format-version']),
    'bin-size': numberOrNull(casts['bin-size']),
    'bin-type': stringOrNull(base['bin-type']),
    ordering: stringOrNull(ordering),
    assembly: stringOrNull(assembly),
    'storage-mode': resolveStorageMode(attrs),
    nbins: numberOrNull(casts['nbins']),
    nnz: numberOrNull(casts['nnz']),
    sum: numberOrNull(casts['sum']),
    ngenomes: numberOrNull(casts['ngenomes']),
    ncontigs: numberOrNull(casts['ncontigs']),
  }
}

/**
 * The optional `metadata` attribute as an object, mirroring
 * `MetaCooler.metadata`: anything that is not a JSON object reads as `{}`.
 */
export function extractMetadata(attrs: Record<string, AttrValue>): Record<string, unknown> {
  const decoded = decodeAttr(attrs['metadata'])
  if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) {
    return decoded as Record<string, unknown>
  }
  return {}
}
