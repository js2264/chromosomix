/**
 * The contigs table as the session and the comparison both read it.
 *
 * Two small readings of one worker answer, and a module of their own only
 * because two classes need them: `Session` asks for names and lengths all over,
 * and `SessionCompare` gates a second file on exactly the same pairs. Kept in
 * either class's file, the other would have to import it back from there, and
 * the session and its collaborators are written so that nothing imports the
 * session at run time.
 */

import type { ContigsResult } from '../worker/protocol'

/**
 * Name and length per chromosome, in file order — what the compare gate reads.
 *
 * Both, because both have to match: a renamed assembly and a re-scaffolded one
 * are different failures and the gate names each of them (`ui/CompareCard.ts`).
 */
export function contigPairs(contigs: ContigsResult | null): Array<[string, number]> {
  const names = contigNames(contigs)
  const lengths = contigs?.table.data['length']
  if (lengths === undefined || Array.isArray(lengths)) return names.map((name) => [name, 0])
  return names.map((name, index) => [name, Number(lengths[index])])
}

/** Contig names from the contigs table, or `[]` if it could not be read. */
export function contigNames(contigs: ContigsResult | null): string[] {
  const column = contigs?.table.data['name']
  return Array.isArray(column) ? (column as string[]) : []
}
