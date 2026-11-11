/**
 * What a view needs to read the *second* file.
 *
 * The two reads are the same request against two workers, which is the whole
 * reason comparing costs so little: the compatibility gate has already
 * established that the files share a contig list and a bin size, so a block
 * addressed in one is the same block in the other, and no coordinate has to be
 * translated between them.
 *
 * The second read is allowed to fail without taking the view with it. A cooler
 * that is missing a weight column cannot answer a balanced request, and a link
 * may point at a file that has moved; in both cases the map is still a map of
 * the first file, so it is drawn and the reason is reported on the compare card
 * rather than replacing the picture with an error screen.
 */

import type { ReaderClient } from '../worker/client'
import type { MatrixResult } from '../worker/protocol'
import type { ComparePresentation } from './MatrixPanel'

export interface CompareRead extends ComparePresentation {
  /** The second file's reader — a worker of its own, like every other file's. */
  client: ReaderClient
  /** The second read failed; the map falls back to one file and says why. */
  onFailure(message: string): void
}

/**
 * A second read of the **open** file, for the lower triangle's own reading
 * (§5.10) where its score is another `/pixels` column or the balancing the
 * other way: the same questions as the first read, with those two answered
 * differently. Where its score reads the same cells there is no second read,
 * and the map derives both triangles from the one block.
 */
export interface LowerRead {
  /** The file's own reader, asking with the lower reading's balancing and column. */
  client: Pick<ReaderClient, 'request'>
  /** The read failed; the map draws one reading over the whole square and says why. */
  onFailure(message: string): void
}

/**
 * A reader that asks every question with another balancing and column — the
 * lower reading's (§5.10) — and otherwise is the one it wraps, cache and all.
 */
export function rereading(
  client: ReaderClient,
  read: { balance: boolean; value?: string },
): Pick<ReaderClient, 'request'> {
  return {
    request: (payload, onProgress) => {
      const asked = { ...payload } as typeof payload & { balance?: boolean; value?: string }
      if ('balance' in asked) asked.balance = read.balance
      if (read.value === undefined) delete asked.value
      else asked.value = read.value
      return client.request(asked, onProgress)
    },
  }
}

/** The half of {@link CompareRead} the heatmap panel is given. */
export function presentationOf(compare: CompareRead | undefined): ComparePresentation | undefined {
  if (compare === undefined) return undefined
  return {
    labels: compare.labels,
    op: compare.op,
    onOpChange: (op) => compare.onOpChange(op),
  }
}

/**
 * The same block from the second file, or `undefined` where there is no second
 * file or it could not answer.
 *
 * A thunk rather than a request object, because the request types are a
 * discriminated union and passing one through a generic loses the discriminant
 * — the same reason `WholeView` writes its three reads out rather than building
 * one call over a union.
 */
export async function secondBlock(
  compare: CompareRead | LowerRead | undefined,
  read: (client: Pick<ReaderClient, 'request'>) => Promise<MatrixResult>,
): Promise<MatrixResult | undefined> {
  if (compare === undefined) return undefined
  try {
    return await read(compare.client)
  } catch (err) {
    const who = 'labels' in compare ? compare.labels[1] : 'The lower triangle’s score'
    compare.onFailure(
      `${who} could not answer this view: ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }
}
