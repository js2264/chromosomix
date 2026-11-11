/**
 * What a loaded file is called.
 *
 * A module of its own because two venues ask it: the annotation store names
 * every row it begins with it, and the command line names every `--tracks`
 * file with it (`cli/main.ts`), so that a figure's series, a correlation's axes
 * and a table's rows say the same name for one track whichever of the two made
 * them (§23.1). The store pulls in the page's memory and the lanes' geometry,
 * which a command-line program has no use for.
 */

/**
 * A file name as a track label: no directory, no suffix, and no `.bw` left on
 * the end of a name that is going to sit in a 16 rem column.
 *
 * Double suffixes go too (`.gtf.gz`), and only the ones this app recognises —
 * truncating at the last dot would turn `Yeast_ChIP_Pol2-vs-input` into
 * `Yeast_ChIP_Pol2-vs`.
 */
export function cleanLabel(name: string): string {
  const base = name.split('/').pop() ?? name
  return base.replace(
    /\.(bw|bigwig|bigWig|bb|bigbed|gtf|gff3?|bed|bedpe|vcf|bam|narrowPeak|broadPeak|gappedPeak|peaks|bdg|bedgraph|wig|tsv|txt|fa|fasta|fna|fas|g3d|3dg|bed3d)(\.gz)?$/i,
    '',
  )
}
