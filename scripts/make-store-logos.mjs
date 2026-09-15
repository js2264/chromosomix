/**
 * Generate `src/ui/stores/logos.generated.ts` from the three logos the labs
 * gave us: IGV's, 4DN's and ENCODE's.
 *
 *     npm run icons:stores
 *
 * ## What it reads, and why that is not in the repository
 *
 * The files `LOGOS` names, at the root, supplied by hand. They are inputs
 * rather than sources: the file this writes is the artefact of record, and
 * they are removed once it is written, so a re-run means putting them back.
 *
 * PNG, and only PNG — `decode` below is not a general image reader and says so
 * rather than guessing. DNA Zoo's was supplied as a JPEG, and a logo that
 * arrives in another format is converted once before it is put here; this
 * script is not the place for a second decoder. That is deliberate — the marks below are published
 * artwork belonging to the projects they name, carried here because this
 * viewer was given them to carry, and the repository holds one copy of each
 * (the fitted mark) rather than two. If a logo changes, replace the file,
 * re-run, and commit what moves.
 *
 * ## Why they are fitted rather than used as they arrived
 *
 * A tile is a square and none of these three is (`ui/stores/marks.ts`). The
 * CSS draws the image with `object-fit: cover`, which on a mark that is not
 * square crops it — and the part of a logo that a square crop throws away is
 * usually its wordmark. So each is fitted here instead, once, at build time:
 *
 * - **ENCODE** is the case that forces it, 170x102 and so half again as wide
 *   as it is tall. `cover` would take both ends off the helix and the word
 *   with them. It is letterboxed, which costs height — the badge occupies
 *   about three fifths of the tile — and keeps the whole logo.
 * - **4DN** is square already, but it is a disc on transparency, and behind it
 *   sits `COLOURS.fourdn`. A green-blue gradient on a green square is mud. It
 *   is composited on white, which is the ground the logo is drawn for.
 * - **IGV** is square and opaque, a finished app icon, and comes through at
 *   full bleed with nothing added.
 * - **DNA Zoo** is ENCODE's case again and wider still, a helix nearly twice
 *   as wide as it is tall, so it is letterboxed on the same white.
 *
 * White for the other two because these are logos drawn for paper, and because
 * baking it in means the tiles look the same in both themes rather than one of
 * them going muddy in the dark. The store's colour stays underneath as the
 * fallback the letters are drawn on if an image ever fails to load.
 *
 * ## Why a data URI, again
 *
 * The same reason `make-rsg-mark.mjs` gives: `public/` is not emitted by the
 * standalone build (`vite.standalone.config.ts` sets `publicDir: false`), so a
 * file there is a hole in the one build with no server to ask. A committed
 * constant is in every target, costs no request, and a CSP that blocks remote
 * images cannot block it.
 */

import { deflateSync, inflateSync, crc32 } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The square each mark is fitted into, in pixels.
 *
 * The largest a tile is drawn is 72 CSS pixels (`ui/stores/tiles.ts`), so this
 * is a shade over twice that: enough for a 2x screen with room to spare, and
 * not so much that three logos weigh more than the code around them.
 */
const EDGE = 160

/** What is read, what it is called in the generated file, and its store. */
const LOGOS = [
  { file: 'IGV.png', key: 'igv', store: 'IGV genomes' },
  { file: '4DN.png', key: 'fourdn', store: '4DN' },
  { file: 'ENCODE.png', key: 'encode', store: 'ENCODE' },
  { file: 'DnaZoo.png', key: 'dnazoo', store: 'DNA Zoo' },
]

// --- reading a PNG ---------------------------------------------------------

/** Every chunk of one type, concatenated — IDAT arrives split. */
function chunks(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  const out = new Map()
  let off = 8
  while (off < png.length) {
    const length = png.readUInt32BE(off)
    const type = png.toString('ascii', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + length)
    out.set(type, out.has(type) ? Buffer.concat([out.get(type), data]) : data)
    off += 12 + length
  }
  return out
}

