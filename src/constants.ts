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
 * which is why the share is modest: a third of what the browser admits to.
 */
export const DEVICE_MEMORY_SHARE = 1 / 3

/**
 * Assumed RAM in GiB when the browser does not say.
 *
 * Which is most of the web: `navigator.deviceMemory` is Chromium-only, so
 * Firefox and Safari land here on every machine they run on, from a phone to a
 * workstation. That is why nothing downstream *refuses* on this number alone —
 * the estimate it feeds is a warning threshold, and the allocation itself is
 * the measurement (`metacooler/matrix.ts`).
 */
export const DEVICE_MEMORY_FALLBACK_GIB = 4

/**
 * Never budget less than this — but only where the device's own claim is
 * plausible enough to be a floor rather than a ceiling.
 *
 * The floor exists for the 2 GiB bucket, where a third is 716 MB and refuses
 * blocks such a machine can in fact draw. Applied unconditionally it inverted
 * below that: a device reporting 0.25 GiB was granted 1 GB, four times its
 * entire RAM, turning a clean refusal into a killed tab. See
 * `deviceDenseBudgetBytes`, which applies it only at or above
 * {@link MIN_DENSE_BUDGET_GIB}.
 */
export const MIN_DENSE_BUDGET_BYTES = 1e9

/** The smallest reported memory for which {@link MIN_DENSE_BUDGET_BYTES} applies. */
export const MIN_DENSE_BUDGET_GIB = 2

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
