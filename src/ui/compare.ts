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

/** The half of {@link CompareRead} the heatmap panel is given. */
export function presentationOf(compare: CompareRead | undefined): ComparePresentation | undefined {
  if (compare === undefined) return undefined
  return {
    labels: compare.labels,
    normalise: compare.normalise,
    onNormaliseChange: (on) => compare.onNormaliseChange(on),
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
  compare: CompareRead | undefined,
  read: (client: ReaderClient) => Promise<MatrixResult>,
): Promise<MatrixResult | undefined> {
  if (compare === undefined) return undefined
  try {
    return await read(compare.client)
  } catch (err) {
    compare.onFailure(
      `${compare.labels[1]} could not answer this view: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return undefined
  }
}
