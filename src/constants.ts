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
 * The *browser's* ceiling on a dense block, in cells. Stricter than the CLI's.
 *
 * `DENSE_MATRIX_BIN_LIMIT` is Python's, and mirroring it is right for the
 * refusal wording — but a machine with 64 GB and a tab are different places.
 * The limit above allows 50,000 x 50,000 = 2.5e9 cells; on screen that block
 * costs about 16 bytes per cell — the Float32 values, the transformed copy
 * (`render/scale.ts`), the RGBA bytes and the canvas backing store — so 40 GB,
 * and its raster is nine times Chrome's 2^28-pixel canvas area cap. The tab
 * dies before anything is drawn.
 *
 * 1e8 cells is ~10,000 bins per axis: about 1.6 GB at the same accounting, and
 * under the canvas cap. It admits every MAG in a metagenome (the largest in
 * Hum53 is ~6,600 bins) and refuses a human chromosome at 5 kb (49,792 bins,
 * 2.5e9 cells) — which is exactly the whole-chromosome case SPECS §9 promises
 * to refuse rather than attempt.
 */
export const BROWSER_DENSE_CELL_LIMIT = 100_000_000

/**
 * The longest a single axis may be, in bins.
 *
 * A cell count is not the whole story: the raster is put on a canvas, and a
 * canvas has a maximum *side* as well as a maximum area. Firefox stops at
 * 32,767 px per dimension and Chrome at 65,535, so the smaller of the two is
 * the portable answer. Without this a long thin block — human chr1 at 1 kb is
 * 248,957 bins by whatever the other axis is — passes the cell limit and then
 * cannot be drawn at all.
 */
export const BROWSER_CANVAS_DIM_LIMIT = 32_767

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
