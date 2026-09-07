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

/**
 * cooler's single-cell container, one cooler per cell under `/cells`.
 *
 * The format the scool paper describes (Wolff et al. 2021), and what
 * `cooler.create_scool` writes. Detected on this attribute alone; the flat
 * layout below carries {@link COOLER_FORMAT} at its root instead and is
 * recognised by shape.
 */
export const SCOOL_FORMAT = 'HDF5::SCOOL'
export const SCOOL_FORMAT_VERSION = 1

/** Where a standard `.scool` keeps its cells. */
export const CELLS_GROUP = 'cells'

/**
 * Groups a cell must carry to be counted as one, in either layout.
 *
 * `chroms` is deliberately absent: a standard `.scool` hard-links it into every
 * cell, but the check below runs against a *candidate* group in a file that may
 * be anything at all, and requiring four groups where three settle it costs a
 * listing per candidate for no discrimination. `pixels` and `indexes` together
 * are what no non-cooler group has.
 */
export const CELL_GROUPS = ['bins', 'pixels', 'indexes'] as const

/** Refuse to allocate a dense matrix larger than this on either axis. */
export const DENSE_MATRIX_BIN_LIMIT = 50_000

/**
 * How much of the machine's memory one displayed block may claim.
 *
 * `navigator.deviceMemory` reports RAM in GiB, rounded down to a power of two.
 * It was capped at 8 by every browser that implemented it and no longer always
 * is — Chrome on a 16 GB Mac now answers 16 — but it is still a floor rather
 * than a measurement, and it is still absent in two of the three engines.
 *
 * Half, not a third. The share was set when guessing high meant a killed tab;
 * it does not any more, because the allocation itself is caught and translated
 * (`allocateDense`). What is left to lose by being generous is a clean refusal
 * arriving a moment later than it might have, and what was being lost by being
 * cautious is a picture the machine could have drawn. A modern laptop reporting
 * 8 now budgets 4.3 GB rather than 2.9.
 */
export const DEVICE_MEMORY_SHARE = 1 / 2

/**
 * Assumed RAM in GiB when the browser does not say.
 *
 * Which is most of the web: `navigator.deviceMemory` is Chromium-only, so
 * Firefox and Safari land here on every machine they run on, from a phone to a
 * workstation. That is why nothing downstream *refuses* on this number alone —
 * the estimate it feeds is a warning threshold, and the allocation itself is
 * the measurement (`metacooler/matrix.ts`).
 *
 * 8, not 4: a desktop browser opening a Hi-C map in 2026 is on a machine with
 * at least that, and the two engines that land here are desktop engines. The
 * phone this number used to be hedging against is bounded by the *real* limit
 * below, {@link MAX_DENSE_ARRAY_BYTES}, and by the allocation that either
 * succeeds or is caught.
 */
export const DEVICE_MEMORY_FALLBACK_GIB = 8

/**
 * The largest single typed array a browser will hand out — the one ceiling no
 * budget, and no confirmation, can raise.
 *
 * A dense block is one `Float32Array`, so `cells × 4` has to fit in one
 * allocation, and that allocation is capped at 2 GiB whatever the machine has.
 * Measured, in Chrome on a 16 GB Mac: 2,140,000,000 bytes is served,
 * `2 ** 31 - 4` is refused, and four separate 1 GB arrays live happily side by
 * side — so this is a limit on one array, not on the tab's memory. It puts the
 * largest square block at about 23,170 × 23,170 bins.
 *
 * It is checked before the memory budget rather than left to the allocator,
 * because it is the one refusal that is worth saying *in advance*: no amount of
 * RAM and no "load anyway" will change the answer, so the user needs the ways
 * through — a coarser resolution, contig level, a smaller region — and not a
 * button.
 */
export const MAX_DENSE_ARRAY_BYTES = 2 ** 31

/**
 * Never budget less than this — but only where the device's own claim is
 * plausible enough to be a floor rather than a ceiling.
 *
 * The floor was written for the 2 GiB bucket, where a *third* is 716 MB and
 * refuses blocks such a machine can in fact draw. At the share above it no
 * longer binds anywhere — half of 2 GiB is already more than this — and it is
 * kept because it is the invariant, not the arithmetic, that matters: the share
 * may be tuned again, and a small bucket must not be able to take the budget
 * below what any machine can serve.
 *
 * Applied unconditionally it inverted below that: a device reporting 0.25 GiB
 * was granted 1 GB, four times its entire RAM, turning a clean refusal into a
 * killed tab. See `deviceDenseBudgetBytes`, which applies it only at or above
 * {@link MIN_DENSE_BUDGET_GIB}.
 */
export const MIN_DENSE_BUDGET_BYTES = 1e9

/** The smallest reported memory for which {@link MIN_DENSE_BUDGET_BYTES} applies. */
export const MIN_DENSE_BUDGET_GIB = 2

/**
 * Above this many stored pixels, the whole-genome view asks before it reads.
 *
 * What that read costs is a pass over every pixel of the file. The block it
 * builds is bounded — it is pooled to the size the renderer will draw
 * (`metacooler/pooling.ts`) — so the pixels are the whole of the cost, and the
 * only thing worth asking about. It is the cost the whole-metagenome scan is
 * gated for (§7.3), measured the same way, which is why the two views now
 * behave alike.
 *
 * Ten million: a second or two of scattering into a pooled accumulator, the
 * point at which a picture stops appearing and starts being waited for. Below
 * it nothing is asked, because a question about an instant operation is worse
 * than the operation. A file that declares no `nnz` is not gated either — a cost
 * that cannot be stated is not one to ask someone to accept.
 */
export const WHOLE_VIEW_GATE_PIXELS = 10_000_000

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
