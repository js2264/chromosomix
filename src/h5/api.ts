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
   * Read a half-open slice of a string dataset, UTF-8 decoded with trailing NUL
   * padding stripped. Handles fixed-length `S<n>` (sized by encoded *byte*
   * length, so never assume ASCII) as well as the vlen `O`/`U` kinds a file
   * from `create cool` may carry.
   */
  readStrings(path: string, lo?: number, hi?: number): string[]

  /**
   * Read every column under a table group into a {@link Table}. The column set
   * is discovered from the group, never hard-coded.
   */
  readTable(path: string, lo?: number, hi?: number): Table

  /** Release the handle and its byte source. Idempotent. */
  close(): void
}