/** Paeth's predictor, as the spec defines it. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Samples per pixel, by PNG colour type. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/**
 * Decode an 8-bit, non-interlaced PNG to `{ width, height, rgba }`.
 *
 * Not a general decoder, and it says so rather than guessing: 16-bit samples
 * and Adam7 are rejected by name, because a logo silently coming out as noise
 * is worse than a build that stops and says which file to re-save.
 */
function decode(png) {
  const parts = chunks(png)
  const ihdr = parts.get('IHDR')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const depth = ihdr[8]
  const colour = ihdr[9]
  if (depth !== 8) throw new Error(`${depth}-bit PNG; re-save it as 8-bit`)
  if (ihdr[12] !== 0) throw new Error('interlaced PNG; re-save it non-interlaced')
  const channels = CHANNELS[colour]
  if (channels === undefined) throw new Error(`unknown PNG colour type ${colour}`)

  // Undo the per-row filters. `stride` is the row in bytes; `back` is how far
  // left the "same sample of the previous pixel" is, which is what the Sub,
  // Average and Paeth predictors mean by *a*.
  const stride = width * channels
  const raw = inflateSync(parts.get('IDAT'))
  const flat = new Uint8Array(stride * height)
  const back = channels
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= back ? flat[y * stride + x - back] : 0
      const above = y > 0 ? flat[(y - 1) * stride + x] : 0
      const upperLeft = y > 0 && x >= back ? flat[(y - 1) * stride + x - back] : 0
      const predictor =
        type === 0 ? 0
        : type === 1 ? left
        : type === 2 ? above
        : type === 3 ? (left + above) >> 1
        : paeth(left, above, upperLeft)
      flat[y * stride + x] = (row[x] + predictor) & 0xff
    }
  }

  // Widen whatever the samples were to straight RGBA.
  const palette = parts.get('PLTE')
  const alpha = parts.get('tRNS')
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const s = i * channels
    const o = i * 4
    if (colour === 3) {
      const p = flat[s] * 3
      rgba[o] = palette[p]
      rgba[o + 1] = palette[p + 1]
      rgba[o + 2] = palette[p + 2]
      rgba[o + 3] = alpha !== undefined && flat[s] < alpha.length ? alpha[flat[s]] : 255
    } else if (colour === 0 || colour === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = flat[s]
      rgba[o + 3] = colour === 4 ? flat[s + 1] : 255
    } else {
      rgba[o] = flat[s]
      rgba[o + 1] = flat[s + 1]
      rgba[o + 2] = flat[s + 2]
      rgba[o + 3] = colour === 6 ? flat[s + 3] : 255
    }
  }
  return { width, height, rgba }
}

// --- fitting it to the tile ------------------------------------------------

/**
 * Composite straight RGBA over white, giving RGB.
 *
 * Done before the resample rather than after, so the resample never averages
 * colour across a transparent edge — where the colour under `alpha = 0` is
 * usually black, and averaging it in draws a dark fringe round the logo.
 */
function overWhite({ width, height, rgba }) {
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3] / 255
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(rgba[i * 4 + c] * a + 255 * (1 - a))
  }
  return rgb
}

/**
 * Area-average resample: each destination pixel is the mean of the source it
 * covers, weighted by how much of each it covers.
 *
 * The box filter and not a nearest sample, because every one of these is being
 * reduced — 256 or 300 pixels down to 160 — and dropping three pixels in five
 * off an icon with 1px rules in it produces exactly the shimmer a logo must
 * not have.
 */
function resample(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 3)
  for (let y = 0; y < dh; y++) {
    const top = (y * sh) / dh
    const bottom = ((y + 1) * sh) / dh
    for (let x = 0; x < dw; x++) {
      const left = (x * sw) / dw
      const right = ((x + 1) * sw) / dw
      let r = 0
      let g = 0
      let b = 0
      let total = 0
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
        const hy = Math.min(bottom, sy + 1) - Math.max(top, sy)
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const area = hy * (Math.min(right, sx + 1) - Math.max(left, sx))
          const s = (sy * sw + sx) * 3
          r += src[s] * area
          g += src[s + 1] * area
          b += src[s + 2] * area
          total += area
        }
      }
      const o = (y * dw + x) * 3
      out[o] = Math.round(r / total)
      out[o + 1] = Math.round(g / total)
      out[o + 2] = Math.round(b / total)
    }
  }
  return out
}

