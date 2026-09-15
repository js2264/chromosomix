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
/**
 * The route of a file whose address may not say, with a name that does.
 *
 * A Drive file is addressed by an id (`…/files/<id>?alt=media`) and a Dropbox
 * file by a temporary link, and neither ends in the file's name — so the
 * backend that listed it hands the name along (§24.9), and the name decides
 * the door where the address cannot. The address wins where it does say,
 * because the address is what will be read: a store row labelled *the ATAC
 * track* whose URL ends in `.mcool` is a map.
 */
export function routeFor(uri: string, label?: string): FileRoute {
  const byAddress = routeOf(uri)
  if (byAddress !== 'unknown' || label === undefined) return byAddress
  return routeOf(label)
}

export function routeOf(uri: string): FileRoute {
  // The last path segment, with the query and the fragment taken off it.
  // Neither is part of a name, and both reach here: a bucket URL carries a
  // query string, and a HiC-Pro pair names its bin file in a `#bins=` fragment
  // (§3.9) — which ends in `.bed`, and routed the *matrix* to the genome door.
  const name = (splitUri(uri).path.split(/[\\/]/).pop() ?? uri).split(/[?#]/)[0]
  if (/\.([ms]?cool|m?metacool|hic|h5|hdf5)$/i.test(name)) return 'map'
  // A `.pairs` is a contact list rather than a matrix, and it still belongs at
  // the map's door: what comes out of it is a map, after one question the file
  // cannot answer for itself (§3.7). Routing is about which front door a name
  // belongs to, and this one's is not the browser's.
  if (/\.pairs(\.gz)?$/i.test(name)) return 'map'
  // A HiC-Pro matrix, which is a contact map made of two text files (§3.9). The
  // `.bed` beside it stays on the genome door: it is a valid BED as well as a
  // bin grid, and which of the two it is depends on what it was dropped with.
  if (/\.matrix(\.gz)?$/i.test(name)) return 'map'
  if (
    /\.(bw|bigwig|bb|bigbed|chrom\.sizes|sizes|genome|fai|fa|fasta|fna|fas|gtf|gff3?|bed|bedpe|narrowPeak|broadPeak|gappedPeak|vcf|bdg|bedgraph|wig)(\.gz)?$/i.test(
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
  if (/\.px2$/i.test(name)) {
    return 'A pairix index. Load the .pairs.gz it indexes and this is picked up with it.'
  }
  if (/\.cram$/i.test(name)) {
    return 'CRAM needs its exact reference genome, which this viewer will not fetch. Convert it with `samtools view -b`.'
  }
  return 'Not a format this viewer opens.'
}
