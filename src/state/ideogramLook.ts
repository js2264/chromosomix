/**
 * How the ideogram view draws its chromosomes (§5.10), for one open file.
 *
 * What a reader sets in the Tracks card's ideogram rows: how thick a
 * chromosome is drawn, how long the longest one is, the room between two,
 * their colour, what fills them, and whether the tracks beside them are fitted
 * to the window. Which way they
 * run is not here — standing or lying is what is being looked at, and a link
 * carries it (`ideogram=` in the view state) — but how a chromosome is inked is
 * a choice about the picture of this file, kept with the file the way its
 * groups are (`annotations/groups.ts`): in session memory, and in a saved
 * workspace (`SessionConfig.ideogram`).
 *
 * One instance per file, handed to the browser by the session, so the card
 * that writes it and the picture that reads it are told of a change by the same
 * subscription. Stored state outlives the code that wrote it, so what comes
 * back out of memory is read field by field and a field that is not what this
 * knows is its default.
 */

import { recall, remember } from './UiMemory'

/** What a chromosome is filled with — see `render/karyotype.ts`'s `BodyFill`. */
export type IdeogramColourBy =
  /** The cytoBand's stains where one is open, one colour where none is. */
  | 'auto'
  | 'bands'
  | 'one'
  /** A track's or a feature set's entry id. */
  | (string & {})

export interface IdeogramLook {
  /** How thick a chromosome is drawn, in pixels. */
  width: number
  /** How long the longest chromosome is drawn, in pixels; `null` fills the room. */
  length: number | null
  /** The room between two chromosomes, in pixels. */
  gap: number
  /** A chromosome's colour where it is one colour, and the ground under features. */
  colour: string
  colourBy: IdeogramColourBy
  /** The tracks beside each chromosome: fitted to the window, or as tall as in the browser. */
  tracks: 'fit' | 'full'
}

/**
 * Twelve pixels thick and fourteen apart: ideogram.js's ten, made wide enough
 * for a band's stain to read as a colour, with room between two for a curve
 * between them to be seen leaving one. A neutral grey a little darker than the
 * unstained band, so a chromosome with no bands is still a shape on paper.
 */
export const DEFAULT_IDEOGRAM_LOOK: IdeogramLook = {
  width: 12,
  length: null,
  gap: 14,
  colour: '#c4c9d1',
  colourBy: 'auto',
  tracks: 'fit',
}

/** The bounds a typed number is held to. */
export const IDEOGRAM_WIDTH = { min: 4, max: 60 } as const
export const IDEOGRAM_LENGTH = { min: 40, max: 20000 } as const
export const IDEOGRAM_GAP = { min: 0, max: 200 } as const

/** Where the look is remembered, in session memory; `SessionConfig` carries it by this name. */
export const IDEOGRAM_SCOPE = 'browser:ideogram'

/** A stored look, read field by field; anything not understood is the default. */
export function readIdeogramLook(raw: unknown): IdeogramLook {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_IDEOGRAM_LOOK }
  const record = raw as Record<string, unknown>
  const number = (value: unknown, bounds: { min: number; max: number }, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(bounds.min, Math.min(bounds.max, Math.round(value)))
      : fallback
  const colour = record['colour']
  const colourBy = record['colourBy']
  const length = record['length']
  return {
    width: number(record['width'], IDEOGRAM_WIDTH, DEFAULT_IDEOGRAM_LOOK.width),
    length: length === null || length === undefined ? null : number(length, IDEOGRAM_LENGTH, 0) || null,
    gap: number(record['gap'], IDEOGRAM_GAP, DEFAULT_IDEOGRAM_LOOK.gap),
    colour: typeof colour === 'string' && /^#[0-9a-f]{6}$/i.test(colour) ? colour : DEFAULT_IDEOGRAM_LOOK.colour,
    colourBy: typeof colourBy === 'string' && colourBy !== '' ? colourBy : DEFAULT_IDEOGRAM_LOOK.colourBy,
    tracks: record['tracks'] === 'full' ? 'full' : 'fit',
  }
}

export class IdeogramSettings {
  private look: IdeogramLook
  private readonly listeners = new Set<() => void>()

  constructor(private readonly key: string) {
    this.look = readIdeogramLook(recall<unknown>(key, IDEOGRAM_SCOPE))
  }

  get(): IdeogramLook {
    return this.look
  }

  /** Change some of it, held to its bounds, and tell every surface. */
  set(patch: Partial<IdeogramLook>): void {
    const next = readIdeogramLook({ ...this.look, ...patch })
    if (JSON.stringify(next) === JSON.stringify(this.look)) return
    this.look = next
    remember(this.key, IDEOGRAM_SCOPE, next)
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
