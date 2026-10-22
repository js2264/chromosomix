/**
 * Limited-memory BFGS: the optimiser a likelihood needs (§25.6).
 *
 * SMACOF, which is what {@link "../structure/reconstruct"} refines with, is not
 * an optimiser at all — it is a *majorisation*, and it works because the stress
 * of an MDS problem has a closed-form majorant whose minimum is one pass over
 * the pairs away. A likelihood has no such form. `structure/negbinom.ts` asks
 * for the coordinates that maximise a negative binomial's probability of having
 * produced the counts, and nothing about that function can be minimised by
 * substitution; it has a value and a gradient and that is all, so it needs a
 * method that takes a value and a gradient and nothing else.
 *
 * L-BFGS is that method, and it is the one pastis itself uses (through SciPy's
 * `fmin_l_bfgs_b`). It keeps the last `history` pairs of *step* and *gradient
 * change* and builds an implicit inverse Hessian out of them by the two-loop
 * recursion, which costs `O(history · n)` per iteration and no matrix at all.
 * For a structure that is three coordinates per bead, `n` is `3 · beads` and
 * the whole history at SciPy's depth of ten is twenty-two vectors — six
 * megabytes at twelve thousand beads, beside the half-gigabyte matrix of
 * counts. The Hessian a full BFGS would write down is `(3n)²`, which at that
 * size is thirty **terabytes**, so the "limited-memory" is not an optimisation
 * here but the only reason this can exist in a tab.
 *
 * The line search is Nocedal & Wright's Algorithm 3.5 with the 3.6 *zoom*,
 * enforcing the **strong Wolfe conditions**. A backtracking search would be
 * half the code and is what most hand-written solvers settle for, but it only
 * guarantees the sufficient *decrease* — not the curvature condition `sᵀy > 0`
 * that makes the Hessian approximation positive definite. Without it the
 * history poisons itself on exactly the functions this is here for: a negative
 * binomial whose counts run from thousands on the near diagonal to nothing far
 * from it is badly scaled, and a badly scaled problem is where a rejected
 * curvature pair costs an iteration and an *accepted* bad one costs the run.
 *
 * **Its constants are SciPy's**, the ones every pastis run is made with: a
 * step must buy a thousandth of the decrease its slope promised, its slope
 * must fall to 0.9 of where it began, a search has twenty probes, the history
 * is ten pairs deep, a failed search throws the history away and tries once
 * more by steepest descent, and the run stops once an iteration buys less than
 * `tolerance` of the value — L-BFGS-B's `factr · ε` — or the largest gradient
 * component is under `gradientTolerance`, its `pgtol`. So a caller that hands
 * it pastis' tolerances stops where pastis would.
 *
 * **A generator, a value at a time**, for the same reason `classicalMdsSweeps`
 * is one: at ten thousand beads a single evaluation is a hundred million pair
 * visits and a line search is several of them, so a caller that runs this where
 * somebody is watching needs somewhere to move a bar and somewhere to let a
 * cancel land. It yields *before every evaluation*, not once per iteration,
 * because the evaluation is the unit of work and an iteration is up to a
 * dozen of them.
 *
 * Arrays in and arrays out — no worker, no store, no DOM — so the test can hold
 * the arithmetic still against functions whose minima are known (§18.9).
 */

/**
 * A function of a vector that reports its own gradient.
 *
 * `gradient` is written over, never read, and is the caller's array both times
 * so no allocation happens inside a line search. The return is the value at
 * `point`; a **non-finite** one means *outside the domain* — a structure whose
 * beads have collided, a scale that has overflowed — and the search treats it
 * as an infinitely bad step and shortens, rather than propagating a `NaN` into
 * the history and ending the run.
 */
export type Objective = (point: Float64Array, gradient: Float64Array) => number

/** How far along, for a bar and for a cancel. */
export interface LbfgsProgress {
  /** Completed iterations; `0` while the first line search is running. */
  iteration: number
  /** The budget, for a bar that needs a denominator. */
  iterations: number
  /** Evaluations of the objective so far, this one included. */
  evaluations: number
  /** The best value so far. */
  value: number
}

/**
 * Why it stopped.
 *
 * `gradient` and `value` are convergence; `steps` is the budget running out,
 * which on a big model is the ordinary ending and not a failure; `search` is a
 * line search that could not find a point satisfying Wolfe, which means the
 * gradient and the function disagree or the problem is flat here, and is the
 * one worth reporting.
 */
