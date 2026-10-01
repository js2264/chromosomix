/**
 * How a sequence is cut into tiles, for the readers that walk one.
 *
 * Its own module, and a small one, because two layers need the same arithmetic
 * and neither may import the other. `analysis/run/blocks.ts` does the reading
 * and lives in the analysis worker; `analysis/tasks/insulation.ts` prices the
 * read before it happens and lives in the panel. A task whose estimate counts
 * one thing while its runner reads another is worse than a task with no
 * estimate — it is the number a reader decides on, and the gate that refuses
 * (§18.6) is derived from it.
 *
 * Nothing here touches a file or a job. It is arithmetic about shapes.
 */

/**
 * The largest tile any of these readers will ask the file for, in cells.
 *
 * 16 million cells is 64 MB as `Float32`, which is small enough to be nothing on
 * any machine that opened the file and large enough that a chromosome is a few
 * dozen reads rather than a few thousand. It is a *tile* bound and not a budget:
 * the point of the banded readers is that what they hold does not grow with the
 * sequence, so there is no machine-dependent number to consult.
 */
export const TILE_CELLS = 16_000_000

/**
 * Rows per tile, for a reader that needs `halo` bins of margin around each one.
 *
 * The read is `(tile + extra)` wide however tall it is, so the cells a whole
 * sequence costs are `n × (tile + extra)` — smallest when the tile is about the
 * halo, and only twice the band itself there. A floor keeps a narrow band from
 * turning a chromosome into thousands of tiny queries, and the cell cap keeps a
 * wide one from asking for a tile it cannot hold.
 */
export function tileRows(halo: number, extra: number): number {
  const wanted = Math.max(256, Math.min(halo, 4096))
  let tile = wanted
  while (tile > 1 && tile * (tile + extra) > TILE_CELLS) tile = Math.floor(tile / 2)
  return Math.max(1, tile)
}

/**
 * Squares along the diagonal a sequence of `bins` is walked in.
 *
 * The shape `forEachDiagonalTile` reads it in: each tile owns a body of bins and
 * carries `halo` of margin on each side, so the bins at its seams are scored
 * from the neighbouring tile instead. What this counts is the *bodies*, which is
 * one file read each.
 */
export function diagonalTiles(bins: number, halo: number): number {
  const body = tileRows(Math.max(0, halo) * 2, Math.max(0, halo) * 2)
  return Math.max(1, Math.ceil(Math.max(1, bins) / body))
}

/**
 * Strips a sequence of `bins` is read in as a **band** `hi` diagonals deep.
 *
 * `bandFor`'s walk rather than `forEachDiagonalTile`'s, and it is a different
 * number: a band tile is a run of rows read out to `hi` past its own last row,
 * with no overlap between tiles, where a diagonal tile carries a halo on both
 * sides and its neighbours overlap it. The tasks that read a band price
 * themselves with this one, for the reason at the top of this module — an
 * estimate that counts the other walk's reads is the number a reader decides on
 * and it is wrong by whatever the halo was.
 *
 * The wrapped corner a circular sequence costs is **not** counted here: it is one
 * request, it is the same one request whatever the sequence, and the caller adds
 * it where it knows whether the sequence is circular at all.
 */
export function bandTiles(bins: number, hi: number): number {
  const depth = Math.max(0, hi)
  return Math.max(1, Math.ceil(Math.max(1, bins) / tileRows(depth, depth)))
}
