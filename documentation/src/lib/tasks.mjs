/**
 * The tasks, as the generated data has them (`src/generated/data.json`,
 * written from the registry by `scripts/docs-data.mjs`), for the components.
 */

import data from '../generated/data.json' with { type: 'json' }

export const DATA = data

/** A task by its id, or an error naming the id: a page that cites a task that does not exist is a broken page. */
export function task(id) {
  const found = data.tasks.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no task "${id}" in the registry (src/generated/data.json)`)
  return found
}

/** How a task came out against its reference, as a word and a sentence. */
export function agreementOf(entry) {
  const reference = entry.reference
  if (reference === null) return null
  switch (reference.agreement) {
    case 'identical':
      return { kind: 'identical', word: 'Identical', sentence: 'Identical to its reference in the validation' }
    case 'equivalent':
      return { kind: 'equivalent', word: 'Equivalent', sentence: 'Equivalent to its reference in the validation' }
    default:
      return { kind: 'untested', word: 'Not yet validated', sentence: 'Not yet compared with its reference' }
  }
}