export type LbfgsStop = 'gradient' | 'value' | 'steps' | 'search'

export interface LbfgsResult {
  point: Float64Array
  value: number
  iterations: number
  evaluations: number
  stop: LbfgsStop
}

export interface LbfgsOptions {
  /** Iterations, not evaluations: each costs one line search. Default 200. */
  iterations?: number
  /** Curvature pairs kept. Default 10, SciPy's; more is a better Hessian and more memory. */
  history?: number
  /** Stop once an iteration improves the value by less than this share of it. Default 1e-9. */
  tolerance?: number
  /** Stop once the largest gradient component is below this. Default 1e-10. */
  gradientTolerance?: number
}

/**
 * Armijo's constant: how much of the predicted decrease a step must deliver.
 * SciPy's L-BFGS-B line search asks for a thousandth (`ftol = 1e-3`), and that
 * is the optimiser pastis calls, so it is the one this is held to.
 */
const SUFFICIENT_DECREASE = 1e-3
/** Wolfe's curvature constant. 0.9 is the standard for a quasi-Newton method, and SciPy's. */
const CURVATURE = 0.9
/** Line-search steps before giving up on one direction: SciPy's `maxls`. */
const SEARCH_STEPS = 20
/** A curvature pair flatter than this is dropped rather than inverted. */
const CURVATURE_FLOOR = 1e-12

/**
 * Minimise `objective` from `start`, a value at a time.
 *
 * The vector is copied, so the caller's `start` is never written over: a run
 * that is cancelled halfway leaves the model it began from intact, which is
 * what lets the runner fall back to its initialisation and still return
 * something.
 */
export function* lbfgs(
  objective: Objective,
  start: Float64Array,
  options: LbfgsOptions = {},
): Generator<LbfgsProgress, LbfgsResult, void> {
  const iterations = Math.max(0, Math.round(options.iterations ?? 200))
  const depth = Math.max(1, Math.round(options.history ?? 10))
  const tolerance = options.tolerance ?? 1e-9
  const gradientTolerance = options.gradientTolerance ?? 1e-10
  const n = start.length

  const point = Float64Array.from(start)
  const gradient = new Float64Array(n)
  const trial = new Float64Array(n)
  const trialGradient = new Float64Array(n)
  const direction = new Float64Array(n)
  // The curvature pairs, oldest first; at most `depth` of each.
  const steps: Float64Array[] = []
  const changes: Float64Array[] = []
  const rho: number[] = []
  const coefficients = new Float64Array(depth)

  const counter = { evaluations: 0 }
  let value = evaluate(objective, point, gradient, counter)
  yield { iteration: 0, iterations, evaluations: counter.evaluations, value }
  if (!Number.isFinite(value)) {
    return { point, value, iterations: 0, evaluations: counter.evaluations, stop: 'search' }
  }

  let stop: LbfgsStop = 'steps'
  let done = 0
  for (; done < iterations; done++) {
    if (maxAbs(gradient) <= gradientTolerance) {
      stop = 'gradient'
      break
    }

    // The two-loop recursion: `direction = −H ∇f`, with `H` the inverse Hessian
    // the history implies and never an array. The first iteration has no
    // history and falls back to steepest descent, which is why its step length
    // is the one that needs scaling below.
    direction.set(gradient)
    const held = steps.length
    for (let k = held - 1; k >= 0; k--) {
      const a = rho[k] * dot(steps[k], direction)
      coefficients[k] = a
      addScaled(direction, changes[k], -a)
    }
    if (held > 0) {
      // Barzilai–Borwein scaling of the initial Hessian: `sᵀy / yᵀy`, the
      // standard choice, and the thing that makes a unit step length the right
      // first guess for the line search from the second iteration on.
      const last = held - 1
      const scale = dot(steps[last], changes[last]) / dot(changes[last], changes[last])
      if (Number.isFinite(scale) && scale > 0) for (let i = 0; i < n; i++) direction[i] *= scale
    }
    for (let k = 0; k < held; k++) {
      const b = rho[k] * dot(changes[k], direction)
      addScaled(direction, steps[k], coefficients[k] - b)
    }
    for (let i = 0; i < n; i++) direction[i] = -direction[i]

    let slope = dot(gradient, direction)
    if (!(slope < 0)) {
      // The history has gone bad — a direction that does not descend. Throw it
      // away and take the gradient, which always does. Cheaper and safer than
      // any repair: one steepest-descent iteration rebuilds a clean pair.
      steps.length = 0
      changes.length = 0
      rho.length = 0
      for (let i = 0; i < n; i++) direction[i] = -gradient[i]
      slope = -dot(gradient, gradient)
      if (!(slope < 0)) {
        stop = 'gradient'
        break
      }
    }

    // Steepest descent has no scale of its own, so the first step is sized to
    // the gradient — a unit move, `1/‖∇f‖`, as L-BFGS-B sizes it; a
    // quasi-Newton direction carries its own and starts at 1.
    const first = steps.length === 0 ? Math.min(1e10, 1 / Math.sqrt(dot(gradient, gradient))) : 1
    const search = yield* lineSearch(
      objective,
      point,
      direction,
      trial,
      trialGradient,
      value,
      slope,
      first,
      counter,
      done,
      iterations,
    )
    if (!search.ok) {
      // L-BFGS-B's answer to a failed search: the history may be what pointed
      // the step somewhere useless, so it is thrown away and the iteration
      // tried again by steepest descent. Only a search that fails *without* a
      // history ends the run.
      if (steps.length > 0) {
        steps.length = 0
        changes.length = 0
        rho.length = 0
        done--
        continue
      }
      stop = 'search'
      break
    }

    // `s` is the step taken and `y` the gradient's change over it; both are
    // fresh arrays because the history keeps them.
    const s = new Float64Array(n)
    const y = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      s[i] = search.step * direction[i]
      y[i] = trialGradient[i] - gradient[i]
    }
    const before = value
    point.set(trial)
    gradient.set(trialGradient)
    value = search.value

    const curvature = dot(s, y)
    // Wolfe guarantees this is positive, and it is still checked: a curvature
    // pair that is flat to rounding inverts into a vast `rho` and the next
    // direction is nonsense. Dropping it costs one iteration of history.
    if (curvature > CURVATURE_FLOOR * Math.sqrt(dot(s, s) * dot(y, y))) {
      steps.push(s)
      changes.push(y)
      rho.push(1 / curvature)
      if (steps.length > depth) {
        steps.shift()
        changes.shift()
        rho.shift()
      }
    }

    if (before - value <= tolerance * Math.max(1, Math.abs(before), Math.abs(value))) {
      done++
      stop = 'value'
      break
    }
  }

  return { point, value, iterations: done, evaluations: counter.evaluations, stop }
}

