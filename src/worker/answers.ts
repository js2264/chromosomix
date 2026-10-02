/**
 * Answers the reader has already given, kept so a place visited again is drawn
 * from memory (§12).
 *
 * Every view asks the worker for its block, and every view is built afresh on a
 * navigation, so going back to a chromosome read a minute ago paid for it again:
 * the pixels decompressed again, pooled again into the same cells, and sent
 * across again — 3.8 s of a worker's time for chr1 of a mouse map at 10 kb whose
 * every byte was already in memory, and the round trips again for whatever the
 * source's chunk cache had let go since. The answer was never going to differ.
 * A request is a pure question about the map the worker holds, so the same
 * question about the same map is answered here, on the page, without asking.
 *
 * **What is kept** is the answer to a read — a `range`, and the four requests
 * that return a picture (`matrix`, `aggregate`, `selection`, `overview`) — keyed
 * by the request's every field but its id and its scheduling, so a block asked
 * at another resolution, another balancing or another score is another answer.
 * The object itself is handed back, not a copy: nothing on the page writes into
 * a block (every derivation allocates its own array, `render/derive.ts`), and
 * an answer handed back by identity is what lets the picture drawn from it be
 * kept as well (`render/heatmap.ts`, `pooledOf`).
 *
 * **What it is kept against** is the map the worker holds, which only a few
 * requests change. An `open` names it — the file, its source, the edit it is
 * drawn through, its import, the page's dev switch — and answers are filed under
 * that name, so switching to another resolution and back finds them again. A
 * total drawn to (`resample`), a cell set (`selectCells`), a `close`, a failed
 * open, and any request this module does not know start a name nothing is
 * filed under: a cache that might answer for a map the worker no longer holds is
 * worse than none, and the default for a request nobody has classified is the
 * one that cannot be wrong. An answer that arrives after such a change, for a
 * question asked before it, is handed to its caller and not kept.
 *
 * **What it costs** is memory, bounded: one budget for the page however many
 * readers it holds — a deck's every cell and the second file of a comparison
 * share it — least recently used first out. A picture is counted twice, because
 * the pooled display kept beside it can be as large as its values.
 */

import { DEVICE_MEMORY_FALLBACK_GIB } from '../constants'
import type { RequestKind, StatsResult } from './protocol'

/** The requests whose answers are kept. */
const KEPT: ReadonlySet<RequestKind> = new Set<RequestKind>(['range', 'matrix', 'aggregate', 'selection', 'overview'])

/**
 * The requests that change nothing a kept answer depends on.
 *
 * Read-only questions, a cancel, the exports, and the stage's and the refine's
 * own state, which no read of the map consults. A kind missing from here and
 * from {@link KEPT} is taken to change the map, so a request added to the
 * protocol later costs a cache flush until somebody says otherwise, and never a
 * stale picture.
 */
const NEUTRAL: ReadonlySet<RequestKind> = new Set<RequestKind>([
  'genomes',
  'contigs',
  'cells',
  'binColumns',
  'binColumn',
  'overviewSidecar',
  'validateDeep',
  'stats',
  'contacts',
  'exportMcool',
  'exportLifted',
  'picture',
  'stageWindow',
  'suggest',
  'refine',
  'genomeLinks',
  'cancel',
])

/**
 * Fields of a request that are not part of the question: when it runs, not what
 * it asks. A credential is how a source is reached, and is refreshed under a
 * session that does not change.
 */
const NOT_ASKED = new Set(['id', 'background', 'credential', 'headers'])

/** What a page lends kept answers, out of each GiB the machine reports. */
const SHARE_OF_MEMORY = 1 / 16

/** And never more than this, however much the machine reports. */
const MAX_BUDGET_BYTES = 1 << 30

/**
 * The page's budget for kept answers: 512 MiB on a machine reporting 8 GiB, or
 * not reporting at all (`DEVICE_MEMORY_FALLBACK_GIB`), and a gibibyte at most.
 * That holds the walk this was written for — two mouse chromosomes at 10 kb and
 * a window of one, with their pictures — and a full-size 4,096-cell block is
 * 134 MB of it, counted twice.
 */
export function answerBudgetBytes(): number {
  const reported = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory
  const gib = typeof reported === 'number' && reported > 0 ? reported : DEVICE_MEMORY_FALLBACK_GIB
  return Math.min(MAX_BUDGET_BYTES, Math.floor(gib * SHARE_OF_MEMORY * 1024 ** 3))
}

