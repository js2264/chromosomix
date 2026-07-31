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
 * Sentinel strings that `metacooler.schema._int_attr` treats as "absent"
 * rather than as a parse error. Compared after trimming and lowercasing.
 */
export const INT_ATTR_NULL_SENTINELS = ['', 'null', 'none', 'nan'] as const
