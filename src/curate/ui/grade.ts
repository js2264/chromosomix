/**
 * metaTOR's grades of a MAG (`validation.py::bin_quality`), on the weighted
 * completeness and redundancy: high at 90% or more and 1.05 or less, medium at
 * 70%, low at 50%, contaminated above 1.10 whatever its completeness.
 */
export function grade(completeness: number, redundancy: number): 'high' | 'medium' | 'low' | 'contaminated' | null {
  if (!Number.isFinite(completeness) || !Number.isFinite(redundancy)) return null
  if (redundancy > 1.1) return 'contaminated'
  if (completeness >= 0.9 && redundancy <= 1.05) return 'high'
  if (completeness >= 0.7) return 'medium'
  if (completeness >= 0.5) return 'low'
  return null
}
