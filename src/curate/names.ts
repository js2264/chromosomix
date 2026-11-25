/**
 * Short names (SPECS §33.3): a binner names every bin with one long prefix —
 * `MM133_metator_00001_00000`, `MetaTOR_MGE_00042` — and a list cut to its
 * width shows the part every row shares and hides the part that differs. The
 * stage prints a section's shared prefix once, in its head, and each genome by
 * the rest; its full name stays in every title, export and history.
 */

/**
 * The prefix every name shares, ending at an underscore and at least four
 * characters long, that leaves each name two characters or more: `''` where
 * there is none, or fewer than two names.
 */
export function sharedPrefix(names: readonly string[]): string {
  if (names.length < 2) return ''
  let prefix = names[0]
  for (const name of names) {
    let k = 0
    const end = Math.min(prefix.length, name.length)
    while (k < end && prefix.charCodeAt(k) === name.charCodeAt(k)) k++
    prefix = prefix.slice(0, k)
    if (prefix === '') return ''
  }
  const cut = prefix.lastIndexOf('_')
  if (cut < 3) return ''
  const kept = prefix.slice(0, cut + 1)
  return names.every((name) => name.length - kept.length >= 2) ? kept : ''
}

/** A name without a prefix it starts with; the whole name otherwise. */
export function shortName(name: string, prefix: string): string {
  return prefix !== '' && name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name
}

/**
 * A contig's name as the list prints it: an assembler's name without the
 * length (and coverage) it carries — SPAdes' `NODE_12_length_5678_cov_9.1`,
 * metaSPAdes' `NODE_12_len_5678` print `NODE_12` —, the row saying the length
 * beside it; any other name whole. The whole name stays in the row's title,
 * and a pasted list of the short ones finds them.
 */
export function contigShortName(name: string): string {
  const match = /^(NODE_\d+)_len(?:gth)?_\d+(?:_cov_[\d.]+)?(?:_ID_\d+)?$/.exec(name)
  return match === null ? name : match[1]
}
