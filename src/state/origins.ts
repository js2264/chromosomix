/**
 * Where each sequence's replication origin is.
 *
 * The same kind of fact as a circular declaration (`state/circular.ts`) and kept
 * the same way: per file, remembered for the session, carried in an exported
 * workspace, and **not** in the view state — it is about the molecule rather
 * than the window. What reads it is everything that sees a bacterial chromosome
 * in the frame of its two arms (§8.15): the arm-frame expectation, on the map
 * and in the compartment call; the inter-arm alignment; and the one-step framing
 * of a circle with its origin in the middle.
 *
 * Two hands write it, and the difference is kept. The *Origin and terminus*
 * task fills in every sequence it places; a reader's own arrives in a workspace
 * they exported, or on a `metacooler-run` line's `--origin`, and the Chromosomes
 * table shows whichever is held. A reader's origin is **never** overwritten by
 * a task — a reader who has corrected a call knows something the skew did not —
 * while a task's is replaced by the next run of the task, which is what
 * re-running it with different sites is for.
 *
 * Base pairs, 0-based — the machine form every coordinate is kept in (§26.1);
 * the table and the CLI print it 1-based.
 */

import { recall, remember } from './UiMemory'

/** The `UiMemory` scope this is kept under. Also in `SessionConfig`'s table. */
export const ORIGIN_SCOPE = 'map:origins'

/** One declared origin: where, and whose word it is. */
export interface DeclaredOrigin {
  /** Base pairs, 0-based. */
  at: number
  by: 'reader' | 'task'
}

/** The stored shape, validated on the way in because storage outlives code. */
function parse(stored: unknown): Map<string, DeclaredOrigin> {
  const out = new Map<string, DeclaredOrigin>()
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return out
  for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out.set(name, { at: Math.floor(value), by: 'reader' })
      continue
    }
    if (value === null || typeof value !== 'object') continue
    const { at, by } = value as { at?: unknown; by?: unknown }
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue
    out.set(name, { at: Math.floor(at), by: by === 'task' ? 'task' : 'reader' })
  }
  return out
}

/** The declared origins of one open file. */
export class OriginStore {
  private origins: Map<string, DeclaredOrigin>
  private readonly listeners = new Set<() => void>()

  constructor(private readonly key: string) {
    this.origins = parse(recall<unknown>(key, ORIGIN_SCOPE))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The declared origin of a sequence, or `undefined`. */
  get(name: string): DeclaredOrigin | undefined {
    return this.origins.get(name)
  }

  /** Every declared origin by name, in base pairs — what a framing carries. */
  record(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [name, origin] of [...this.origins.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out[name] = origin.at
    }
    return out
  }

  /** Set by the reader, or cleared with `null`. */
  set(name: string, at: number | null): void {
    if (at === null) {
      if (!this.origins.delete(name)) return
    } else {
      const next = Math.max(0, Math.floor(at))
      const held = this.origins.get(name)
      if (held?.at === next && held.by === 'reader') return
      this.origins.set(name, { at: next, by: 'reader' })
    }
    this.persist()
  }

  /**
   * Filled in by a task, for every sequence the reader has not set one on.
   *
   * @returns The names that took the task's origin, so the caller can say so.
   */
  fill(found: Readonly<Record<string, number>>): string[] {
    const taken: string[] = []
    for (const [name, at] of Object.entries(found)) {
      if (!Number.isFinite(at) || at < 0) continue
      const held = this.origins.get(name)
      if (held?.by === 'reader') continue
      if (held?.at === Math.floor(at)) continue
      this.origins.set(name, { at: Math.floor(at), by: 'task' })
      taken.push(name)
    }
    if (taken.length > 0) this.persist()
    return taken
  }

  /** Replace the lot — how an imported workspace arrives. Every one is the reader's. */
  replace(found: Readonly<Record<string, number>>): void {
    this.origins = parse(found)
    this.persist()
  }

  private persist(): void {
    const stored: Record<string, DeclaredOrigin> = {}
    for (const [name, origin] of this.origins) stored[name] = origin
    remember(this.key, ORIGIN_SCOPE, stored)
    for (const listener of this.listeners) listener()
  }
}
