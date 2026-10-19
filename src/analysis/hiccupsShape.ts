/**
 * The shape of Loop calling's four kernels, apart from the arithmetic that uses them.
 *
 * The panel needs this much — which kernel cooltools recommends for a bin size,
 * how many cells each kernel sums, how many λ-chunks it accepts — to seed the
 * form and price a run, and nothing else of `analysis/hiccups.ts`. Kept apart
 * for the reason `analysis/job.ts` keeps descriptors from runners: what the
 * worker alone uses, only the worker's bundle carries.
 */

/** The four neighbourhoods, in the order `recommend_kernels` lists them. */
export const HICCUPS_KERNELS = ['donut', 'vertical', 'horizontal', 'lowleft'] as const
export type HiccupsKernel = (typeof HICCUPS_KERNELS)[number]

/** A kernel's two half-widths: `w`, how far it reaches, and `p`, the peak it leaves out. */
export interface KernelShape {
  w: number
  p: number
}

/**
 * `recommend_kernels`: the shape `dots` picks for a bin size, or `null` where it has none.
 *
 * cooltools has an answer between 4 and 28 kb and refuses either side of it —
 * too sparse below, too coarse for a dot above — unless it is handed kernels.
 */
export function recommendedKernel(binsize: number): KernelShape | null {
  if (binsize > 28_000) return null
  if (binsize >= 18_000) return { w: 3, p: 1 }
  if (binsize >= 8_000) return { w: 5, p: 2 }
  if (binsize >= 4_000) return { w: 7, p: 4 }
  return null
}

/**
 * `get_kernel(w, p, ktype)`: `(2w + 1)²` cells of 0 and 1, row-major.
 *
 * The lower-left kernel is built as cooltools builds it — its *upper-right*
 * quarter, with the comment there that `upright` and `lowleft` look switched —
 * because `scipy.ndimage.convolve` turns a kernel through 180° before it
 * applies it, and what lands on the map is the quarter between the pixel and
 * the diagonal.
 */
export function kernelMatrix(shape: KernelShape, type: HiccupsKernel): Uint8Array {
  const { w, p } = shape
  const width = 2 * w + 1
  const out = new Uint8Array(width * width)
  for (let r = 0; r < width; r++) {
    for (let c = 0; c < width; c++) {
      const y = r - w
      const x = c - w
      const inner = -p <= x && x <= p && -p <= y && y <= p
      let masked: boolean
      switch (type) {
        case 'donut':
          masked = inner || x === 0 || y === 0
          break
        case 'vertical':
          masked = -1 > x || x > 1 || inner
          break
        case 'horizontal':
          masked = -1 > y || y > 1 || inner
          break
        case 'lowleft': {
          // The mask is built for the lower-left quarter and then reflected
          // through the centre, so the cell kept at (y, x) is the one the
          // unreflected mask kept at (−y, −x).
          const yy = -y
          const xx = -x
          masked = (xx >= -p && yy <= p) || xx >= 0 || yy <= 0
          break
        }
      }
      out[r * width + c] = masked ? 0 : 1
    }
  }
  return out
}

/**
 * One kernel as the cells it sums, in the order `scipy.ndimage.convolve` sums them.
 *
 * `convolve` reverses the kernel on both axes and correlates: the output at
 * `(i, j)` is the sum, over the reversed kernel's non-zero cells in row-major
 * order, of the input at `(i + dr, j + dc)`. So `dr` and `dc` here run from
 * `−w` to `w`, rows outer, and a cell is in the footprint where the kernel's
 * own `(w − dr, w − dc)` is not zero.
 */
export interface Footprint {
  /** Row offset of each cell from the pixel. */
  dr: Int32Array
  /** Column offset less row offset: how many diagonals the cell is from the pixel's. */
  dd: Int32Array
}

export function footprintOf(shape: KernelShape, type: HiccupsKernel): Footprint {
  const { w } = shape
  const width = 2 * w + 1
  const kernel = kernelMatrix(shape, type)
  const dr: number[] = []
  const dd: number[] = []
  for (let r = -w; r <= w; r++) {
    for (let c = -w; c <= w; c++) {
      if (kernel[(w - r) * width + (w - c)] === 0) continue
      dr.push(r)
      dd.push(c - r)
    }
  }
  return { dr: Int32Array.from(dr), dd: Int32Array.from(dd) }
}

/** `dots` refuses fewer λ-chunks than this … */
export const MIN_LAMBDA_BINS = 40
/** … and more than this. */
export const MAX_LAMBDA_BINS = 50
