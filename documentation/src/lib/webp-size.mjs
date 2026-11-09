/**
 * A WebP's size read from its first bytes, with nothing to install: the site's
 * build reads it for every picture (`screens.mjs`), and the repository's own
 * suite tests it without the site's packages.
 */

/**
 * A WebP's width in pixels, read from its header, or `null` for a file that is
 * not one: the lossy (`VP8 `), the lossless (`VP8L`) and the extended (`VP8X`)
 * layouts, which are the three a WebP can open with.
 */
export function webpWidth(bytes) {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') return bytes.readUInt16LE(26) & 0x3fff
  if (chunk === 'VP8L') return (bytes.readUInt32LE(21) & 0x3fff) + 1
  if (chunk === 'VP8X') return bytes.readUIntLE(24, 3) + 1
  return null
}
