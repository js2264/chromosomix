/**
 * The sidecar index beside a file, and the rules for pairing the two.
 *
 * Its own module, and small on purpose. Three things need these rules and they
 * sit in three different layers: the annotations loader, which pairs a drop;
 * `app/Session`, which routes one; and `browse/local`, which picks a file out
 * of a connected folder and should hand over the index sitting next to it.
 * Leaving them in `annotations/loader.ts` meant the folder browser importing
 * the loader — and with it the store, the worker client and a UI module — to
 * ask what a `.bai` is called.
 *
 * Nothing here touches the DOM, a worker, or anything but names and `File`s.
 */

/**
 * Split `<url>#index=<url>` into the two URLs it names.
 *
 * The one place a reader can say where an index really is, and it exists
 * because the guess cannot always be made: `<url>.bai` is meaningless against a
 * presigned URL, against one carrying a query string, and against any bucket
 * that publishes its index under a different key. A fragment rather than a
 * second input box, because a URL is what gets pasted into chat, into a
 * notebook and into this app's own box — so the pair travels as one string or
 * it does not travel (§8.13).
 *
 * The fragment is stripped from the address, since a `#` is never sent to a
 * server and leaving it on would only make the name shown for the file wrong.
 */
export function splitIndexFragment(url: string): { address: string; index?: string } {
  const at = url.indexOf('#index=')
  if (at < 0) return { address: url }
  const index = url.slice(at + '#index='.length).trim()
  const address = url.slice(0, at)
  if (index === '') return { address }
  // A malformed percent-escape throws `URIError`, and this runs inside the URL
  // box's submit handler where nothing catches it: one stray `%` and the box
  // stops responding with no message anywhere. The escaped form is a courtesy
  // for URLs carrying their own `&` and `#`; a string that will not decode is
  // taken as written, which is what a reader who typed it meant.
  try {
    return { address, index: decodeURIComponent(index) }
  } catch {
    return { address, index }
  }
}

/**
 * Split `<url>#bins=<url>` into the two URLs it names.
 *
 * The HiC-Pro twin of {@link splitIndexFragment}, and it exists for the same
 * reason: the guess cannot always be made. A presigned matrix URL, one carrying
 * a query string, or a bucket that publishes the two halves under unrelated
 * keys all defeat the convention, and a pair that cannot travel as one string
 * cannot be shared at all (§11).
 */
export function splitBinsFragment(url: string): { address: string; bins?: string } {
  const at = url.indexOf('#bins=')
  if (at < 0) return { address: url }
  const bins = url.slice(at + '#bins='.length).trim()
  const address = url.slice(0, at)
  if (bins === '') return { address }
  try {
    return { address, bins: decodeURIComponent(bins) }
  } catch {
    return { address, bins }
  }
}

/**
 * The sidecar suffixes this app pairs with the file they index.
 *
 * `.tbi` indexes a bgzipped text file and is opportunistic — the file opens
 * without it (§8.11). `.px2` indexes a `.pairs.gz` and is opportunistic in the
 * same sense (§3.7): with one the import's cost is known before it starts and
 * can be scoped, without one the file is read whole. `.bai` and `.csi` index a
 * BAM and are neither: there is no whole-file fallback at §12's budgets, so the
 * pair is the unit, and a BAM arriving without its index is refused by name
 * (§8.13). One regular expression for all four, because *pairing* is the same
 * gesture whichever it is; what differs is only what happens when the pairing
 * fails.
 */
const INDEX_SUFFIX = /\.(tbi|bai|csi|px2)$/i

/**
 * The bin file beside a HiC-Pro matrix (§3.8).
 *
 * A fourth kind of companion, paired by the same gesture as the three above and
 * for the reason the comment on {@link INDEX_SUFFIX} gives: what differs
 * between them is only what happens when the pairing fails. This one fails
 * hardest — a `.tbi` is an optimisation and a `.bai` is a format's only bounded
 * read, but an `_abs.bed` is the matrix's **coordinate system**, so without it
 * there is not a slower map or a refused one but no map at all.
 *
 * Deliberately narrow. An ordinary BED must not be captured by this, or a
 * feature file dropped beside a contact map would be silently swallowed as its
 * bins; HiC-Pro's own `<prefix>_<res>_abs.bed` is the only spelling matched,
 * and a lone one still opens as the track it also is.
 */
const HICPRO_BINS = /_abs\.bed(\.gz)?$/i

/** The matrix half of a HiC-Pro pair, by name. */
export function isHicProMatrix(name: string): boolean {
  return /\.matrix(\.gz)?$/i.test(name)
}

/** Whether this file is a sidecar index rather than something to draw. */
export function isIndexName(name: string): boolean {
  return INDEX_SUFFIX.test(name) || HICPRO_BINS.test(name)
}

/**
 * The names a sidecar could be the index for.
 *
 * Two, because `samtools index` writes both spellings: `reads.bam.bai` beside
 * `reads.bam`, and — with an explicit output path, which is what every pipeline
 * that renames its outputs does — `reads.bai`. A reader who drops the pair they
 * have must not have to know which convention produced it.
 */
export function basesForIndex(name: string): string[] {
  if (HICPRO_BINS.test(name)) return hicProMatrixNames(name)
  const stem = name.replace(INDEX_SUFFIX, '')
  return /\.(bai|csi)$/i.test(name) && !/\.bam$/i.test(stem)
    ? [stem, `${stem}.bam`]
    : [stem]
}

