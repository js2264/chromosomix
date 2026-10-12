// @vitest-environment jsdom
/**
 * The three logos the other shipped stores are drawn with, and the one
 * property the build step exists to give them.
 *
 * IGV's mark, 4DN's and ENCODE's are the projects' own, carried rather than
 * redrawn. They did not arrive in a shape a tile can use: a tile is a square
 * drawn with `object-fit: cover` (`ui/styles.css`), and ENCODE's badge is half
 * again as wide as it is tall, so `cover` would crop it to the middle of the
 * helix and throw the word *ENCODE* away — the one part of a logo nobody can
 * afford to lose. `scripts/make-store-logos.mjs` fits each to a square ahead of
 * time so that `cover` has nothing left to crop.
 *
 * So what is asserted here is squareness, and that each is opaque. Both are
 * invariants of the fitting rather than facts about the artwork: a logo that
 * came out oblong would be silently cropped in the tile, and one that kept its
 * transparency would show the store's fallback colour through it — which for
 * 4DN means a blue-green disc on a green square.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { STORE_LOGOS } from '@/ui/stores/logos.generated'
import { DBZ_MARK_IMAGE } from '@/ui/stores/dbz-mark.generated'
import { RSG_MARK_IMAGE } from '@/ui/stores/rsg-mark.generated'
import { builtinStores, customStore, hubStoreFront } from '@/ui/stores/registry'
import { storeMark } from '@/ui/stores/marks'
import { resetDevFeatures } from '@/state/devFeatures'

/** The edge `make-store-logos.mjs` fits every mark to. */
const EDGE = 160

/** `IHDR`, which is always the first chunk, so its offset is fixed. */
function header(uri: string) {
  const png = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')
  expect(png.readUInt32BE(0)).toBe(0x89504e47)
  expect(png.toString('ascii', 12, 16)).toBe('IHDR')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colour: png[25] }
}

/** Which store each logo belongs to. */
const WIRING = [
  ['igv', 'igv'],
  ['fourdn', '4dn'],
  ['encode', 'encode'],
  ['dnazoo', 'dnazoo'],
] as const

describe('the store logos', () => {
  // The zoo is a dev feature (§29): drawn here with the switch on.
  beforeEach(() => resetDevFeatures(true))
  afterEach(() => resetDevFeatures())
  it.each(WIRING)('draws %s as an opaque square', (key) => {
    const { width, height, colour } = header(STORE_LOGOS[key])
    expect({ width, height }).toEqual({ width: EDGE, height: EDGE })
    // Colour type 2 is truecolour with no alpha channel: the white ground the
    // logo was fitted on is in the pixels, not left to whatever is behind.
    expect(colour).toBe(2)
  })

  it.each(WIRING)('gives %s to the %s store', (key, id) => {
    const front = builtinStores().find((store) => store.id === id)!
    expect(front.mark.image).toBe(STORE_LOGOS[key])
  })

  it('leaves every shipped store a mark of its own', () => {
    const shipped = builtinStores()
    expect(shipped.map((front) => front.id)).toEqual([
      'rsg',
      'dbz',
      'igv',
      '4dn',
      'encode',
      'dnazoo',
      'roadmap',
    ])
    const images = shipped.map((front) => front.mark.image)
    // All seven present, and seven different pictures — a copy-paste that gave
    // two stores the same logo would otherwise look plausible on the page.
    expect(images.every((image) => image !== undefined)).toBe(true)
    expect(new Set(images).size).toBe(7)
    expect(images[0]).toBe(RSG_MARK_IMAGE)
    expect(images[1]).toBe(DBZ_MARK_IMAGE)
  })

  it('draws the two doors with the marks of what they add', () => {
    // UCSC's own logo on the hub door, which is the one word a reader holding a
    // hub is looking for…
    expect(hubStoreFront().mark.image).toBe(STORE_LOGOS.ucsc)
    // …and this viewer's own icon on the other, whose file is the one format in
    // the grid written *for* this viewer rather than translated into it.
    expect(customStore().mark.image).toBe(STORE_LOGOS.app)
    // Roadmap wears its own emblem, but keeps UCSC's colour underneath: that is
    // what shows if the image fails, and *this is a UCSC hub* is the truer
    // thing to say in that case than a lettermark would be.
    const roadmap = builtinStores().find((front) => front.id === 'roadmap')!
    expect(roadmap.mark.image).toBe(STORE_LOGOS.roadmap)
    expect(roadmap.mark.colour).toBe(hubStoreFront().mark.colour)
  })

  /**
   * The letters behind DNA Zoo's logo, which are what a failed load leaves.
   * `DNAZOO` was tried first and overflows: the ladder in `marks.ts` is tuned
   * so six letters just fill the square, against *ENCODE*, whose letters are
   * the narrow ones.
   */
  it('falls back to the first word of DNA Zoo’s name', () => {
    const dnazoo = builtinStores().find((front) => front.id === 'dnazoo')!
    expect(dnazoo.mark.text).toBe('DNA')
    // Short enough that the square never needs a shorter form of it.
    expect(dnazoo.mark.short).toBeUndefined()
  })

  it('reaches the tile as an image over the letters', () => {
    for (const front of builtinStores()) {
      for (const size of [72, 26]) {
        const node = storeMark(front.mark, size)
        // `undefined` on both sides for DNA Zoo: no image element, and no
        // image to put in one.
        expect(node.querySelector('img')?.getAttribute('src')).toBe(front.mark.image)
      }
    }
    // ENCODE is the one whose word is too long for the small square, so below
    // 40 it sets its short form — behind the image, but it is what a failed
    // load falls back to and it must still fit.
    const encode = builtinStores().find((front) => front.id === 'encode')!
    expect(storeMark(encode.mark, 26).textContent).toBe('ENC')
    expect(storeMark(encode.mark, 72).textContent).toBe('ENCODE')
  })
})