interface Kept {
  value: unknown
  bytes: number
  owner: number
}

/**
 * The page's kept answers, for every reader on it, least recently used first.
 *
 * Exported so a test can hold its own with a budget it chooses; the app has the
 * one below.
 */
export class KeptAnswers {
  /** Insertion-ordered, so the first key is the least recently used. */
  private readonly entries = new Map<string, Kept>()
  private held = 0

  constructor(private readonly budget: () => number = answerBudgetBytes) {}

  get bytes(): number {
    return this.held
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string): unknown {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  put(key: string, value: unknown, owner: number): void {
    const bytes = bytesOf(value)
    const budget = this.budget()
    this.remove(key)
    // One answer larger than the whole budget is not kept rather than allowed
    // to empty the cache of everything else on its way in.
    if (bytes > budget) return
    this.entries.set(key, { value, bytes, owner })
    this.held += bytes
    for (const [oldest, entry] of this.entries) {
      if (this.held <= budget) break
      this.entries.delete(oldest)
      this.held -= entry.bytes
    }
  }

  /** Everything one reader kept: its worker is gone, or its map is in doubt. */
  dropOwner(owner: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.owner === owner) this.remove(key)
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    this.held -= entry.bytes
  }
}

const shared = new KeptAnswers()
let owners = 0
let names = 0

/** A map name nothing has been filed under, and nothing will be asked for by. */
function fresh(): string {
  return `#${++names}`
}

/**
 * One reader's view of the kept answers: the map its worker holds, and the
 * reads it has on their way.
 *
 * Driven by `ReaderClient`, which asks {@link answer} before sending a request
 * and hands every request it does send to {@link track}.
 */
export class AnswerCache {
  private readonly owner = ++owners
  /** The map the worker holds, as {@link openName} names it. */
  private name = fresh()
  /** Bumped by every request that can change an answer. */
  private epoch = 0
  /** Reads sent and not yet answered, for a second asker to wait on. */
  private readonly flying = new Map<string, Promise<unknown>>()
  /**
   * Whether the latest picture asked for was answered from memory, and so cost
   * nothing, rather than read — see {@link lastView}.
   */
  private viewKept = false

  constructor(private readonly store: KeptAnswers = shared) {}

  /**
   * The answer already in hand for `request`, or the read of it already on its
   * way when `join` allows waiting on one; `undefined` when it has to be sent.
   *
   * A cancellable read does not join: its cancel would call off a read somebody
   * else is waiting on, or leave it running for a caller who has gone.
   */
  answer(request: Readonly<{ kind: RequestKind }>, join: boolean): Promise<unknown> | undefined {
    const key = this.keyOf(request)
    if (key === null) return undefined
    const held = this.store.get(key)
    if (held !== undefined) {
      if (request.kind !== 'range') this.viewKept = true
      return Promise.resolve(held)
    }
    const flying = join ? this.flying.get(key) : undefined
    // Waiting on a read costs that read, which the worker is counting.
    if (flying !== undefined && request.kind !== 'range') this.viewKept = false
    return flying
  }

  /**
   * Note a request that has just been sent, and keep its answer when it comes.
   *
   * @param share Whether a later asker may wait on this read ({@link answer}'s
   *   `join`): a plain request, but not a cancellable one, nor one the worker
   *   holds back until the views are quiet.
   * @returns The promise to hand the caller: the same answer, kept on the way.
   */
  track<T>(request: Readonly<{ kind: RequestKind; background?: boolean }>, sent: Promise<T>, share: boolean): Promise<T> {
    if (request.kind === 'stats') return this.lastView(sent)
    if (!KEPT.has(request.kind)) {
      if (!NEUTRAL.has(request.kind)) this.moved(request, sent)
      return sent
    }
    const key = this.keyOf(request)
    if (key === null) return sent
    if (request.kind !== 'range') this.viewKept = false
    const epoch = this.epoch
    const kept = sent.then((value) => {
      if (this.epoch === epoch) {
        // Keeping is a convenience, and the answer is the caller's whatever
        // becomes of it: a value this module cannot measure is handed over
        // unkept rather than turned into a failed read.
        try {
          this.store.put(key, value, this.owner)
        } catch {
          /* not kept */
        }
      }
      return value
    })
    if (share && request.background !== true) {
      this.flying.set(key, kept)
      const landed = (): void => {
        if (this.flying.get(key) === kept) this.flying.delete(key)
      }
      kept.then(landed, landed)
    }
    return kept
  }

