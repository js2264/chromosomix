/**
 * Where {@link RASTER_MAX_DIM} comes from, and the one way to move it.
 *
 * The cap is a constant with three arguments behind it — a browser's canvas
 * limits above, a display's pixel count below, and the two picture-sized
 * allocations it bounds — and `render/heatmap.ts` states all three where it is
 * declared. None of them is a *measurement* of the machine the app is running
 * on, so the number is a defensible default rather than a derived fact, and the
 * question "what would this look like at 8192" is one a reader of this code
 * asks long before anyone else does.
 *
 * So there is an override, and it is deliberately the smallest kind there is:
 * **read once, at module load, and never again.** A `?raster=` on the page URL,
 * or a `metacooler-viewer:raster-max-dim` in `localStorage` for a setting that
 * should outlive the address bar. Nothing writes either from inside the app,
 * there is no control for it, and changing one takes effect on the next reload.
 *
 * That is not timidity about the UI, it is what keeps the invariants true. The
 * cap is read by both sides of the worker wall and it is the *same* number on
 * both by construction — `pooledCellCap()` follows `RASTER_MAX_DIM`, which is the
 * whole of why the grid a reader builds is the grid the renderer draws
 * (`metacooler/pooling.ts`). A cap that moved mid-session would move it under
 * blocks already read and already on screen, so a picture drawn at one cap
 * would be labelled, hovered and exported against another. A reload has no such
 * seam: every block in the session was read at the cap the session started with.
 *
 * **The URL wins over the stored value**, because a link is a deliberate
 * one-off and a stored setting is a standing preference; and a URL is *not*
 * written back to storage, so trying a number once does not make it stick.
 */

/** The number three arguments in `render/heatmap.ts` settle on. */
export const RASTER_MAX_DIM_DEFAULT = 4096

/** The query parameter, on the page's own URL: `?raster=8192`. */
export const RASTER_PARAM = 'raster'

/** The stored key, for a preference that should outlive one address bar. */
export const RASTER_KEY = 'metacooler-viewer:raster-max-dim'

/**
 * The smallest cap worth having. Below this the raster is coarser than the
 * panel it is drawn into on any screen, so every map in the app would be a
 * thumbnail magnified — which is a bug report, not an experiment.
 */
export const RASTER_MIN = 512

/**
 * The largest the *platform* allows, not the largest that will work.
 *
 * `16384² = 2^28`, which is Chrome's canvas **area** cap exactly, so this is
 * the last value at which a raster is a canvas at all. It is far past the last
 * value at which one is a good idea: the RGBA bytes and the canvas backing
 * store are 1.07 GB each at this size, and `checkBrowserDenseSize` will refuse
 * the read that feeds them long before they are allocated.
 *
 * Clamping here rather than lower is the honest division of labour. This
 * function's job is to reject a number that cannot mean anything — a zero, a
 * word, a negative — and the guards downstream already state, in bytes and
 * against this machine's own budget, why a block is too large. Capping at 8192
 * to be helpful would replace their specific refusal with a silent rounding.
 */
export const RASTER_MAX = 16384

/** A positive integer within the range, or `null` for anything else. */
function parse(raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null) return null
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(RASTER_MAX, Math.max(RASTER_MIN, Math.trunc(value)))
}

/** `?raster=` on the page URL. Absent in a worker, whose URL is its own. */
function fromUrl(): number | null {
  const location = (globalThis as { location?: { search?: string } }).location
  if (typeof location?.search !== 'string') return null
  try {
    return parse(new URLSearchParams(location.search).get(RASTER_PARAM))
  } catch {
    return null
  }
}

/**
 * The stored preference.
 *
 * Wrapped, because `localStorage` is absent in a worker and *throws* on access
 * in a page with site data blocked — the same two cases `ui/refine.ts` guards,
 * and for the same reason: a reader with third-party storage off should get the
 * default, not a blank app.
 */
function fromStorage(): number | null {
  try {
    const store = (globalThis as { localStorage?: Storage }).localStorage
    return store === undefined ? null : parse(store.getItem(RASTER_KEY))
  } catch {
    return null
  }
}

/**
 * Read the override. Exported for the tests, which exercise the parsing and the
 * clamp without reloading a page; the app resolves it once, below.
 */
export function resolveRasterMaxDim(): number {
  return fromUrl() ?? fromStorage() ?? RASTER_MAX_DIM_DEFAULT
}

/**
 * The cap this thread runs at, and the single place it is held.
 *
 * One variable rather than a constant in each module that wants it, because the
 * two that did — the renderer's raster and the reader's grid — have to be the
 * *same* number or the picture is drawn on a grid it was not read on. Here they
 * cannot drift: `render/heatmap.ts` and `metacooler/pooling.ts` both read this.
 *
 * A page resolves it correctly at load. A worker cannot — it has no page URL
 * and no `localStorage` — so it starts at the default and is told the session's
 * value by {@link setRasterMaxDim}, which the reader calls before dispatching
 * any request. Fixed for the life of the thread either way.
 */
let cap = resolveRasterMaxDim()

/**
 * The largest raster the renderer will build, per axis, and the grid a pooled
 * read aims for — one number, because they must not differ.
 *
 * The default is chosen well below every browser's canvas cap (Firefox stops at
 * 32,767 px per side, Chrome's *area* cap is `2^28` px) and above any display:
 * 4,096 px is more than 4K across, so pooling above it costs no visible detail
 * at fit zoom, and a zoomed-in view of a pooled block re-rasterises nothing
 * because pooling is per matrix, not per view. It caps the two allocations that
 * scale with the *picture* rather than with the data: 67 MB of RGBA and 67 MB
 * of canvas.
 *
 * Note which of those three arguments does what, because it is the question
 * anyone moving the number asks first: the canvas caps are the **ceiling**, the
 * display is the **floor** — it says why this is not 1,024, not why it is not
 * 16,384 — and the allocations are what the choice between them costs.
 */
export function rasterMaxDim(): number {
  return cap
}

/**
 * Tell this thread the session's cap — what a worker learns it through.
 *
 * A no-op for anything that is not a positive integer, so a message from an
 * older client cannot set the cap to `NaN` and make every pooled grid empty.
 */
export function setRasterMaxDim(value: number | undefined): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return
  cap = Math.trunc(value)
}
