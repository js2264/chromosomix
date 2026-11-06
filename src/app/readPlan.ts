/**
 * Which read plan an open of a remote map fetches ahead (§6.1, §12): the one
 * this browser kept from its last open of the map (`state/readPlans.ts`), or,
 * on a first open, the one an example ships with (`ui/exampleSessions.ts`) — so
 * the landing page's examples open as fast for a first visitor as for a second.
 */

import type { ReadPlan } from '../sources/RemoteRangeSource'
import { planFor, planOf } from '../state/readPlans'
import { EXAMPLE_PLANS } from '../ui/exampleSessions'

/** The plan for an open of `uri` going to `region`, or `null` where none is known. */
export function readPlanFor(uri: string, region: string | undefined): ReadPlan | null {
  return planFor(uri, region) ?? planOf(EXAMPLE_PLANS[uri], region)
}
