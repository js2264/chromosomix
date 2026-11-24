// @dev-feature curate
/**
 * The contig network (SPECS §33.5): one pass over the stored pixels summed by
 * pair of contigs, each contact once, a contig's own contacts apart — whatever
 * order the rows arrive in and whichever triangles the map stores.
 */

import { describe, expect, it } from 'vitest'
import { binContigs, NetworkBuilder } from '../../src/curate/network'

/** Three contigs: bins 0–1, 2–4, 5. */
const OFFSETS = [0, 2, 5, 6]

function build(pixels: Array<[number, number, number]>, chunk = 2): ReturnType<NetworkBuilder['finish']> {
  const builder = new NetworkBuilder(binContigs(OFFSETS), 3)
  for (let k = 0; k < pixels.length; k += chunk) {
    const part = pixels.slice(k, k + chunk)
    builder.add(
      part.map((p) => p[0]),
      part.map((p) => p[1]),
      part.map((p) => p[2]),
      part.length,
    )
  }
  return builder.finish()
}

/** The network as `i-j:count` and `within`. */
function read(net: ReturnType<NetworkBuilder['finish']>): { pairs: string[]; within: number[] } {
  return { pairs: Array.from(net.first, (a, k) => `${a}-${net.second[k]}:${net.contacts[k]}`), within: [...net.within] }
}

describe('the contig network', () => {
  it('maps each bin to its contig', () => {
    expect([...binContigs(OFFSETS)]).toEqual([0, 0, 1, 1, 1, 2])
  })

  it('sums the pixels between two contigs’ bins, and keeps a contig’s own apart', () => {
    const net = build([
      [0, 0, 5],
      [0, 1, 3],
      [0, 2, 1],
      [1, 4, 2],
      [1, 5, 7],
      [2, 3, 4],
      [3, 5, 1],
      [5, 5, 9],
    ])
    expect(read(net)).toEqual({ pairs: ['0-1:3', '0-2:7', '1-2:1'], within: [8, 4, 9] })
  })

  it('counts a square map’s contacts once, and skips empty or negative counts', () => {
    const net = build([
      [0, 2, 1],
      [2, 0, 1],
      [0, 3, 0],
      [1, 2, -4],
    ])
    expect(read(net).pairs).toEqual(['0-1:1'])
  })

  it('merges a row that arrives after a later one', () => {
    const net = build(
      [
        [2, 5, 1],
        [0, 2, 3],
        [3, 5, 2],
        [1, 3, 4],
      ],
      1,
    )
    expect(read(net).pairs).toEqual(['0-1:7', '1-2:3'])
  })
})
