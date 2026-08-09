/**
 * The one tree builder, shared by both of a bigWig's trees.
 *
 * A BBI file carries two indexes and they are, structurally, the same tree: the
 * chromosome B+ tree that maps a contig name to an id and a size, and the R-tree
 * that maps a genomic range to the byte range of the block holding it. Both have
 * a fixed fan-out, both take their leaves already in sorted order, both give
 * every node the same four-byte header, and both are written root-first so that
 * a reader can start at a known offset. The only thing that differs between them
 * is what an item *is* — and an item is exactly the part this module refuses to
 * know about.
 *
 * So what is built here is a **plan** rather than bytes: how many nodes there
 * are, which leaves each one covers, and what byte offset each one lands at. The
 * caller then walks the plan and serialises its own items into it. That split is
 * decision 3 of §18.7, and the reason it is a decision rather than a convenience
 * is the assembly this app was written for: a `.metacool` with twenty thousand
 * contigs needs the chromosome tree to be genuinely **multi-level**. A writer
 * that emits one fat leaf node works on yeast and produces a file no
 * binary-searching reader can walk on a metagenome, and it fails there silently,
 * which is the worst way for an index to be wrong. One builder, exercised by
 * every file this app writes, is a multi-level path that cannot rot.
 *
 * Offsets are absolute file offsets, not offsets within the tree, because both
 * trees store child pointers as absolute offsets and doing the addition in one
 * place is one place for it to be wrong.
 */

/**
 * Every node in either tree opens with `isLeaf` u8, a reserved u8 and a `count`
 * u16 — the same four bytes, which is the observation this module is built on.
 */
export const TREE_NODE_HEADER_BYTES = 4

/** What a caller's items cost, and where the root goes. */
export interface TreeShape {
  /** Items per node — `blockSize` in both tree headers. */
  fanOut: number
  /** Bytes one item costs in a leaf node. */
  leafItemBytes: number
  /** Bytes one item costs in an internal node. */
  internalItemBytes: number
  /** Absolute file offset of the root node, which is the first node written. */
  rootOffset: number
}

/** One node, placed. */
export interface TreeNodePlan {
  readonly isLeaf: boolean
  /** Absolute file offset of this node's four-byte header. */
  readonly offset: number
  /**
   * The half-open run of **leaves** underneath this node. A leaf node's items
   * are exactly that run; an internal node's items are its children, and this
   * run is what a caller folds over to compute the bounding box or the first key
   * that the internal item has to carry.
   */
  readonly leafFirst: number
  readonly leafCount: number
  /** Indices into {@link TreePlan.nodes}, in order. Empty for a leaf. */
  readonly children: readonly number[]
}

/** The whole tree, laid out. */
export interface TreePlan {
  /**
   * Every node in the order it must be written — root first, leaves last. A
   * reader enters at the root and the root is therefore what has to sit at the
   * fixed offset just past the tree header; the rest of the order is free, and
   * writing level by level keeps a node's children next to each other on disk.
   */
  readonly nodes: readonly TreeNodePlan[]
  /** Total bytes of all nodes — the tree's size, header excluded. */
  readonly bytes: number
  /** Levels, counting the leaves as one. `1` is a tree that is a single leaf. */
  readonly depth: number
}

/** A level cut into nodes of at most `fanOut` items each. */
interface Draft {
  isLeaf: boolean
  itemCount: number
  leafFirst: number
  leafCount: number
  /** Index of this node's first child within the level below. */
  childFirst: number
}

/**
 * Cut `count` consecutive things into runs of at most `fanOut`.
 *
 * A count of zero still yields one empty run, and that is deliberate: an index
 * over nothing is still a tree with a root, because both readers begin by
 * reading a node header at a fixed offset and finding no node there is a
 * truncated file rather than an empty tree. A metacool where every bin of some
 * contig is `NaN` is an ordinary input, so this case is reached in practice.
 */