  /**
   * The worker's counters, with the last view's cost put right.
   *
   * The status bar's *read* panel says what the last view cost (§12), and the
   * worker counts only what it is asked: a view answered from here never reaches
   * it, and its counter would go on naming the read before. A view answered from
   * memory cost nothing, and that is what is said.
   */
  private lastView<T>(sent: Promise<T>): Promise<T> {
    return sent.then((stats) => {
      if (!this.viewKept) return stats
      const counted = stats as unknown as StatsResult
      return { ...counted, lastOp: { requests: 0, bytes: 0 } } as unknown as T
    })
  }

  /** Forget everything: the reader is being put down. */
  clear(): void {
    this.epoch++
    this.flying.clear()
    this.name = fresh()
    this.store.dropOwner(this.owner)
  }

  /** A request that changes the map the worker holds, or may. */
  private moved(request: Readonly<{ kind: RequestKind }>, sent: Promise<unknown>): void {
    this.epoch++
    this.flying.clear()
    if (request.kind === 'open') {
      const name = openName(request)
      this.name = name ?? fresh()
      if (name === null) return
      // A failed open leaves no map behind — the worker drops the last one
      // before it reads the next — so nothing filed under this name may be
      // answered until an open of it succeeds.
      sent.catch(() => {
        if (this.name !== name) return
        this.name = fresh()
        this.epoch++
      })
      return
    }
    this.name = fresh()
    // A request nobody has classified may have changed anything, including
    // what an earlier map's answers meant; the three that are known change only
    // the map now open, which a later open of it starts again from.
    if (request.kind !== 'resample' && request.kind !== 'selectCells' && request.kind !== 'close') {
      this.store.dropOwner(this.owner)
    }
  }

  /** The key `request` is kept under, or `null` for one that is not kept — or cannot be named. */
  private keyOf(request: Readonly<{ kind: RequestKind }>): string | null {
    if (!KEPT.has(request.kind)) return null
    try {
      return `${this.owner}\u0001${this.name}\u0001${stableKey(request)}`
    } catch {
      return null
    }
  }
}

/**
 * The name of the map an `open` leaves the worker holding.
 *
 * Everything the open carries, because everything it carries decides what the
 * map is — the URI with its entry, the source, the edit, the import's binning,
 * the dev switch — except how the bytes are reached. A local file is named by
 * the `File` object itself rather than by its name, since two files called
 * `sample.mcool` dropped from two folders are two maps.
 */
function openName(request: Readonly<{ kind: RequestKind }>): string | null {
  try {
    return `open:${stableKey(request)}`
  } catch {
    // An open that cannot be named is a map nothing is filed under.
    return null
  }
}

const blobIds = new WeakMap<object, number>()
let blobs = 0

/** A request as a string, its keys sorted and what is not asked left out. */
export function stableKey(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? ''
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    let id = blobIds.get(value)
    if (id === undefined) {
      id = ++blobs
      blobIds.set(value, id)
    }
    return { blob: id }
  }
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(canonical)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (NOT_ASKED.has(key)) continue
    const field = (value as Record<string, unknown>)[key]
    if (field !== undefined) out[key] = canonical(field)
  }
  return out
}

/**
 * Bytes an answer holds, near enough to budget by: its typed arrays exactly,
 * and a flat allowance for everything else. A picture — an answer carrying a
 * `Float32Array` of values — is counted twice, for the pooled display kept
 * beside it while it is held (`render/heatmap.ts`), which is at most as large.
 */
export function bytesOf(value: unknown): number {
  const picture = (value as { values?: unknown } | null)?.values
  return walk(value, 0) + (picture instanceof Float32Array ? picture.byteLength : 0)
}

function walk(value: unknown, depth: number): number {
  if (typeof value === 'string') return 16 + value.length * 2
  if (value === null || typeof value !== 'object') return 8
  if (ArrayBuffer.isView(value)) return value.byteLength
  if (depth > 8) return 64
  if (Array.isArray(value)) {
    let total = 16
    for (const item of value) total += walk(item, depth + 1)
    return total
  }
  let total = 32
  for (const field of Object.values(value as Record<string, unknown>)) total += walk(field, depth + 1)
  return total
}
