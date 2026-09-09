/**
 * Typed refusals.
 *
 * Spec §10: every refusal names the file's actual state and the concrete fix.
 * The `code` is what the UI switches on; the `message` is what the user reads;
 * `detail` carries the machine-readable actual value so a test can assert on it
 * without regex-matching prose.
 */

import { pyList } from './format'

export type ErrorCode =
  | 'not-hdf5'
  | 'not-a-cooler'
  | 'mmetacool-root'
  | 'mcool-root'
  | 'pairs-binning-needed'
  | 'entry-not-found'
  | 'bad-format-version'
  | 'bad-ordering'
  | 'variable-bins'
  | 'unbinned-not-displayable'
  | 'dense-too-large'
  | 'unknown-label'
  | 'cell-not-found'
  | 'scool-listing-cost'
  | 'hicpro-load-cost'
  | 'hicpro-no-bins'
  | 'bad-range'
  | 'genome-coordinate-suffix'
  | 'unsupported'
  | 'bigwig-no-overlap'
  | 'remote-no-ranges'
  | 'remote-compressed'
  | 'remote-cors'
  | 'remote-too-large'
  | 'bad-uri'
  | 'format'

export class ViewerError extends Error {
  readonly code: ErrorCode
  readonly detail: Record<string, unknown>

  constructor(code: ErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ViewerError'
    this.code = code
    this.detail = detail
  }
}

/** Raised when a file does not conform to the metacooler format. */
export class MetaCoolerFormatError extends ViewerError {
  constructor(message: string, detail: Record<string, unknown> = {}, code: ErrorCode = 'format') {
    super(code, message, detail)
    this.name = 'MetaCoolerFormatError'
  }
}

/**
 * Render a list of names the way the Python errors do: at most `limit` entries,
 * then a count of the remainder.
 *
 * A port of `_truncate` in `ops/range.py`, down to the quoting.
 * `JSON.stringify` would render `["a","b"]` where Python's `str(list)` renders
 * `['a', 'b']` — different quotes *and* no space after the comma — and these
 * strings end up inside the `unknown-label` refusal, which spec §10 requires
 * to read identically in the browser and in `metacooler show`. A user grepping
 * for a name they saw in one must find it in the other.
 */
export function truncateNames(names: readonly string[], limit = 20): string {
  if (names.length <= limit) return pyList(names)
  return `${pyList(names.slice(0, limit))} ... (${names.length - limit} more)`
}