/**
 * The matrices a `<prefix>_<res>_abs.bed` could belong to.
 *
 * Four spellings, and each is a real HiC-Pro output: the raw matrix beside the
 * bed in `raw/<res>/`, the ICE-normalised one in `iced/<res>/` which carries an
 * `_iced` before its extension, and either of them gzipped. The bed is written
 * once per resolution and both matrices share it, which is why a reader may
 * drop the bed with whichever of the two they meant.
 */
function hicProMatrixNames(bins: string): string[] {
  const stem = bins.replace(HICPRO_BINS, '')
  return [`${stem}.matrix`, `${stem}_iced.matrix`, `${stem}.matrix.gz`, `${stem}_iced.matrix.gz`]
}

/**
 * The bin file a HiC-Pro matrix needs, by name, most likely first.
 *
 * The reverse of {@link hicProMatrixNames}, and the road a matrix dropped or
 * linked **alone** takes: the same rule §8.11 uses to find a `<url>.tbi` beside
 * the file it indexes, applied to a companion that is not optional.
 */
export function hicProBinsNames(matrix: string): string[] {
  const stem = matrix.replace(/\.matrix(\.gz)?$/i, '').replace(/_iced$/i, '')
  return [`${stem}_abs.bed`, `${stem}_abs.bed.gz`]
}

/**
 * The names a sidecar for `base` could have been remembered under.
 *
 * The reverse of {@link basesForIndex}, and it exists for one road only: a
 * restored row knows the name of its file and nothing about its index, because
 * a `File` does not survive session storage. Both suffixes and both spellings
 * are offered, most specific first, and the first that a grant answers for is
 * the one taken.
 */
export function indexNamesFor(base: string): string[] {
  if (isHicProMatrix(base)) return hicProBinsNames(base)
  if (/\.bam$/i.test(base)) {
    const stem = base.replace(/\.bam$/i, '')
    return [`${base}.bai`, `${base}.csi`, `${stem}.bai`, `${stem}.csi`]
  }
  // A pairs file takes a `.px2` and never a `.tbi`; everything else bgzipped
  // takes a `.tbi` and never a `.px2`. Offering both for either would mean a
  // restored row fetching an index that cannot exist.
  if (/\.pairs\.gz$/i.test(base)) return [`${base}.px2`]
  if (/\.gz$/i.test(base)) return [`${base}.tbi`]
  return []
}

/** A file to open, and the sidecar dropped alongside it if there was one. */
export interface PairedDrop {
  file: File
  index?: File
}

/**
 * Group a dropped batch into the files to open and the indexes that belong to them.
 *
 * The one implementation of the pairing rule, because there are two roads into
 * it and they used to disagree. {@link AnnotationLoader.addFiles} pairs what it
 * is handed; `Session.dropped` decides what a single file *is* — a workspace, a
 * map, a `chrom.sizes`, a track — and every caller was looping it over the
 * batch, so the loader was handed one file at a time and the pairing never
 * fired for a plain drop onto the window. A `.tbi` losing that race read a file
 * whole that it had an index for; a `.bai` losing it loses the file (§8.13).
 *
 * A sidecar whose file is not in the batch is returned as its own entry rather
 * than dropped, so it reaches the loader alone and is refused by name — more
 * use than silently doing nothing.
 */
export function pairIndexes(files: readonly File[]): PairedDrop[] {
  const bases = new Map<string, File>()
  for (const file of files) if (!isIndexName(file.name)) bases.set(file.name, file)

  const indexOf = new Map<File, File>()
  const spent = new Set<File>()
  for (const file of files) {
    if (!isIndexName(file.name)) continue
    for (const name of basesForIndex(file.name)) {
      const base = bases.get(name)
      // First claim wins, in the order `basesForIndex` offers: `reads.bam.bai`
      // names one file exactly, so a directory holding both spellings pairs
      // each with its own rather than both with the first.
      if (base === undefined || indexOf.has(base)) continue
      indexOf.set(base, file)
      spent.add(file)
      break
    }
  }

  const out: PairedDrop[] = []
  for (const file of files) {
    if (spent.has(file)) continue
    const index = indexOf.get(file)
    out.push(index === undefined ? { file } : { file, index })
  }
  return out
}

/**
 * Which of a dropped batch opens the session, once the sidecars are paired.
 *
 * A map first, then anything that can declare a genome, then whatever came
 * first — which is the order `Session.openFiles` has always used. What is new
 * is that it chooses among **pairs** rather than among files, and that is the
 * whole of why it is a function: choosing from the raw list picks `reads.bam`,
 * opens it without the `reads.bam.bai` sitting right beside it, and leaves the
 * index to be routed on its own. The result is a browser on the BAM's own
 * reference table, the BAM refused for want of an index, and an orphan row for
 * the index — from the one gesture the feature exists for (§8.13).
 *
 * `route` is passed in rather than imported so this stays in the annotations
 * layer, which does not know about the app's front doors.
 */
export function leadOf(
  paired: readonly PairedDrop[],
  route: (name: string) => 'map' | 'genome' | 'unknown',
): PairedDrop | undefined {
  return (
    paired.find((pair) => route(pair.file.name) === 'map') ??
    paired.find((pair) => route(pair.file.name) === 'genome') ??
    paired[0]
  )
}