/**
 * A step length satisfying the strong Wolfe conditions, or a failure.
 *
 * Nocedal & Wright's Algorithm 3.5: widen a bracket until it holds a good
 * point, then hand the bracket to {@link zoom}. Because the objective reports
 * its value and its gradient in one pass, `φ(a)` and `φ'(a)` cost one
 * evaluation between them rather than two — which is why this is written
 * against an objective of that shape rather than against a pair of functions.
 *
 * The successful trial is left in `trial` and `trialGradient`; a failure leaves
 * them as whatever the last evaluation wrote, and the caller keeps its point.
 */
function* lineSearch(
  objective: Objective,
  point: Float64Array,
  direction: Float64Array,
  trial: Float64Array,
  trialGradient: Float64Array,
  value0: number,
  slope0: number,
  first: number,
  counter: { evaluations: number },
  iteration: number,
  iterations: number,
): Generator<LbfgsProgress, { ok: boolean; step: number; value: number }, void> {
  const n = point.length
  const at = (step: number): void => {
    for (let i = 0; i < n; i++) trial[i] = point[i] + step * direction[i]
  }

  let previous = 0
  let previousValue = value0
  let step = first
  // The last point evaluated, so a success can be restored into `trial` without
  // a further pass: `zoom` may end on a step it evaluated two probes ago.
  let lastStep = Number.NaN

  for (let probe = 0; probe < SEARCH_STEPS; probe++) {
    at(step)
    const value = evaluate(objective, trial, trialGradient, counter)
    lastStep = step
    yield { iteration, iterations, evaluations: counter.evaluations, value: Math.min(value0, value) }

    const failsArmijo = !Number.isFinite(value) || value > value0 + SUFFICIENT_DECREASE * step * slope0
    if (failsArmijo || (probe > 0 && value >= previousValue)) {
      const found = yield* zoom(
        objective,
        point,
        direction,
        trial,
        trialGradient,
        value0,
        slope0,
        previous,
        previousValue,
        step,
        counter,
        iteration,
        iterations,
      )
      return found
    }

    const slope = dot(trialGradient, direction)
    if (Math.abs(slope) <= -CURVATURE * slope0) return { ok: true, step, value }
    if (slope >= 0) {
      const found = yield* zoom(
        objective,
        point,
        direction,
        trial,
        trialGradient,
        value0,
        slope0,
        step,
        value,
        previous,
        counter,
        iteration,
        iterations,
      )
      return found
    }

    previous = step
    previousValue = value
    step *= 2
    if (!Number.isFinite(step)) break
  }

  // Out of probes. If the last point at least decreased the value it is worth
  // taking — a step that is not Wolfe still makes progress, and the curvature
  // guard above will simply drop the pair it produces.
  if (Number.isFinite(lastStep)) {
    at(lastStep)
    const value = evaluate(objective, trial, trialGradient, counter)
    yield { iteration, iterations, evaluations: counter.evaluations, value: Math.min(value0, value) }
    if (Number.isFinite(value) && value < value0) return { ok: true, step: lastStep, value }
  }
  return { ok: false, step: 0, value: value0 }
}

