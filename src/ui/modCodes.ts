/**
 * Which base-modification codes a BAM's rows have met, for the settings card.
 *
 * The card is built from the store and a row's codes are a fact about the
 * *reads*, which only the lanes hold: a pile's calls (`ReadPile.mods`) and a
 * depth row's fraction (`TrackSampleSet.mods`) each name the codes their
 * window carried. The lanes report them here as they draw, and the picker
 * listens — so it offers the modifications this file actually has rather than
 * the spec's whole table, and grows as the reader pans onto a read with
 * another one.
 *
 * Kept per entry and only ever added to: a code met once is still in the file
 * when the view moves off it, and a select whose options came and went under
 * the reader's pan would be a control that changes by itself.
 */

const seen = new Map<string, string[]>()
const listeners = new Set<(entry: string) => void>()

/** Record codes a lane met; tells the pickers only when something is new. */
export function noteModCodes(entry: string, codes: readonly string[]): void {
  if (codes.length === 0) return
  const held = seen.get(entry) ?? []
  const fresh = codes.filter((code) => !held.includes(code))
  if (fresh.length === 0) return
  seen.set(entry, [...held, ...fresh])
  for (const listener of listeners) listener(entry)
}

/** Every code met on this entry so far, in the order they were met. */
export function modCodesOf(entry: string): string[] {
  return seen.get(entry) ?? []
}

/** Be told when an entry meets a new code. Returns the unsubscribe. */
export function onModCodes(listener: (entry: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
