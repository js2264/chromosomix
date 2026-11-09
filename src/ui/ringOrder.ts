/**
 * Where a ring's tracks go in the store when it is dragged to another's place
 * (§7.6).
 *
 * A ring is a lane's slot, and an overlay group's tracks share one: the group
 * is drawn wherever its first track stands, so moving only the track a ring is
 * held by would leave the group behind, re-formed round whichever of its other
 * tracks now comes first. The ring's tracks move as one block instead, in their
 * own order — after the other ring's tracks going outwards, before them going
 * in — and everything else keeps its place. Pure, so the rule is tested without
 * a store.
 */
export function ringBlockOrder(
  order: readonly string[],
  moving: readonly string[],
  anchors: readonly string[],
  outwards: boolean,
): string[] {
  const held = new Set(moving)
  const block = order.filter((id) => held.has(id))
  const rest = order.filter((id) => !held.has(id))
  const marks: number[] = []
  rest.forEach((id, k) => {
    if (anchors.includes(id)) marks.push(k)
  })
  if (block.length === 0 || marks.length === 0) return [...order]
  const at = outwards ? marks[marks.length - 1] + 1 : marks[0]
  return [...rest.slice(0, at), ...block, ...rest.slice(at)]
}
