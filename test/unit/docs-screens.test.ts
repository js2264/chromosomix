/**
 * The documentation's pictures (SPECS §32.4, `documentation/src/lib/screens.mjs`):
 * the header read that holds each to the size the app drew it, and the rules a
 * picture keeps — a WebP, light enough for a page, and on a page.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { webpWidth } from '../../documentation/src/lib/webp-size.mjs'

const DOCS = join(__dirname, '..', '..', 'documentation', 'src')
const SCREENS = join(DOCS, 'assets', 'screens')

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  )

/** A WebP's first 30 bytes: `RIFF`, a size, `WEBP`, then a chunk of the given layout. */
function header(chunk: string, fill: (bytes: Buffer) => void): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(22, 4)
  bytes.write('WEBP', 8, 'ascii')
  bytes.write(chunk, 12, 'ascii')
  fill(bytes)
  return bytes
}

describe('a picture’s width', () => {
  it('is read from each of the three layouts a WebP opens with', () => {
    // Lossy: the frame's 14-bit width after its start code, its top two bits the scale.
    expect(webpWidth(header('VP8 ', (b) => b.writeUInt16LE(0xc000 | 1440, 26)))).toBe(1440)
    // Lossless: the width less one in the 14 bits after the signature byte.
    expect(webpWidth(header('VP8L', (b) => b.writeUInt32LE((900 - 1) | ((500 - 1) << 14), 21)))).toBe(900)
    // Extended: the canvas's width less one, in 24 bits.
    expect(webpWidth(header('VP8X', (b) => b.writeUIntLE(2880 - 1, 24, 3)))).toBe(2880)
  })

  it('is no width at all for a file that is not a WebP', () => {
    expect(webpWidth(Buffer.from('\x89PNG\r\n\x1a\n' + '\0'.repeat(30), 'binary'))).toBeNull()
    expect(webpWidth(Buffer.alloc(8))).toBeNull()
  })
})

describe('the documentation’s pictures', () => {
  const pictures = walk(SCREENS)
  const pages = walk(join(DOCS, 'content', 'docs')).filter((path) => /\.mdx?$/.test(path))
  const cited = new Set(
    pages.flatMap((page) => Array.from(readFileSync(page, 'utf8').matchAll(/assets\/screens\/([^)\s"']+)/g), (match) => match[1])),
  )

  it('are WebP the build can size, and light enough for a page', () => {
    expect(pictures.length).toBeGreaterThan(0)
    for (const picture of pictures) {
      const name = relative(SCREENS, picture)
      expect(name, name).toMatch(/\.webp$/)
      expect(webpWidth(readFileSync(picture)), name).toBeGreaterThanOrEqual(200)
      expect(statSync(picture).size, name).toBeLessThanOrEqual(300 * 1024)
    }
  })

  it('are each on a page', () => {
    for (const picture of pictures) {
      const name = relative(SCREENS, picture).split('\\').join('/')
      expect(cited.has(name), `${name} is on no page`).toBe(true)
    }
  })
})
