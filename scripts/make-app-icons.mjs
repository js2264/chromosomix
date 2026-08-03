/**
 * The two PNG icons the install prompt needs, drawn here rather than committed
 * as opaque blobs.
 *
 * Chrome offers "Install app" only for a manifest with real raster icons at 192
 * and 512 — an SVG is accepted by some platforms and quietly ignored by others,
 * and "quietly ignored" means no install button and no explanation. So: PNGs.
 *
 * Written by hand, in about sixty lines, for the same reason the PDF writer is:
 * a PNG of a flat-coloured square is a header, one IDAT of zlib-compressed
 * scanlines and three CRCs, and pulling in an image toolchain to do that
 * arithmetic would be a dependency tree for a fifty-line file. `zlib` is in
 * Node, and the CRC table is the one from the PNG specification.
 *
 * The design is the favicon in `index.html`, at size: the accent-blue field
 * with two white blocks on the diagonal — a contact map's diagonal, which is
 * the one thing every one of these pictures has in common.
 *
 *     node scripts/make-app-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

/** `--accent` from the stylesheet, and the white it sits under. */
const FIELD = [0x1f, 0x5f, 0xa9]
const MARK = [0xff, 0xff, 0xff]

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, data, CRC. */
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * The icon as raw RGB scanlines, each prefixed with filter type 0.
 *
 * Two blocks at a quarter and a half of the side, on the diagonal, with the
 * same proportions as the 16 px favicon — so the tab icon and the dock icon are
 * recognisably one thing.
 */
function pixels(size) {
  const unit = size / 16
  const blocks = [
    { x: 2 * unit, y: 2 * unit, w: 5 * unit, h: 5 * unit },
    { x: 9 * unit, y: 9 * unit, w: 5 * unit, h: 5 * unit },
  ]
  const raw = Buffer.alloc((size * 3 + 1) * size)
  let at = 0
  for (let y = 0; y < size; y++) {
    raw[at++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const inMark = blocks.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)
      const [r, g, b] = inMark ? MARK : FIELD
      raw[at++] = r
      raw[at++] = g
      raw[at++] = b
    }
  }
  return raw
}

function png(size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

import { mkdirSync } from 'node:fs'

for (const size of [192, 512]) {
  const path = new URL(`../public/icon-${size}.png`, import.meta.url)
  writeFileSync(path, png(size))
  console.log(`wrote public/icon-${size}.png`)
}

// The desktop icon, from the same fifty lines that draw the other two — which
// is the whole argument this file already makes, extended one target further: a
// dock icon that disagreed with the tab icon would be two designs maintained by
// hand, and nobody would notice they had drifted.
//
// 1024 because electron-builder derives every platform size from one square
// PNG, and it refuses anything under 256. `build/` is electron-builder's
// `buildResources` directory, which is why it is *not* in `.gitignore` — but
// this file is generated, so `dist:desktop` draws it and only the recipe is
// committed.
mkdirSync(new URL('../build/', import.meta.url), { recursive: true })
writeFileSync(new URL('../build/icon.png', import.meta.url), png(1024))
console.log('wrote build/icon.png')
