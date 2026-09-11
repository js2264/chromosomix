// WP-D stub: replaced by WP-A's implementation at merge — keep the types identical to contracts.md

export const HUB_KIND = 'metacooler.hub'
export const HUB_VERSION = 1

/** A table column after the implicit Name column; every column is filterable and sortable. */
export interface HubColumn { key: string; label: string }

export type HubEntryKind = 'map' | 'genome' | 'workspace'

export interface HubEntry {
  /** Required. The Name column. */
  label: string
  /**
   * Required. Relative to the hub's `base` (or to the hub's own URL directory when `base`
   * is absent), or absolute. May carry `::group` and `#index=`/`#bins=` exactly as any URI.
   * An absolute URI with any scheme (`https:`, `s3:`, `gs:`) passes through untouched.
   */
  uri: string
  /** Defaulted from the file name when absent: `.json` → workspace, else `routeOf(uri)`. */
  kind: HubEntryKind
  /** Bytes, when known; lets the table warn about a 5 GB row before it is clicked. */
  size?: number
  /** Free text: accession, publication, condition. Shown in the row, searchable. */
  note?: string
  /** Values for the hub's columns, by column key. Missing keys render empty. */
  fields?: Record<string, string>
  /** Companion tracks to offer after the entry opens (resolved like `uri`). */
  tracks?: Array<{ label: string; url: string }>
}

export interface Hub {
  kind: typeof HUB_KIND
  version: number
  name: string
  description?: string
  /** ISO 8601, when a generator wrote it. */
  generatedAt?: string
  /** Provenance: the query or repository the entries came from. */
  source?: string
  /** Absolute URL prefix ending in `/`. Default: the directory of the hub's own URL. */
  base?: string
  columns: HubColumn[]
  entries: HubEntry[]
}
