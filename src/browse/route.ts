/**
 * What a file is, judged by its name alone.
 *
 * `Session.routeOf` has decided this since the day a second file could be
 * dropped, and it stayed private while one caller asked. A folder view is the
 * second: it draws a row per name in a directory nobody has opened, so it has to
 * answer *would this do anything* before any byte is read — and answering it
 * with a second regular expression somewhere else is how a `.bedpe` comes to be
 * loadable by dropping and greyed out in a list.
 *
 * So the rule moved here and the session calls it. One table, three answers.
 *
 * ## Why a name and not the bytes
 *
 * Because the bytes are the thing this is avoiding. A folder of two hundred
 * entries would be two hundred reads to draw a list, over a network for a
 * bucket, and the answer would still be wrong for the file whose extension lies.
 * The application already routes by name everywhere else — `Session.dropped`
 * sends a `.cool` to the map and a `.bw` to the tracks without opening either —
 * and the format detection that *does* read bytes (§3.1) runs after, where it
 * can refuse with a message.
 *
 * `unknown` is therefore "this app has no route for that name", not "this file is
 * broken". A row saying so is more use than a row that is absent: a reader
 * looking at a directory wants to see the directory, and a `.bam` sitting there
 * unhighlighted answers *why is nothing happening when I click it* before it is
 * asked.
 */

import { splitUri } from '../ui/labels'

/** Which of the app's two front doors a name belongs to, or neither. */
export type FileRoute = 'map' | 'genome' | 'unknown'

/**
 * Route a URI or a bare file name.
 *
 * Takes the last path segment, so a full URL, a `::entries/rep1` URI and a plain
 * name all answer the same — and splits on both separators, because a Windows
 * path reaches this from a dropped file's `name` on that platform.
 */
export function routeOf(uri: string): FileRoute {
  const name = splitUri(uri).path.split(/[\\/]/).pop() ?? uri
  if (/\.(m?cool|m?metacool|hic|h5|hdf5)$/i.test(name)) return 'map'
  if (
    /\.(bw|bigwig|bb|bigbed|chrom\.sizes|sizes|genome|fai|fa|fasta|fna|fas|gtf|gff3?|bed|bedpe|narrowPeak|broadPeak|gappedPeak)(\.gz)?$/i.test(
      name,
    )
  ) {
    return 'genome'
  }
  // A BAM annotates a genome and can declare one, so it is the same door as a
  // bigWig (§8.13) — even though, unlike every other name on that list, it may
  // yet be refused for want of an index. Routing is about which front door a
  // name belongs to; whether the file behind it opens is settled by its bytes,
  // where a refusal can carry a message.
  if (/\.bam$/i.test(name)) return 'genome'
  return 'unknown'
}

/**
 * A one-line reason a row is not offered, or `null` when it is.
 *
 * Written where the routing is, so the list and the router cannot come to
 * disagree about which names do nothing.
 */
export function unroutableNote(name: string): string | null {
  if (routeOf(name) !== 'unknown') return null
  if (/\.tbi$/i.test(name)) {
    return 'A tabix index. Load the file it indexes and this is picked up with it.'
  }
  if (/\.(bai|csi)$/i.test(name)) {
    // Worth its own sentence rather than falling into the line below, because a
    // reader looking at a `.bai` greyed out beside a `.bam` is one step from
    // concluding the pair cannot be opened at all.
    return 'A BAM index. Load the .bam it indexes and this is picked up with it.'
  }
  if (/\.cram$/i.test(name)) {
    return 'CRAM needs its exact reference genome, which this viewer will not fetch. Convert it with `samtools view -b`.'
  }
  return 'Not a format this viewer opens.'
}
