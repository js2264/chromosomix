/**
 * Layout detection and the acceptance gates (spec §3.1, §3.2).
 *
 * Everything here reads *attributes and group names only* — no dataset is
 * touched — so a file is classified and accepted or refused before a single
 * byte of table data is fetched. That is what keeps a remote open inside the
 * §12 request budget even when the answer is "no".
 */

import { CELLS_GROUP, CELL_GROUPS, COOLER_FORMAT, INT_ATTR_NULL_SENTINELS, METACOOLER_FORMAT, METACOOLER_FORMAT_VERSION, MMETACOOLER_FORMAT, REQUIRED_ORDERING, SCOOL_FORMAT, SCOOL_FORMAT_VERSION, STORAGE_MODES, type StorageMode } from '../constants'
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
 * Is this group a cooler in its own right?
 *
 * Group names and one attribute block, so it is answerable inside §3.1's rule
 * that nothing is classified by reading a dataset. It is asked of *candidate*
 * children when a file has no cooler at its own root, which is the only shape
 * a flat `.scool` can be told apart by — that layout writes `HDF5::Cooler` at
 * the root and puts the cells beside each other underneath it, so the root
 * attribute says nothing and the children say everything.
 */
function isCellGroup(h: Hdf5Handle, path: string): boolean {
  if (CELL_GROUPS.some((group) => !h.has(`${path}/${group}`))) return false
  return strAttr(h.attrsAt(path), 'format') === COOLER_FORMAT
}

/**
 * Is this file about to be asked for a cell listing, judged **without** taking
 * one?
 *
 * The gate in §12 exists because listing a container's cells is the one open in
 * this application that is not a bounded read, and it can only be *avoided* if
 * it can be foreseen. Foreseeing it is what this answers, from link lookups and
 * one attribute block — never a listing, which would be the cost itself.
 *
 * Two shapes reach it:
 *
 * - a **standard** container says so outright, on its root `format`. Cheap, and
 *   certain.
 * - a **flat** one says nothing, and cannot be told from anything else by name.
 *   But it can be told by elimination: it is HDF5, it is not a cooler (no
 *   `/bins`, `/pixels` or `/indexes` of its own), not an mcool (`/resolutions`),
 *   not an mmetacool (`/entries`), not a metacool. Every one of those is a
 *   single link lookup. What is left, if this viewer can open it at all, is a
 *   container whose children are the cells — so the listing is coming.
 *
 * The elimination is narrowed by one more test than it strictly needs: the root
 * `format` must be cooler's or absent. Without it, *any* HDF5 file this viewer
 * cannot open — an `.h5ad`, a `.loom`, someone's analysis output — matched the
 * shape "not a cooler and not a collection" and was met with a dialog about
 * single-cell containers before the plain `not-a-cooler` message it deserves.
 * The cost of the extra test is a flat container whose writer declared some
 * third format string, which pays the listing ungated; no such writer is known,
 * and both that produced the files this was measured on write cooler's.
 */
export function willListCells(h: Hdf5Handle, attrs: Record<string, AttrValue>): boolean {
  if (strAttr(attrs, 'format') === SCOOL_FORMAT) return h.has(CELLS_GROUP)
  if (strAttr(attrs, 'metacooler-format') === METACOOLER_FORMAT) return false
  const format = strAttr(attrs, 'format')
  if (format !== null && format !== COOLER_FORMAT) return false
  if (CELL_GROUPS.some((group) => h.has(group)) || h.has('chroms')) return false
  return !h.has('resolutions') && !h.has('entries')
}

/**
 * The cells of an `.scool`, in the two layouts that exist, or `null` for
 * neither.
 *
 * **Standard** (`cooler.create_scool`, and what the format paper describes):
 * `format = "HDF5::SCOOL"` at the root, one cooler per cell under `/cells`,
 * and `/chroms` and `/bins` hard-linked into every one of them from the root.
 *
 * **Flat** (HiCMatrix, scHiCExplorer, and every `.scool` written before cooler
 * 0.8.11 standardised the layout): the cells are the root's own children, each
 * a complete self-contained cooler with its own copy of the two tables, and the
 * root carries a bare `HDF5::Cooler` provenance block with no `ncells`, no
 * `bin-size` and no tables of its own.
 *
 * `ncells` is not consulted even where it exists. It is a *count*, and what a
 * reader needs is the names — the count cannot name a cell, cannot be ticked,
 * and on the flat layout is simply not written. The one listing answers both.
 *
 * Only the **first** child is examined for the flat case. A file whose first
 * group is a cooler and whose hundredth is not is malformed in a way this
 * detection cannot see, and paying a listing per child to find out would put
 * the whole file's metadata on the wire to answer a question about its shape.
 */
