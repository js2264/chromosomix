/**
 * Format constants mirrored from `metacooler.schema`.
 *
 * Every value here is part of the on-disk format and must match the Python
 * package exactly. When metacooler bumps one of these, the goldens regenerated
 * by `scripts/make_golden.py` fail first — that is the intended tripwire.
 */

export const METACOOLER_FORMAT = 'HDF5::MetaCooler'
export const METACOOLER_FORMAT_VERSION = 1
export const MMETACOOLER_FORMAT = 'HDF5::MMetaCooler'
export const MMETACOOLER_FORMAT_VERSION = 1
export const COOLER_FORMAT = 'HDF5::Cooler'

/** Refuse to allocate a dense matrix larger than this on either axis. */
export const DENSE_MATRIX_BIN_LIMIT = 50_000

/**
 * How much of the machine's memory one displayed block may claim.
 *
 * `navigator.deviceMemory` reports RAM in GiB, rounded down to a power of two
 * and **capped at 8** by every browser that implements it, so a 64 GB
 * workstation and an 8 GB laptop both say 8. It is a floor, not a measurement,
 * which is why the share is modest: a third of what the browser admits to,
 * never less than 1 GB. The floor matters for the machines that report 2 GiB
 * or less, where a third would refuse blocks those machines can in fact draw.
 */
export const DEVICE_MEMORY_SHARE = 1 / 3

/** Assumed RAM in GiB when the browser does not say. */
export const DEVICE_MEMORY_FALLBACK_GIB = 4

/** Never budget less than this, whatever the device claims. */
export const MIN_DENSE_BUDGET_BYTES = 1e9

/**
 * The most cells one dense block may have, whatever the machine has.
 *
 * The values live in a `Float32Array`, and V8 will not allocate one past about
 * 2^31 elements however much memory is free. This is the wall no budget can
 * argue with; everything below it is a question of how much RAM to spend, which
 * `metacooler/matrix.ts` answers by estimating rather than by a fixed limit.
 *
 * The canvas caps that used to sit here are gone: the raster is pooled to
 * `RASTER_MAX_DIM` per axis, so no selection can ask for a canvas bigger than
 * 4096 px on a side and neither Chrome's area cap nor Firefox's side cap is
 * reachable any more.
 */
export const MAX_TYPED_ARRAY_CELLS = 2 ** 31

/** `storage-mode` values the reader understands. */
export const STORAGE_MODES = ['symmetric-upper', 'square'] as const
export type StorageMode = (typeof STORAGE_MODES)[number]

/**
 * `contig-ordering` values that lay contigs out grouped by ascending
 * `genome_id`. Only for these is a genome one contiguous bin range.
 */
export const GENOME_GROUPED_ORDERINGS = ['genome-then-length', 'genome-then-alpha'] as const

/**
 * The only ordering this viewer accepts (spec C4). `genome-then-alpha` is also
 * genome-grouped and would work, but the spec commits to a single ordering so
 * that "accepted" is one string rather than a set that drifts.
 */
export const REQUIRED_ORDERING = 'genome-then-length'

/**
 * Reserved genome holding every contig binning failed to assign. Matched by
 * *name*, never by index: `create(drop_unassigned=True)` omits the row
 * entirely, which would make index 0 an ordinary MAG.
 */
export const UNBINNED_NAME = '__unbinned__'

/** Contig labels are drawn only below this count, matching `ops/show.py`. */
export const MAX_CATEGORICAL_TICKS = 50

/**
 * A contig at least this long is labelled however many contigs share the axis.
 *
 * The count rule above answers "would these names be a smear" with one number
 * for a whole axis, and a real MAG is not uniform: a few hundred contigs, a
 * handful of them megabases and the rest a few kilobases each. The handful are
 * the ones a reader is looking for, and the count rule refuses all of them
 * along with the rest. 50 kb is the usual floor for a contig anyone reads
 * individually, and at a 1 kb bin size it is a block fifty cells wide — wide
 * enough on screen to carry a name.
 */
export const LABEL_MIN_SPAN_BP = 50_000

/**
 * Sentinel strings that `metacooler.schema._int_attr` treats as "absent"
 * rather than as a parse error. Compared after trimming and lowercasing.
 */
export const INT_ATTR_NULL_SENTINELS = ['', 'null', 'none', 'nan'] as const
