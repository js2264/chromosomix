/**
 * Every genome's colour on the curation stage (SPECS §33.3): one hue a genome,
 * a golden angle from the last — so two genomes side by side never share one —
 * kept by the genome's **slot**, not its place in a list, so a merge or a sort
 * changes no colour. A MAG is drawn at the hue's middle lightness, an element
 * darker, the pool in grey.
 *
 * The slot of a genome of the file is its row in the file's genome table; one a
 * step created is after every file genome, by the number its id was minted with,
 * stepped on where its hue would be near its neighbours' ({@link slotApart}).
 */

/** The pool's grey (`render/meta.ts`'s category grey). */
export const POOL_COLOUR = '#7a7a7a'

/** A genome's hue, `0`–`360`, from its slot. */
export function slotHue(slot: number): number {
  return Math.round((slot * 137.508) % 360)
}

/** A colour as CSS and as packed RGBA (little-endian `ABGR` in a `Uint32Array` over image data). */
export interface GenomeColour {
  css: string
  rgba: number
}

/** An HSL colour as packed RGBA, for an `ImageData` written through a `Uint32Array`. */
export function hslToRgba(h: number, s: number, l: number, alpha = 1): number {
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const r = Math.round(f(0) * 255)
  const g = Math.round(f(8) * 255)
  const b = Math.round(f(4) * 255)
  const al = Math.round(alpha * 255)
  return ((al << 24) | (b << 16) | (g << 8) | r) >>> 0
}

/** A genome's colour: by slot, darker for an element. */
export function genomeColour(slot: number, kind: 'mag' | 'element', dark = false): GenomeColour {
  const hue = slotHue(slot)
  // On the dark theme a colour a step lighter reads as the same genome.
  const lightness = (kind === 'mag' ? 0.54 : 0.38) + (dark ? 0.08 : 0)
  return { css: `hsl(${hue} 52% ${Math.round(lightness * 100)}%)`, rgba: hslToRgba(hue, 0.52, lightness) }
}

/** The pool's colour as packed RGBA. */
export const POOL_RGBA = ((0xff << 24) | (0x7a << 16) | (0x7a << 8) | 0x7a) >>> 0

/** How far apart two hues are, in degrees round the wheel: `0`–`180`. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

/**
 * A slot stepped on until its hue stands at least `least` degrees from every
 * slot `near` it — a genome a step creates is laid beside the genome its
 * contigs came from, and a golden angle at a Fibonacci gap is a degree away
 * (slots 34 and 178 on MM133). Twelve steps at most: the golden angle has
 * found a free hue long before.
 */
export function slotApart(slot: number, near: readonly number[], least = 30): number {
  for (let k = 0; k < 12; k++) {
    const hue = slotHue(slot + k)
    if (near.every((other) => hueDistance(hue, slotHue(other)) >= least)) return slot + k
  }
  return slot
}

/**
 * A genome's slot: the file genome's row, or — for one a step created, whose id
 * the stage mints as `<prefix><n>` — the file's genome count plus `n`.
 */
export function slotOf(file: number, id: string, fileGenomes: number): number {
  if (file >= 0) return file
  const match = /(\d+)$/.exec(id)
  return fileGenomes + (match === null ? 0 : Number(match[1]))
}