/**
 * Nocedal & Wright's Algorithm 3.6, narrowing a bracket known to hold a point
 * that satisfies Wolfe.
 *
 * **Bisection rather than cubic interpolation.** The textbook interpolates, and
 * interpolation is worth perhaps a third of the probes on a smooth function;
 * but the failure mode of an interpolant on a function with a pole — which this
 * one has, since a pair of beads on one point makes the mean infinite — is a
 * trial step outside the bracket, and the safeguard that puts it back is most
 * of what interpolation saved. The bracket halves every probe, so twenty probes
 * is a step known to a part in a million and the loop is never the run's cost.
 */
function* zoom(
  objective: Objective,
  point: Float64Array,
  direction: Float64Array,
  trial: Float64Array,
  trialGradient: Float64Array,
  value0: number,
  slope0: number,
  lowStart: number,
  lowValueStart: number,
  highStart: number,
  counter: { evaluations: number },
  iteration: number,
  iterations: number,
): Generator<LbfgsProgress, { ok: boolean; step: number; value: number }, void> {
  const n = point.length
  let low = lowStart
  let lowValue = lowValueStart
  let high = highStart

  for (let probe = 0; probe < SEARCH_STEPS; probe++) {
    const step = (low + high) / 2
    if (!Number.isFinite(step) || step <= 0) break
    for (let i = 0; i < n; i++) trial[i] = point[i] + step * direction[i]
    const value = evaluate(objective, trial, trialGradient, counter)
    yield { iteration, iterations, evaluations: counter.evaluations, value: Math.min(value0, value) }

    const failsArmijo = !Number.isFinite(value) || value > value0 + SUFFICIENT_DECREASE * step * slope0
    if (failsArmijo || value >= lowValue) {
      high = step
      continue
    }
    const slope = dot(trialGradient, direction)
    if (Math.abs(slope) <= -CURVATURE * slope0) return { ok: true, step, value }
    if (slope * (high - low) >= 0) high = low
    low = step
    lowValue = value
  }

  // The bracket collapsed without a Wolfe point. `low` is the best point seen
  // and it beat the start, so it is taken: a shorter step than the curvature
  // condition wanted is a slower iteration, not a wrong one.
  if (low > 0 && lowValue < value0) {
    for (let i = 0; i < n; i++) trial[i] = point[i] + low * direction[i]
    const value = evaluate(objective, trial, trialGradient, counter)
    yield { iteration, iterations, evaluations: counter.evaluations, value: Math.min(value0, value) }
    if (Number.isFinite(value)) return { ok: true, step: low, value }
  }
  return { ok: false, step: 0, value: value0 }
}

function evaluate(
  objective: Objective,
  point: Float64Array,
  gradient: Float64Array,
  counter: { evaluations: number },
): number {
  counter.evaluations++
  const value = objective(point, gradient)
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value
}

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

function addScaled(into: Float64Array, from: Float64Array, scale: number): void {
  for (let i = 0; i < into.length; i++) into[i] += scale * from[i]
}

function maxAbs(v: Float64Array): number {
  let most = 0
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i])
    if (a > most) most = a
  }
  return most
}