function scoolCells(
  h: Hdf5Handle,
  attrs: Record<string, AttrValue>,
): { names: string[]; group: string } | null {
  if (strAttr(attrs, 'format') === SCOOL_FORMAT) {
    const cells = h.keys(CELLS_GROUP)
    if (cells.length > 0) return { names: cells, group: CELLS_GROUP }
    // The attribute is a claim, and a claim with no cells behind it is refused
    // rather than fallen through: the fall-through lands on the cooler branch,
    // which would then refuse it for having no `/bins` — an error about a group
    // the reader was never going to find, for a file that told it where to look.
    throw new ViewerError(
      'not-a-cooler',
      `${h.uri} declares format ${pyRepr(SCOOL_FORMAT)} but has no cells under /${CELLS_GROUP}. ` +
        `Top-level keys: ${pyList(h.keys('').slice(0, 20))}.`,
      { format: SCOOL_FORMAT, group: h.group },
    )
  }
  // A file that is itself a cooler is one, whatever its children look like.
  if (CELL_GROUPS.some((group) => h.has(group))) return null
  const children = h.keys('')
  if (children.length === 0) return null
  return isCellGroup(h, children[0]) ? { names: children, group: '' } : null
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
  // Before the cooler branch, and that ordering is the whole of the flat
  // layout's detection: such a file declares `HDF5::Cooler` at its root and
  // would be classified as a cooler here, then refused for having no `/bins` —
  // naming a missing group rather than the several thousand cells it has.
  const cells = scoolCells(h, attrs)
  if (cells !== null) {
    return { kind: 'scool', group: h.group, entries: cells.names, cellGroup: cells.group }
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

/**
 * The group path of one cell, relative to the file's root.
 *
 * `cells/<name>` in the standard layout and a bare `<name>` in the flat one —
 * the single difference between the two that anything above this file has to
 * know, which is why it is joined here and nowhere else.
 */
export function cellPath(layout: Layout, name: string): string {
  const group = layout.cellGroup ?? ''
  return group === '' ? name : `${group}/${name}`
}

/**
 * The attributes that describe an scool's *geometry*, and where they came from.
 *
 * A standard `.scool` carries `bin-size`, `bin-type` and `nbins` on its root,
 * because it has a `/bins` of its own for them to describe. A flat one carries
 * nothing but provenance there — its bins live inside each cell, and so do the
 * attributes about them. Both are answered by asking the file the same
 * question, and every gate below is then written once.
 *
 * Falling back to the *first* cell rather than merging every cell's: the cells
 * of an scool share one bin space by construction (that is what makes summing
 * them meaningful at all), so the first one speaks for all of them, and reading
 * several thousand attribute blocks to gate a file would cost more than opening
 * it.
 */
export function scoolGeometry(
  h: Hdf5Handle,
  layout: Layout,
  rootAttrs: Record<string, AttrValue>,
): { attrs: Record<string, AttrValue>; from: string | null } {
  if (intAttr(rootAttrs, 'bin-size') !== null) return { attrs: rootAttrs, from: null }
  const first = layout.entries?.[0]
  if (first === undefined) return { attrs: rootAttrs, from: null }
  const path = cellPath(layout, first)
  return { attrs: h.attrsAt(path), from: path }
}

/**
 * Refuse an scool that carries no cells at all.
 *
 * Distinct from the mcool and mmetacool refusals above, which say *pick one*:
 * an scool root is a view in its own right — the cells table — so the only
 * thing to refuse is a container with nothing in it.
 */
export function assertHasCells(h: Hdf5Handle, layout: Layout): void {
  if ((layout.entries ?? []).length > 0) return
  throw new ViewerError(
    'not-a-cooler',
    `${parseUri(h.uri).path} is a single-cell cooler container with no cells in it.`,
    { path: parseUri(h.uri).path },
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

  // An scool's geometry may be written on its root or only inside its cells,
  // so the gate below is applied to whichever of the two the file used. Every
  // other layout answers with its own root attributes, unchanged.
  const geometry = layout.kind === 'scool' ? scoolGeometry(h, layout, attrs) : { attrs, from: null }
  if (layout.kind === 'scool') {
    assertHasCells(h, layout)
    const version = intAttr(attrs, 'format-version')
    if (strAttr(attrs, 'format') === SCOOL_FORMAT && version !== null && version !== SCOOL_FORMAT_VERSION) {
      throw new ViewerError(
        'bad-format-version',
        `This file declares scool format-version ${version}; the viewer understands version ` +
          `${SCOOL_FORMAT_VERSION}. Open it with a viewer that reads ${version}, or re-create it ` +
          `with \`cooler.create_scool\`.`,
        { found: version, expected: SCOOL_FORMAT_VERSION },
      )
    }
  }

  // `intAttr` is the gate, not `Number()` — see its doc comment.
  const binType = strAttr(geometry.attrs, 'bin-type')
  const binSize = intAttr(geometry.attrs, 'bin-size')
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

  resolveStorageMode(geometry.attrs)
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
