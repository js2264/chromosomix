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
 * The sidecar suffixes this app pairs with the file they index.
 *
 * `.tbi` indexes a bgzipped text file and is opportunistic — the file opens
 * without it (§8.11). `.bai` and `.csi` index a BAM and are not: there is no
 * whole-file fallback at §12's budgets, so the pair is the unit, and a BAM
 * arriving without its index is refused by name (§8.13). One regular
 * expression for all three, because *pairing* is the same gesture whichever it
 * is; what differs is only what happens when the pairing fails.
 */
const INDEX_SUFFIX = /\.(tbi|bai|csi)$/i

/** Whether this file is a sidecar index rather than something to draw. */
export function isIndexName(name: string): boolean {
  return INDEX_SUFFIX.test(name)
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
  const stem = name.replace(INDEX_SUFFIX, '')
  return /\.(bai|csi)$/i.test(name) && !/\.bam$/i.test(stem)
    ? [stem, `${stem}.bam`]
    : [stem]
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
  if (/\.bam$/i.test(base)) {
    const stem = base.replace(/\.bam$/i, '')
    return [`${base}.bai`, `${base}.csi`, `${stem}.bai`, `${stem}.csi`]
  }
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