function runs(count: number, fanOut: number): { first: number; span: number }[] {
  if (count === 0) return [{ first: 0, span: 0 }]
  const out: { first: number; span: number }[] = []
  for (let first = 0; first < count; first += fanOut) {
    out.push({ first, span: Math.min(fanOut, count - first) })
  }
  return out
}

/**
 * Place a bottom-up, fully balanced tree over `leafCount` leaves.
 *
 * Bottom-up rather than by insertion: the leaves are already in the order the
 * format wants them — names collated for the B+ tree, `(contig, start)` for the
 * R-tree — so grouping them in runs of `fanOut` and then grouping *those* gives
 * every leaf the same depth for free, with none of the splitting a top-down
 * build would need. That is also what makes the byte layout knowable before a
 * single item is serialised, which is what lets a child pointer be written the
 * first time rather than patched afterwards.
 */
export function planTree(leafCount: number, shape: TreeShape): TreePlan {
  const { fanOut, leafItemBytes, internalItemBytes, rootOffset } = shape
  if (!Number.isInteger(fanOut) || fanOut < 2) {
    throw new Error(`A tree node must hold at least two items; asked for ${fanOut}.`)
  }
  if (!Number.isInteger(leafCount) || leafCount < 0) {
    throw new Error(`A tree needs a whole, non-negative leaf count; asked for ${leafCount}.`)
  }

  // Level 0 is the leaves; each further level indexes the one below it, and the
  // loop stops at the level that is a single node — the root.
  const levels: Draft[][] = []
  levels.push(
    runs(leafCount, fanOut).map((run) => ({
      isLeaf: true,
      itemCount: run.span,
      leafFirst: run.first,
      leafCount: run.span,
      childFirst: -1,
    })),
  )
  while (levels[levels.length - 1].length > 1) {
    const below = levels[levels.length - 1]
    levels.push(
      runs(below.length, fanOut).map((run) => {
        // The leaf run an internal node covers is the concatenation of its
        // children's, and they are contiguous by construction, so it is the first
        // child's start and the sum of their widths.
        let leafCount = 0
        for (let i = 0; i < run.span; i += 1) leafCount += below[run.first + i].leafCount
        return {
          isLeaf: false,
          itemCount: run.span,
          leafFirst: below[run.first].leafFirst,
          leafCount,
          childFirst: run.first,
        }
      }),
    )
  }

  // Written from the root down, so `levels` is walked backwards. `base[l]` is
  // where level `l` starts in that write order, which is what turns a child's
  // position within its own level into an index into the flat node list.
  const base: number[] = new Array<number>(levels.length)
  let index = 0
  for (let l = levels.length - 1; l >= 0; l -= 1) {
    base[l] = index
    index += levels[l].length
  }

  // Sizes are known from the item counts alone, so offsets are one pass and no
  // node ever has to be revisited.
  const offsets: number[] = new Array<number>(index)
  let cursor = rootOffset
  for (let l = levels.length - 1; l >= 0; l -= 1) {
    const itemBytes = l === 0 ? leafItemBytes : internalItemBytes
    for (let n = 0; n < levels[l].length; n += 1) {
      offsets[base[l] + n] = cursor
      cursor += TREE_NODE_HEADER_BYTES + levels[l][n].itemCount * itemBytes
    }
  }

  const nodes: TreeNodePlan[] = new Array<TreeNodePlan>(index)
  for (let l = levels.length - 1; l >= 0; l -= 1) {
    for (let n = 0; n < levels[l].length; n += 1) {
      const draft = levels[l][n]
      const children: number[] = []
      for (let i = 0; i < (draft.isLeaf ? 0 : draft.itemCount); i += 1) {
        children.push(base[l - 1] + draft.childFirst + i)
      }
      nodes[base[l] + n] = {
        isLeaf: draft.isLeaf,
        offset: offsets[base[l] + n],
        leafFirst: draft.leafFirst,
        leafCount: draft.leafCount,
        children,
      }
    }
  }

  return { nodes, bytes: cursor - rootOffset, depth: levels.length }
}
