/**
 * How a run becomes a line in the console (§23).
 *
 * The claim under test is that there is **one account of a run**, not two. The
 * drawer's `copy CLI command` and the console's row are the same function called
 * with the same `Provenance`, so a reader who copies the command an hour later
 * gets the line that was recorded when it ran. Two spellings of "what did this
 * run do" is how they come to disagree, and the disagreement would surface as a
 * command in a paper's methods section that does not reproduce the figure beside
 * it.
 *
 * The other half is the run the CLI cannot take at all. `cliCannotRun` refuses
 * the tasks that read a bigWig — the reader for one lives in the annotations
 * worker and nowhere else — and a console that dropped those runs would have
 * holes in it exactly where a reader is least likely to look for them. So the
 * line becomes a sentence, marked as prose rather than as shell, and the refusal
 * is the note saying why there is nothing to paste.
 */

import { describe, expect, it } from 'vitest'

import { cliCommandFor } from '@/analysis/cliCommand'
import { provisionalProvenance, runDraft } from '@/analysis/record'
import { taskById } from '@/analysis/registry'
import { defaultParams } from '@/analysis/types'
import type { AnalysisContext, AnalysisFraming, AnalysisTask, Provenance } from '@/analysis/types'

const CONTIGS = [
  { name: 'chrIV', length: 1_531_933, startBin: 0, bins: 1532, genome: -1 },
  { name: 'chrXVI', length: 948_066, startBin: 1532, bins: 949, genome: -1 },
]
const N_BINS = 2481

function framing(): AnalysisFraming {
  return {
    uri: '/data/yeast.mcool::resolutions/1000',
    label: 'whole genome at 1.0 kb bins · balanced · count',
    binsize: 1000,
    binsPerCell: 1,
    rows: [0, N_BINS],
    cols: [0, N_BINS],
    balance: true,
    value: 'count',
    normalise: null,
    level: 'bin',
  }
}

const CONTEXT: AnalysisContext = {
  uri: '/data/yeast.mcool::resolutions/1000',
  layout: 'cool',
  hasMap: true,
  hasGenomes: false,
  hasWeights: true,
  scoreColumns: [],
  binsize: 1000,
  nBins: N_BINS,
  contigs: CONTIGS,
  genomes: null,
  entries: [],
  framing: framing(),
  blockLoaded: false,
  blockBytes: 0,
}

function task(id: string): AnalysisTask {
  const found = taskById(id)
  if (found === undefined) throw new Error(`no ${id} task`)
  return found
}

function provenance(id: string, patch: Partial<Provenance> = {}): Provenance {
  return {
    task: id,
    taskVersion: 1,
    params: defaultParams(task(id).params),
    framing: framing(),
    app: 'test 1234abc',
    createdAt: '2026-09-11T09:00:00.000Z',
    ...patch,
  }
}

describe('a run the shell can take', () => {
  it('records the command the drawer would have copied, and nothing else on that line', () => {
    const insulation = task('insulation')
    const record = provenance('insulation')
    const draft = runDraft({ task: insulation, provenance: record, context: CONTEXT })
    const command = cliCommandFor({ task: insulation, provenance: record, context: CONTEXT })

    expect(draft.kind).toBe('run')
    expect(draft.shell).toBe(true)
    // The same text, split where the command begins: one function, called twice.
    expect([...(draft.notes ?? []), draft.line].join('\n')).toBe(command.text)
    expect(draft.line.startsWith('metacooler-run insulation ')).toBe(true)
    expect(draft.line.split('\n')).toHaveLength(1)
  })

  it('keeps the caveats a shell cannot be told, apart from the command', () => {
    const insulation = task('insulation')
    // A remote file: the command names the URL because that is what the reader
    // needs next, and says outright that it cannot be read from a shell.
    const record = provenance('insulation', {
      framing: { ...framing(), uri: 'https://example.org/yeast.mcool::resolutions/1000' },
    })
    const draft = runDraft({ task: insulation, provenance: record, context: CONTEXT })
    expect(draft.notes?.every((note) => note.startsWith('#'))).toBe(true)
    expect(draft.notes?.join(' ')).toContain('remote')
    expect(draft.line.startsWith('#')).toBe(false)
  })

  it('carries the provenance block the exports open with, as the output half', () => {
    const draft = runDraft({
      task: task('insulation'),
      provenance: provenance('insulation'),
      context: CONTEXT,
    })
    expect(draft.detail?.[0]).toBe('# metacooler test 1234abc')
    expect(draft.detail).toContain('# task: insulation v1')
    expect(draft.detail?.some((line) => line.startsWith('# param window:'))).toBe(true)
  })

  it('names the map it measured, where the session names one', () => {
    const draft = runDraft({
      task: task('insulation'),
      provenance: provenance('insulation'),
      context: CONTEXT,
      where: 'rep3.cool',
    })
    expect(draft.where).toBe('rep3.cool')
  })
})

describe('a run the shell cannot take', () => {
  it('is a sentence with the refusal under it, rather than no line at all', () => {
    // metaplot reads a bigWig, and the bigWig reader lives in the annotations
    // worker: `cliCannotRun` is the one predicate that decides this, for the
    // button and for the console alike.
    const metaplot = task('metaplot')
    const draft = runDraft({
      task: metaplot,
      provenance: provenance('metaplot'),
      context: CONTEXT,
    })
    expect(draft.shell).toBe(false)
    expect(draft.line).toContain(metaplot.title)
    expect(draft.notes?.join(' ')).toContain('annotations worker')
    // The provenance is still there: the run happened, and what it was asked to
    // do is exactly what a reader wants back from a task with no command.
    expect(draft.detail).toContain('# task: metaplot v1')
  })
})

describe('the provenance a job is recorded with before it has one', () => {
  it('is the parameters and the framing it was queued with', () => {
    const insulation = task('insulation')
    const params = { ...defaultParams(insulation.params), window: 12 }
    const record = provisionalProvenance(insulation, params, framing())
    expect(record.task).toBe('insulation')
    // The descriptor's own number, not the worker's placeholder: a result that
    // reaches a reader carrying `0` means a step was skipped.
    expect(record.taskVersion).toBe(insulation.version)
    expect(record.params['window']).toBe(12)
    expect(record.framing.uri).toBe('/data/yeast.mcool::resolutions/1000')
    expect(record.createdAt).not.toBe('')
  })
})
