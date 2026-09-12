/**
 * Hues, so that a lane's own colour can be turned into a family of them.
 *
 * Two renderers need the same thing and for the same reason. An alignment lane
 * coloured by strand, and a feature lane coloured by strand or by a column of
 * its file, must stay recognisable as **one track drawn several ways** rather
 * than reading as several unrelated tracks — so the first category keeps the
 * colour the reader chose and the rest are rotations of it. That keeps the chip
 * on the row honest: whatever else is in the lane, the colour on its name is in
 * the picture.
 *
 * It was `render/alignments.ts`'s private arithmetic until `render/featureInk.ts`
 * wanted it too, and a second copy of a colour rule is how two lanes start
 * disagreeing about what the same swatch means.
 */

/** The hue of a `#rrggbb`, or 210 for anything that is not one. */
export function hueOf(colour: string): number {
  const hex = /^#?([0-9a-f]{6})$/i.exec(colour.trim())
  if (hex === null) return 210
  const value = Number.parseInt(hex[1], 16)
  const r = ((value >> 16) & 255) / 255
  const g = ((value >> 8) & 255) / 255
  const b = (value & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 210
  const d = max - min
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

/**
 * The same colour turned `degrees` around the wheel.
 *
 * At a fixed saturation and lightness rather than the original's, which is what
 * makes two rotations of a pale colour and two of a dark one equally
 * distinguishable from each other. The two numbers are `readPalette`'s, kept
 * here so there is one answer to "what does a rotated category look like".
 */
export function rotateHue(colour: string, degrees: number): string {
  return `hsl(${Math.round((hueOf(colour) + degrees) % 360)} 55% 48%)`
}