/** The logo on an `EDGE`-square white ground, scaled to fit and centred. */
function fit(image) {
  const scale = Math.min(EDGE / image.width, EDGE / image.height)
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const inner = resample(overWhite(image), image.width, image.height, width, height)
  const canvas = new Uint8Array(EDGE * EDGE * 3).fill(255)
  const left = Math.round((EDGE - width) / 2)
  const top = Math.round((EDGE - height) / 2)
  for (let y = 0; y < height; y++) {
    canvas.set(inner.subarray(y * width * 3, (y + 1) * width * 3), ((y + top) * EDGE + left) * 3)
  }
  return { canvas, width, height }
}

// --- writing a PNG ---------------------------------------------------------

/** One PNG chunk: length, type, payload, CRC. */
function chunk(type, payload) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])) >>> 0, 0)
  return Buffer.concat([head, payload, crc])
}

/** Filter the scanlines, picking per row by the spec's own heuristic. */
function filtered(pixels, stride) {
  const rows = []
  const prev = new Uint8Array(stride)
  for (let y = 0; y < EDGE; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    let best = null
    for (let type = 0; type < 5; type++) {
      const out = Buffer.alloc(stride + 1)
      out[0] = type
      let score = 0
      for (let x = 0; x < stride; x++) {
        const left = x >= 3 ? row[x - 3] : 0
        const above = prev[x]
        const upperLeft = x >= 3 ? prev[x - 3] : 0
        const predictor =
          type === 0 ? 0
          : type === 1 ? left
          : type === 2 ? above
          : type === 3 ? (left + above) >> 1
          : paeth(left, above, upperLeft)
        const byte = (row[x] - predictor) & 0xff
        out[x + 1] = byte
        score += byte < 128 ? byte : 256 - byte
      }
      if (best === null || score < best.score) best = { score, out }
    }
    rows.push(best.out)
    prev.set(row)
  }
  return Buffer.concat(rows)
}

/** The fitted mark as opaque truecolour PNG bytes. */
function png(canvas) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(EDGE, 0)
  ihdr.writeUInt32BE(EDGE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour, no alpha — the ground is baked in
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered(canvas, EDGE * 3), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- the file --------------------------------------------------------------

const marks = LOGOS.map(({ file, key, store }) => {
  let source
  try {
    source = readFileSync(join(root, file))
  } catch {
    throw new Error(
      `${file} is not at the repository root. The three logos are supplied by ` +
        `hand and are not committed — see this script's header. Put ${file} back ` +
        `and re-run.`,
    )
  }
  const image = decode(source)
  const { canvas, width, height } = fit(image)
  const bytes = png(canvas)
  console.log(
    `${file}: ${image.width}x${image.height} -> ${width}x${height} on ${EDGE} square, ` +
      `${bytes.length} B (${store})`,
  )
  return { key, store, uri: `data:image/png;base64,${bytes.toString('base64')}` }
})

const entries = marks
  .map(({ key, store, uri }) => `  /** ${store}. */\n  ${key}:\n    '${uri}',`)
  .join('\n')

writeFileSync(
  join(root, 'src/ui/stores/logos.generated.ts'),
  `/**
 * The logos the other three shipped stores are drawn with, as data URIs.
 *
 * Generated — run \`npm run icons:stores\` after replacing one of the source
 * files, which \`scripts/make-store-logos.mjs\` names and which are not
 * committed. Each is the project's own published mark, fitted to a ${EDGE}-pixel
 * square on white so that a tile can draw it without cropping the wordmark off
 * a logo that is wider than it is tall.
 *
 * RSG's mark is not here: it is drawn rather than given, and lives in
 * \`rsg-mark.generated.ts\`.
 */
export const STORE_LOGOS = {
${entries}
} as const
`,
)
console.log('src/ui/stores/logos.generated.ts written')
