/**
 * What the two commands call the files they write.
 *
 * `metacooler-run` names a result after the file it was measured from, and
 * `metacooler-plot` (§27) names a figure the same way, so a TSV and the picture
 * of the same output land side by side in one directory listing:
 * `sample.insulation.insulation.tsv` beside `sample.insulation.insulation.png`.
 * One module, because two copies of a naming rule is how one of them stops
 * doing that.
 */

import { basename } from 'node:path'

import { parseUri } from '../uri'

/** `demo/yeast/Yeast_microC.cool` → `Yeast_microC`. */
export function stemOf(path: string): string {
  // The `::` half is the *group inside the container*, so a file addressed as
  // `sample.mcool::/resolutions/1000` is still `sample` — it was `1000`, which
  // is `basename` of a group path and named every output after a number. The
  // group's last segment is kept as a suffix so two resolutions of one file
  // written to one `--out` are two sets of results rather than one overwritten
  // twice.
  const { path: file, group } = parseUri(path)
  // The last segment of a URL's path, not of the whole URL: a query string is
  // not part of a file's name.
  const name = basename(/^[a-z][a-z0-9+.-]+:\/\//i.test(file) ? new URL(file).pathname : file)
  const dot = name.indexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : (name || 'output')
  if (group === '/') return stem
  const last = group.split('/').filter((part) => part !== '').pop()
  return last === undefined ? stem : `${stem}_${last}`
}

/**
 * A reader's words as part of a filename: what a filesystem might object to
 * becomes `_`, and nothing longer than eighty characters — the characters
 * `ui/export.ts`'s `exportBaseName` keeps for a figure saved by hand, so a tab
 * called `wild type × mutant` is the same filename either way. Two differences,
 * both because this one is joined onto a directory rather than offered in a
 * save dialog: a leading dot goes too, so no name is `..` or a hidden file, and
 * empty in is `figure` out.
 */
export function safeName(text: string): string {
  const cleaned = text
    .replace(/[×✓]/g, 'x')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[_.]+|_+$/g, '')
    .slice(0, 80)
  return cleaned === '' ? 'figure' : cleaned
}
