// @vitest-environment jsdom
/**
 * What the deck calls its maps in the list a track is placed from (§16.10).
 *
 * A map can be renamed from the heading over its cell, and the rule the rename
 * came with is that the name is used *everywhere the map is named, through one
 * function* — `Session.mapLabel`, whose own docstring says "every label on
 * screen goes through here". `PanelDeck.mapList` is the list behind three of
 * those places: the Tracks card's placement control, the Metadata card's, and
 * the Analysis drawer's list of maps.
 *
 * It was written before renaming existed and kept the file name afterwards, so
 * one control showed the reader's name for cell 0 — the lead's row already went
 * through `leadLabel` — and file names for its siblings: "G1" beside
 * `mat_G2M.mcool::1000`, for two maps the reader had just named G1 and G2M, in
 * the same instant that both headings said the right thing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PanelDeck } from '@/panels/PanelDeck'
import { fileLabel } from '@/ui/labels'
import { setUpDom, type DomTeardown } from '../support/dom'

/** A worker that is created, listened to, and never answers. */
class DeadWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

let teardown: DomTeardown
let hadWorker: unknown

beforeEach(() => {
  teardown = setUpDom()
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = DeadWorker
  sessionStorage.clear()
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
})

/**
 * A deck wired the way the session wires one: both label props, both going
 * through the same name table.
 *
 * Keyed on the path before `::`, which is where `ui/mapNames.ts` files a name —
 * so a companion that has descended into an entry of its collection is still
 * found under the file the reader named.
 */
function deckWithNames(names: Record<string, string>): PanelDeck {
  const deck = new PanelDeck({
    onMapsChange: () => {},
    memoryKey: () => 'deck-map-names-test',
    leadName: () => 'G1',
    leadLabel: () => 'G1',
    // `Session.mapLabel`'s own shape: the reader's name, or the file.
    mapLabel: (uri) => names[uri.split('::')[0]] ?? fileLabel(uri),
  })
  document.body.append(deck.el)
  return deck
}

describe('the list of maps a track can be drawn on', () => {
  it('calls a renamed companion what the reader called it', () => {
    const deck = deckWithNames({ 'https://x.example.org/mat_G2M.mcool': 'G2M' })
    deck.add({ kind: 'remote', uri: 'https://x.example.org/mat_G2M.mcool::resolutions/1000' })
    // Both rows through the reader's own names, which is the whole of §16.10:
    // it used to read ['G1', 'mat_G2M.mcool::1000'].
    expect(deck.mapList.map((entry) => entry.label)).toEqual(['G1', 'G2M'])
  })

  it('falls back to the file for a companion nobody has named', () => {
    const deck = deckWithNames({})
    deck.add({ kind: 'remote', uri: 'https://x.example.org/rep2.mcool::resolutions/1000' })
    expect(deck.mapList[1].label).toBe('rep2.mcool::1000')
  })

  it('asks under the address the panel is actually reading', () => {
    // Not the slot's id and not the ref's URI: a rename is filed under the path
    // before `::`, so passing the resolved entry finds the same name while
    // keeping the freshness the row already had.
    const asked: string[] = []
    const deck = new PanelDeck({
      onMapsChange: () => {},
      memoryKey: () => 'deck-map-names-test',
      mapLabel: (uri) => {
        asked.push(uri)
        return 'G2M'
      },
    })
    document.body.append(deck.el)
    deck.add({ kind: 'remote', uri: 'https://x.example.org/mat_G2M.mcool::resolutions/1000' })
    expect(deck.mapList[1].label).toBe('G2M')
    expect(asked).toContain('https://x.example.org/mat_G2M.mcool::resolutions/1000')
  })
})
