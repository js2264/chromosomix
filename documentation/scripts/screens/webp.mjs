/**
 * One screenshot of the app, made a picture for the documentation: cropped
 * where asked, no wider than the column needs at twice its density, and
 * written as WebP — a tenth of the PNG, which matters in a repository that
 * keeps every picture of every page.
 *
 *   node documentation/scripts/screens/webp.mjs <in.png> <out.webp> [x,y,width,height] [max-width]
 *
 * The crop is in the PNG's own pixels. The pictures are captured by the
 * scripts beside this one, each driving the real app (`npm run dev`) as
 * `scripts/ui-gallery.mjs` does, and are kept under
 * `documentation/src/assets/screens/`, where the pages' Markdown names them and
 * Astro serves them resized.
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '..', '..', 'package.json'))
const sharp = require('sharp')

/** Write `input` as a WebP at `output`, cropped to `crop` and at most `maxWidth` wide. */
export async function toWebp(input, output, { crop = null, maxWidth = 1800, quality = 80 } = {}) {
  mkdirSync(dirname(output), { recursive: true })
  let image = sharp(input)
  if (crop !== null) image = image.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
  const info = await image
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality, effort: 5 })
    .toFile(output)
  return info
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [input, output, cropArg, widthArg] = process.argv.slice(2)
  if (input === undefined || output === undefined) {
    console.error('usage: webp.mjs <in.png> <out.webp> [x,y,width,height] [max-width]')
    process.exit(2)
  }
  const crop =
    cropArg === undefined || cropArg === '' || cropArg === '-'
      ? null
      : (([x, y, width, height]) => ({ x, y, width, height }))(cropArg.split(',').map(Number))
  const info = await toWebp(input, output, { crop, maxWidth: widthArg === undefined ? 1800 : Number(widthArg) })
  console.log(`${output}: ${info.width}×${info.height}, ${(info.size / 1024).toFixed(0)} KB`)
}
