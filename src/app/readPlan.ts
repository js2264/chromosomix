/**
 * Which read plan an open of a remote map fetches ahead (§6.1, §12): the one
 * this browser kept from its last open of the map (`state/readPlans.ts`), or,
 * on a first open, the one an example ships with (`ui/exampleSessions.ts`) — so
 * the landing page's examples open as fast for a first visitor as for a second.
 */

import type { ReadPlan } from '../sources/RemoteRangeSource'
import { planFor, planOf } from '../state/readPlans'
import type { ViewState } from '../types'
import { EXAMPLE_PLANS } from '../ui/exampleSessions'
import type { SourceSpec } from '../worker/protocol'

/** The plan for an open of `uri` going to `region`, or `null` where none is known. */
export function readPlanFor(uri: string, region: string | undefined): ReadPlan | null {
  return planFor(uri, region) ?? planOf(EXAMPLE_PLANS[uri], region)
}

/**
 * The window an open of `uri` goes to, where the state it opens says so: the
 * key the first view's plan is kept under and looked up by. Either map of a
 * comparison goes to the state's window (§11); a view with a second window, or
 * none, keeps no view plan.
 */
export function windowOf(state: ViewState | null | undefined, uri: string): string | undefined {
  if (state === null || state === undefined || (state.uri !== uri && state.uri2 !== uri)) return undefined
  return state.view === 'region' && state.region2 === undefined ? state.region : undefined
}

/**
 * A remote source with the plan known for its open, fetched side by side as it
 * starts; any other source, or one that names its own plan, as it is.
 */
export function planned(source: SourceSpec, uri: string, window: string | undefined): SourceSpec {
  if (source.kind !== 'remote' || source.plan !== undefined) return source
  const plan = readPlanFor(uri, window)
  return plan === null ? source : { ...source, plan }
}
