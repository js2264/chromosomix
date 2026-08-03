/**
 * The HDF5 access contract.
 *
 * This is the *only* surface the rest of the app sees. `h5wasm` is imported
 * nowhere else (spec §6.1), which is what makes the local and remote paths
 * identical downstream and what makes the `/bins` guard (§3.3) enforceable by a
 * single test.
 */

import type { Table } from '../types'

/** Attribute values as they come off an HDF5 group, already byte-decoded. */
export type AttrValue = string | number | boolean | null | number[] | string[]

/**
 * An open HDF5 file rooted at a group. `group` is the URI's group path, so a
 * plain metacool and an mmetacool entry are the same object with a different
 * prefix — no call site branches on which it is.
 */
export interface Hdf5Handle {
  /** URI this handle was opened from, for error messages. */
  readonly uri: string
  /** Group path this handle is rooted at ('/' for a plain file). */
  readonly group: string
  /**
   * Names under `/entries` at the **file root**, regardless of where this handle
   * is rooted; `[]` when the file has no such group.
   *
   * Every other path on this interface resolves inside {@link group}, so a
   * handle opened at `/entries/rep1` cannot see `rep2`. The entry picker needs
   * exactly that, and it is free here: the open path already holds the root to
   * validate the group, so this is a read of something in hand rather than a
   * second traversal.
   */
  readonly rootEntries: string[]
  /**
   * Which group {@link rootEntries} came from — `entries` for an mmetacool,
   * `resolutions` for an mcool, `''` when there are none. The URI a caller
   * builds to open a sibling needs the word, not just the names.
   */
  readonly rootEntryGroup: string

  /** All attributes on the rooted group, decoded. */
  attrs(): Record<string, AttrValue>
  /** Attributes on an arbitrary group path, relative to the root. */
  attrsAt(path: string): Record<string, AttrValue>

  /** `true` if `path` (relative to the rooted group) exists. */
  has(path: string): boolean
  /** Child names of a group, in file order. Empty array if `path` is absent. */
  keys(path: string): string[]
  /** `true` if `path` resolves through a soft link (used for the /chroms check). */
  isSoftLink(path: string): boolean

  /** Row count of a dataset, without reading it. */
  datasetLength(path: string): number
  /**
   * h5wasm's dtype string for a dataset.
   *
   * These are **C-struct-style, not numpy-style** — verified against
   * `Hum53.metacool`: int64 is `'<q'`, int32 `'<i'`, float64 `'<d'`,
   * fixed-length strings `'A<n>'` (e.g. `'A25'`), vlen strings `'S'`. So
   * `dtype[1]` is *not* a numpy kind letter and slicing it yields `q`/`i`/`d`.
   * Map through {@link dtypeKind} in `./typed` rather than parsing it here.
   */
  dtype(path: string): string

  /**
   * Read a half-open slice `[lo, hi)` of a numeric dataset as Numbers.
   *
   * int64 columns arrive from h5wasm as `BigInt64Array`; this narrows them once
   * here (bin counts are far below 2^53) so no call site can mix BigInt with
   * Number — which throws at *runtime*, not compile time (spec §6.2).
   */
  readNumeric(path: string, lo?: number, hi?: number): Float64Array

  /**
   * Read a half-open slice of an integer column as `Int32Array`, with no
   * `Float64Array` in between.
   *
   * For the two pixel index columns, which are int64 on disk and array indices
   * in use. Going through {@link readNumeric} meant a bin id occupied 8 bytes as
   * a BigInt, 8 more as a double and 4 as its final self, all at once, for every
   * pixel of the read.
   */
  readInt32(path: string, lo?: number, hi?: number): Int32Array

  /**
   * Read a half-open slice of a string dataset, UTF-8 decoded with trailing NUL
   * padding stripped. Handles fixed-length `S<n>` (sized by encoded *byte*
   * length, so never assume ASCII) as well as the vlen `O`/`U` kinds a file
   * from `create cool` may carry.
   */
  readStrings(path: string, lo?: number, hi?: number): string[]

  /**
   * Read a table group into a {@link Table}. The column set is discovered from
   * the group, never hard-coded.
   *
   * `columns` narrows the *decode* to the named subset — the reader's own four
   * or five, as against the twenty a creator may have joined in. It does not
   * narrow the integrity checks, and it does not invent: a name that is not in
   * the file is absent from the result, exactly as it would be without the
   * filter, so a required-column check still catches a file that lacks one.
   * Omit it for the whole table, which is what the table *views* ask for.
   */
  readTable(path: string, lo?: number, hi?: number, columns?: readonly string[]): Table

  /** Release the handle and its byte source. Idempotent. */
  close(): void
}
