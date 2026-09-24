/**
 * What an `.mcool` written from an imported `.pairs` is called:
 * `Hum53.pairs.gz` → `Hum53.mcool`, the pairs file's own stem without the
 * `.pairs`, `.gz` or `.px2` it came with.
 *
 * Its own module because two runtimes need it: the worker, which writes the
 * file, and the session, which has to ask where it goes *before* the worker
 * starts — a save dialog is opened from the press, and the press is long gone
 * by the time a whole ladder of resolutions has been written (`ui/export.ts`).
 */
export function mcoolNameFor(uri: string): string {
  const leaf = uri.split(/[\\/]/).pop() ?? 'pairs'
  const stem = leaf.replace(/\.px2$/i, '').replace(/\.gz$/i, '').replace(/\.pairs$/i, '')
  return `${stem || 'pairs'}.mcool`
}
