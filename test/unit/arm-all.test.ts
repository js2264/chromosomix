/**
 * One picking mode over several maps.
 *
 * A mark is a coordinate and a companion is a map, so every map on screen is a
 * place a reader may point at. What is worth testing is not the fan-out, which
 * is a loop, but the *ending*: each map ends its own mode on Escape or on being
 * torn down and reports that through the `onEnd` it was armed with, so a mode
 * armed on five panels and disarmed on one would leave four of them swallowing
 * clicks the reader meant as navigation. Whatever ends it has to end all of it,
 * once.
 */

import { describe, expect, it } from 'vitest'

import { armAll, type Armable } from '@/ui/mapPick'

/** What a form asks for, in the shape the real cards hand over. */
interface Handlers {
  point?: (at: string) => void
}

/** A map that records how it was armed and can end its own mode, as one does. */
function fake(): Armable<Handlers> & {
  readonly armed: boolean
  readonly cancels: number
  place(point: string): void
  escape(): void
} {
  let onPoint: ((point: string) => void) | null = null
  let onEnd: (() => void) | null = null
  let cancels = 0
  return {
    get armed() {
      return onEnd !== null
    },
    get cancels() {
      return cancels
    },
    place(point) {
      onPoint?.(point)
    },
    escape() {
      const end = onEnd
      onPoint = null
      onEnd = null
      end?.()
    },
    armPicking(handlers, end) {
      onPoint = handlers.point ?? null
      onEnd = end
      return () => {
        cancels++
        onPoint = null
        onEnd = null
      }
    },
  }
}

describe('arming every map at once', () => {
  it('arms all of them, and reports a point from any', () => {
    const maps = [fake(), fake(), fake()]
    const points: string[] = []
    armAll(maps, { point: (at) => points.push(at) }, () => {})
    expect(maps.every((map) => map.armed)).toBe(true)
    maps[2].place('chrIV:1000')
    maps[0].place('chrV:20')
    expect(points).toEqual(['chrIV:1000', 'chrV:20'])
  })

  it('stays armed after a point, because marking up a figure is eight clicks', () => {
    const maps = [fake(), fake()]
    armAll(maps, {}, () => {})
    maps[0].place('a')
    expect(maps.every((map) => map.armed)).toBe(true)
  })

  it('ends everywhere when the card ends it', () => {
    const maps = [fake(), fake(), fake()]
    let ends = 0
    const finish = armAll(maps, {}, () => ends++)
    finish()
    expect(maps.map((map) => map.cancels)).toEqual([1, 1, 1])
    expect(ends).toBe(1)
  })

  it('ends everywhere when *one map* ends it', () => {
    const maps = [fake(), fake(), fake()]
    let ends = 0
    armAll(maps, {}, () => ends++)
    // Escape over the second panel: the other two must not be left armed.
    maps[1].escape()
    expect(maps[0].cancels).toBe(1)
    expect(maps[2].cancels).toBe(1)
    expect(maps.every((map) => !map.armed)).toBe(true)
    expect(ends).toBe(1)
  })

  it('reports the ending exactly once, however many times it is reached', () => {
    const maps = [fake(), fake()]
    let ends = 0
    const finish = armAll(maps, {}, () => ends++)
    maps[0].escape()
    finish()
    finish()
    expect(ends).toBe(1)
    expect(maps[1].cancels).toBe(1)
  })

  it('skips a panel that is still reading, and arms the rest', () => {
    const map = fake()
    let ends = 0
    armAll([null, undefined, map], {}, () => ends++)
    expect(map.armed).toBe(true)
    expect(ends).toBe(0)
  })

  it('ends before it starts when there is no map at all', () => {
    let ends = 0
    const finish = armAll<Handlers>([null, undefined], {}, () => ends++)
    // Which the card reads as "put the button back" — the race where a view was
    // torn down between the button being enabled and being pressed.
    expect(ends).toBe(1)
    expect(() => finish()).not.toThrow()
    expect(ends).toBe(1)
  })
})
