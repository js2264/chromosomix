/**
 * metaTOR's grades of a MAG (`validation.py::bin_quality`), on miComplete's
 * weighted completeness and redundancy: under 50% complete, none; past that,
 * contaminated above 1.10 redundant, high at 90% or more and 1.05 or less,
 * medium at 70%, low at 50%.
 */
export function grade(completeness: number, redundancy: number): 'high' | 'medium' | 'low' | 'contaminated' | null {
  if (!Number.isFinite(completeness) || !Number.isFinite(redundancy)) return null
  if (completeness < 0.5) return null
  if (redundancy > 1.1) return 'contaminated'
  if (completeness >= 0.9 && redundancy <= 1.05) return 'high'
  if (completeness >= 0.7) return 'medium'
  return 'low'
}
