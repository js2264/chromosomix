/**
 * The work this tab has asked for and not yet been answered about.
 *
 * A picture here is never drawn in one go: a map opens, asks its reader worker
 * for a block, asks the annotations worker for every lane's samples, fetches the
 * chunk that draws a 3D model and the one that draws a chart, and each of those
 * answers starts more. A reader watching the screen knows the picture is done
 * because it stops changing. A program has no eyes, and `metacooler-plot`
 * (§27) is a program asking exactly that question before it saves a figure — so
 * the question needs an answer that is a number rather than a feeling.
 *
 * This is that number: every request a worker client has sent and not had
 * answered, and every other piece of work somebody chose to {@link track}.
 * Counted by the three clients at the one place each sends and settles, which
 * is why it is exact rather than inferred: a request that is never answered is
 * a worker that has died, and those fail every pending request on the way out.
 *
 * A module-level registry, on `perf/threads.ts`'s argument: a tab holds one
 * reader worker per map and one annotations worker per session, and threading a
 * count up through every one of them would be asking each owner for a number
 * none of them has any other use for.
 *
 * Nothing in the window reads it. It costs an increment and a decrement per
 * message, and it is exported for the plot harness (`plot/harness.ts`) and the
 * tests.
 */

/** What is outstanding, by kind — `reader:block`, `annotations:sample`, `import:three`. */
const outstanding = new Map<string, number>()

/**
 * Note that one piece of work has started, and get the function that ends it.
 *
 * The returned function is idempotent, because the paths that settle a request
 * are several — an answer, an error, a worker that died and failed everything —
 * and a request counted out twice would hide a second one still running.
 */
export function beginWork(kind: string): () => void {
  outstanding.set(kind, (outstanding.get(kind) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const left = (outstanding.get(kind) ?? 1) - 1
    if (left <= 0) outstanding.delete(kind)
    else outstanding.set(kind, left)
  }
}

/**
 * Count a promise in for as long as it is pending, and hand it back.
 *
 * For the work that is not a worker request — a chunk being imported, a fetch on
 * the main thread — which would otherwise let the count reach zero in the gap
 * between a file opening and the first thing it draws asking for its data.
 */
export function track<T>(kind: string, work: Promise<T>): Promise<T> {
  const done = beginWork(kind)
  return work.finally(done)
}

/** How many pieces of work are outstanding, of every kind. */
export function inflight(): number {
  let total = 0
  for (const count of outstanding.values()) total += count
  return total
}

/** The outstanding work by kind, for saying *what* is still running when a wait gives up. */
export function inflightKinds(): Record<string, number> {
  return Object.fromEntries(outstanding)
}
