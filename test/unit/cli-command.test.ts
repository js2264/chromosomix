/**
 * The run on screen, written as the shell command that repeats it.
 *
 * `cli/main.ts` exists because clicking stops being the interface at the second
 * file, and `metacooler-run tasks` answers *what is possible* rather than *what
 * did I just do* — so the reader who spent twenty minutes moving a window and
 * nudging four numbers still had to transcribe those numbers into a shell, by
 * eye, once per task. Transcription is the one step in that loop where the
 * numbers in the figure and the numbers in the table can quietly stop being the
 * same numbers.
 *
 * So what is asserted here is faithfulness, and it is asserted against the
 * **real descriptors** rather than against invented ones: every task in the
 * registry is run through the builder, and what comes out has to be a command
 * the parser on the other side would accept — no flag the task does not declare,
 * no `--window` on the task that claimed the name for a parameter of its own, no
 * entry id where a shell needs a path.
 *
 * The other half is the caveats. A browser knows three things a shell cannot be
 * told — a remote file, a window across several sequences, a parameter naming a
 * set the app itself computed — and each has to arrive as a `#` line above the
 * command rather than as a silent omission, because a command that runs and
 * answers a slightly different question is worse than one that says what it
 * left out.
 */

import { describe, expect, it } from 'vitest'

import { cliCannotRepeat, cliCannotRun, cliCommandFor, quote } from '@/analysis/cliCommand'
import { TASKS, taskById } from '@/analysis/registry'
import type {
  AnalysisContext,
  AnalysisFraming,
  AnalysisTask,
  Params,
  Provenance,
} from '@/analysis/types'
import type { AnnotationEntry } from '@/annotations/types'
import { defaultStyle, emptyPlacement } from '@/annotations/types'

/** Two sequences and a genome over them — enough for every window case. */
const CONTIGS = [
  { name: 'chrIV', length: 1_531_933, startBin: 0, bins: 1532, genome: 0 },
  { name: 'chrXVI', length: 948_066, startBin: 1532, bins: 949, genome: 0 },
]

const N_BINS = 1532 + 949

function framing(patch: Partial<AnalysisFraming> = {}): AnalysisFraming {
  return {
    uri: 'yeast.mcool::resolutions/1000',
    rows: [0, N_BINS],
    cols: [0, N_BINS],
    binsize: 1000,
    binsPerCell: 1,
    balance: true,
    value: 'count',
    normalise: null,
    level: 'bin',
    label: 'whole genome at 1.0 kb bins · balanced · count',
    ...patch,
  }
}

function context(entries: AnnotationEntry[] = []): AnalysisContext {
  return {
    uri: 'yeast.mcool::resolutions/1000',
    layout: 'cool',
    hasMap: true,
    hasGenomes: true,
    hasWeights: true,
    scoreColumns: [],
    binsize: 1000,
    nBins: N_BINS,
    contigs: CONTIGS,
    genomes: [{ name: 'sacCer3', extent: [0, N_BINS], contigs: 2 }],
    entries,
    framing: framing(),
    blockLoaded: false,
    blockBytes: 0,
  }
}

function provenance(task: string, params: Params, patch: Partial<AnalysisFraming> = {}): Provenance {
  return {
    task,
    taskVersion: 1,
    params,
    framing: framing(patch),
    app: 'test',
    createdAt: '2026-09-10T00:00:00Z',
  }
}

/** A loaded row, as the store holds one. */
function entry(id: string, label: string, name: string): AnnotationEntry {
  return {
    id,
    card: 'linear',
    kind: 'segments',
    label,
    source: { kind: 'remote', url: `https://example.org/data/${name}`, name },
    status: 'ready',
    visible: true,
    placement: emptyPlacement(),
    style: defaultStyle('segments', '#000000'),
  }
}

/** Every parameter at whatever the descriptor calls its default. */
function defaultsOf(task: AnalysisTask): Params {
  const params: Record<string, Params[string]> = {}
  for (const spec of task.params) {
    const fallback = (spec as { default?: unknown }).default
    if (fallback !== undefined) params[spec.key] = fallback as Params[string]
  }
  return params
}

/** The command line, without the `#` notes above it. */
function commandOf(text: string): string {
  return text.split('\n').filter((line) => !line.startsWith('#'))[0] ?? ''
}

function notesOf(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('#'))
}

/** `--foo bar --baz` as a map, the way the CLI's own parser reads a line. */
function flagsOf(command: string): Map<string, string | true> {
  const parts = command.split(' ')
  const out = new Map<string, string | true>()
  for (let at = 0; at < parts.length; at++) {
    const part = parts[at]
    if (!part.startsWith('--')) continue
    const eq = part.indexOf('=')
    if (eq !== -1) {
      out.set(part.slice(2, eq), part.slice(eq + 1))
      continue
    }
    const next = parts[at + 1]
    out.set(part.slice(2), next === undefined || next.startsWith('--') ? true : next)
  }
  return out
}

/**
 * The task the window cases run on, chosen rather than picked: `chromosight`
 * declares no parameter called `window`, so the framing's own window reaches
 * `--window` there — which is the case that has to be right for fifteen of the
 * sixteen tasks. Insulation and APA are the two exceptions and get their own
 * test below.
 */
const detect = taskById('chromosight') as AnalysisTask
const insulation = taskById('insulation') as AnalysisTask

describe('the shape of the command', () => {
  it('leads with the command, the task and the file', () => {
    const command = commandOf(
      cliCommandFor({
        task: insulation,
        provenance: provenance('insulation', { region: 'chrIV', scales: [10, 25] } as unknown as Params),
        context: context(),
      }).text,
    )
    expect(command.startsWith('metacooler-run insulation yeast.mcool::resolutions/1000 ')).toBe(
      true,
    )
  })

  it('writes every parameter the task declares, defaults included', () => {
    // A default is a property of the build that wrote it. A command that leans
    // on one repeats this run today and some other run after the default moves,
    // which is the whole reason `copy provenance` lists them all too.
    const params = defaultsOf(insulation)
    const flags = flagsOf(
      commandOf(
        cliCommandFor({
          task: insulation,
          provenance: provenance('insulation', params),
          context: context(),
        }).text,
      ),
    )
    for (const key of Object.keys(params)) {
      if (key === 'balance') continue
      expect(flags.has(key), `--${key} is missing`).toBe(true)
    }
  })

  it('writes a list as one comma-separated value, which is what coerce splits', () => {
    const flags = flagsOf(
      commandOf(
        cliCommandFor({
          task: insulation,
          provenance: provenance('insulation', { scales: [10, 25, 50] } as unknown as Params),
          context: context(),
        }).text,
      ),
    )
    expect(flags.get('scales')).toBe('10,25,50')
  })

  it('writes a boolean as the flag, or as the flag turned off', () => {
    const on = flagsOf(
      commandOf(
        cliCommandFor({ task: detect, provenance: provenance('chromosight', {}), context: context() })
          .text,
      ),
    )
    expect(on.get('balance')).toBe(true)
    const off = flagsOf(
      commandOf(
        cliCommandFor({
          task: detect,
          provenance: provenance('chromosight', {}, { balance: false }),
          context: context(),
        }).text,
      ),
    )
    expect(off.get('balance')).toBe('false')
  })

  /**
   * A record with no `balance` in it — an older session, or a task that gained
   * the parameter since — must not be read as a positive claim that the numbers
   * were unbalanced. The framing always has one, and it is the better answer.
   */
  it('falls back to the framing when the record carries no balance of its own', () => {
    const coverage = taskById('coverage') as AnalysisTask
    expect(coverage.params.some((param) => param.key === 'balance')).toBe(true)
    const flags = flagsOf(
      commandOf(
        cliCommandFor({ task: coverage, provenance: provenance('coverage', {}), context: context() })
          .text,
      ),
    )
    expect(flags.get('balance')).toBe(true)
  })
})

describe('the window', () => {
  it('is left out when the view is the whole file', () => {
    const flags = flagsOf(
      commandOf(
        cliCommandFor({ task: detect, provenance: provenance('chromosight', {}), context: context() })
          .text,
      ),
    )
    expect(flags.has('window')).toBe(false)
  })

  it('is the sequence’s name when the view is the whole of one', () => {
    const flags = flagsOf(
      commandOf(
        cliCommandFor({
          task: detect,
          provenance: provenance('chromosight', {}, { rows: [1532, 2481], cols: [1532, 2481] }),
          context: context(),
        }).text,
      ),
    )
    // `chrXVI`, not `chrXVI:0-948066`: it is what a reader recognises and what
    // the range parser resolves without arithmetic.
    expect(flags.get('window')).toBe('chrXVI')
  })

  it('is a locus in base pairs when the view is part of one', () => {
    const flags = flagsOf(
      commandOf(
        cliCommandFor({
          task: detect,
          provenance: provenance('chromosight', {}, { rows: [1632, 1732], cols: [1632, 1732] }),
          context: context(),
        }).text,
      ),
    )
    // 0-based half-open, from the contig's own first base — cooler's parser
    // reads the digits as written and applies no 1-based conversion.
    expect(flags.get('window')).toBe('chrXVI:100000-200000')
  })

  it('says so, and runs over the whole file, when the view crosses sequences', () => {
    const built = cliCommandFor({
      task: detect,
      provenance: provenance('chromosight', {}, { rows: [1000, 2000], cols: [1000, 2000] }),
      context: context(),
    })
    expect(flagsOf(commandOf(built.text)).has('window')).toBe(false)
    expect(notesOf(built.text).join(' ')).toContain('several sequences')
  })

  it('says so for an off-diagonal block, which is two windows and not one', () => {
    const built = cliCommandFor({
      task: detect,
      provenance: provenance('chromosight', {}, { rows: [0, 1532], cols: [1532, 2481] }),
      context: context(),
    })
    expect(flagsOf(commandOf(built.text)).has('window')).toBe(false)
    expect(notesOf(built.text).join(' ')).toContain('off-diagonal')
  })

  /**
   * `apa` declares a parameter called `window` — a half-width in bins — and
   * `cli/main.ts` therefore ignores `--window` for it. Writing one anyway would
   * be a flag the command drops *and* a locus assigned to that half-width.
   */
  it('is never written for a task that claimed the name for a parameter', () => {
    // Both of them: `apa`'s window is a half-width in bins and insulation's is a
    // diamond size, and either would have been handed `chrXVI:100000-200000`.
    for (const [id, value] of [
      ['apa', 8],
      ['insulation', 10],
    ] as const) {
      const task = taskById(id) as AnalysisTask
      expect(task.params.some((param) => param.key === 'window')).toBe(true)
      const flags = flagsOf(
        commandOf(
          cliCommandFor({
            task,
            provenance: provenance(id, { window: value }, { rows: [1632, 1732], cols: [1632, 1732] }),
            context: context(),
          }).text,
        ),
      )
      expect(flags.get('window')).toBe(String(value))
    }
  })
})

describe('a parameter that names something loaded', () => {
  const apa = taskById('apa') as AnalysisTask
  const pairSet = apa.params.find((param) => param.kind === 'pairSet')

  it('is written as a file name, with the load that reads it', () => {
    expect(pairSet, 'apa should take a pair set').toBeTruthy()
    const rows = [entry('ann:3', 'HiCCUPS loops', 'loops.bedpe')]
    const command = commandOf(
      cliCommandFor({
        task: apa,
        provenance: provenance('apa', { [pairSet!.key]: 'ann:3' }),
        context: context(rows),
      }).text,
    )
    // The entry id is a handle this tab allocated; the shell needs the file, and
    // the load that parses it. Both, because `cli/main.ts` files a load under
    // its base name and looks the parameter up by that.
    expect(command).not.toContain('ann:3')
    expect(command).toContain('--pairs loops.bedpe')
    expect(flagsOf(command).get(pairSet!.key)).toBe('loops.bedpe')
  })

  it('says so when the set has no file behind it', () => {
    // A loop set this app called. There is nothing for `--pairs` to point at,
    // and a command that quietly dropped the input would run the task over
    // nothing and report a clean aggregate of it.
    const computed: AnnotationEntry = {
      ...entry('analysis:chromosight:x', 'Detected loops', 'x'),
      kind: 'pairs',
      source: {
        kind: 'computed',
        name: 'Detected loops',
        task: 'chromosight',
        recipe: { taskVersion: 1, params: {} },
        framing: 'chrIV at 1 kb',
      },
    }
    const built = cliCommandFor({
      task: apa,
      provenance: provenance('apa', { [pairSet!.key]: computed.id }),
      context: context([computed]),
    })
    expect(notesOf(built.text).join(' ')).toContain('no file behind it')
    expect(notesOf(built.text).join(' ')).toContain('Detected loops')
    expect(commandOf(built.text)).not.toContain(computed.id)
  })
})

describe('a run with no contact map', () => {
  /**
   * The framing `AnalysisRunner.tracksFraming` writes: a 1D browser session
   * (§5.8) has the bigWigs and not the map, and a result is still a record of
   * something — so what it names there is the assembly, over a zero-wide extent.
   */
  const mapless: Partial<AnalysisFraming> = {
    uri: 'https://example.org/data/Yeast_ATAC.bw',
    rows: [0, 0],
    cols: [0, 0],
    label: 'Yeast_ATAC.bw · loaded tracks, no contact map',
  }

  it('is refused rather than written against the file that named the assembly', () => {
    // `metacooler-run overlap Yeast_ATAC.bw` reads perfectly well and fails at
    // the open: the command takes a contact map as its first argument, and a
    // browser session has none. That is the one outcome this module exists to
    // prevent, so it is a refusal and not a line.
    const overlap = taskById('overlap') as AnalysisTask
    const built = cliCommandFor({
      task: overlap,
      provenance: provenance('overlap', defaultsOf(overlap), mapless),
      context: context(),
    })
    expect(built.text).toBe('')
    expect(built.refusal).toContain('no contact map')
    expect(built.refusal).toContain('first argument')
  })

  it('is the same predicate the button is greyed by', () => {
    const overlap = taskById('overlap') as AnalysisTask
    const record = provenance('overlap', defaultsOf(overlap), mapless)
    // One rule for both, or the button hands over a line the command rejects.
    expect(cliCannotRepeat(overlap, record)).toBe(
      cliCommandFor({ task: overlap, provenance: record, context: context() }).refusal,
    )
    // And the descriptor alone cannot see it, which is why there are two.
    expect(cliCannotRun(overlap)).toBeNull()
  })

  it('still writes the line for the same task over a map', () => {
    const overlap = taskById('overlap') as AnalysisTask
    const built = cliCommandFor({
      task: overlap,
      provenance: provenance('overlap', defaultsOf(overlap)),
      context: context(),
    })
    expect(built.refusal).toBeNull()
    expect(commandOf(built.text).startsWith('metacooler-run overlap yeast.mcool')).toBe(true)
  })
})

describe('a parameter whose load is its own flag', () => {
  it('writes --sequence once rather than twice', () => {
    // `motif` calls its reference `sequence`, which is also the flag the CLI
    // reads references from: `loadSequences` files one under the path it was
    // given and `params.sequence` holds that same path, so one token pair does
    // both jobs. Written twice, the line parsed the same FASTA twice to arrive
    // at the same answer and read like a mistake.
    const motif = taskById('motif') as AnalysisTask
    const built = cliCommandFor({
      task: motif,
      provenance: provenance('motif', { ...defaultsOf(motif), sequence: 'a1' }),
      context: context([entry('a1', 'S288c', 'S288c.fa.gz')]),
    })
    const command = commandOf(built.text)
    expect(command.split('--sequence').length - 1).toBe(1)
    expect(command).toContain('--sequence S288c.fa.gz')
  })

  it('leaves the pair alone where the two names differ', () => {
    // `compartments` names its reference `phaseSequence`, so the load and the
    // binding are two different flags and both are needed: one puts the file in
    // the map, the other says which parameter chose it.
    const compartments = taskById('compartments') as AnalysisTask
    const built = cliCommandFor({
      task: compartments,
      provenance: provenance('compartments', {
        ...defaultsOf(compartments),
        phaseSequence: 'a1',
      }),
      context: context([entry('a1', 'S288c', 'S288c.fa.gz')]),
    })
    const command = commandOf(built.text)
    expect(command).toContain('--sequence S288c.fa.gz')
    expect(command).toContain('--phaseSequence S288c.fa.gz')
  })
})

describe('what a shell cannot be given', () => {
  it('names a remote file and says it has to be fetched first', () => {
    const built = cliCommandFor({
      task: insulation,
      provenance: provenance('insulation', {}, { uri: 'https://example.org/yeast.mcool' }),
      context: context(),
    })
    expect(commandOf(built.text)).toContain('https://example.org/yeast.mcool')
    expect(notesOf(built.text).join(' ')).toContain('remote')
  })

  /**
   * A task that reads a track is refused before anything is opened, by the same
   * predicate the command itself consults — so the button that would write the
   * line and the command that would reject it cannot disagree.
   */
  it('refuses a task the command could not start, in the command’s own words', () => {
    const metaplot = taskById('metaplot') as AnalysisTask
    const refusal = cliCannotRun(metaplot)
    expect(refusal).not.toBeNull()
    const built = cliCommandFor({
      task: metaplot,
      provenance: provenance('metaplot', {}),
      context: context(),
    })
    expect(built.refusal).toBe(refusal)
    expect(built.text).toBe('')
  })
})

describe('every task in the registry', () => {
  /**
   * The broad guard, and the one that will catch a task added later. Whatever
   * the descriptor, the line has to be one the parser accepts: `paramsFor`
   * throws on a flag the task does not declare unless it is one of the CLI's
   * own reserved names, so an unknown flag here is a command that dies at exit 2
   * before a file is opened.
   */
  const RESERVED = new Set([
    'out', 'o', 'window', 'balance', 'features', 'pairs', 'over', 'quiet', 'help',
    'bin-size', 'binsize', 'rungs', 'sequence',
  ])

  for (const task of TASKS) {
    it(`writes a line ${task.id} would accept`, () => {
      if (cliCannotRun(task) !== null) return
      const built = cliCommandFor({
        task,
        provenance: provenance(task.id, defaultsOf(task)),
        context: context(),
      })
      expect(built.refusal).toBeNull()
      const command = commandOf(built.text)
      const declared = new Set(task.params.map((param) => param.key))
      for (const key of flagsOf(command).keys()) {
        expect(declared.has(key) || RESERVED.has(key), `--${key} is not a flag ${task.id} takes`)
          .toBe(true)
      }
      // And the subject is always there, whatever the task.
      expect(command.startsWith(`metacooler-run ${task.id} yeast.mcool`)).toBe(true)
    })
  }
})

describe('quoting', () => {
  it('leaves a plain path alone', () => {
    expect(quote('data/yeast.mcool::resolutions/1000')).toBe('data/yeast.mcool::resolutions/1000')
  })

  it('quotes anything a shell would read', () => {
    expect(quote('my data (copy).cool')).toBe("'my data (copy).cool'")
    expect(quote('$HOME/x.cool')).toBe("'$HOME/x.cool'")
  })

  it('survives a single quote in the name', () => {
    // The `'\''` dance: close, escape one, reopen. Inside single quotes a POSIX
    // shell interprets nothing at all, which is why this is the only quoting
    // that is right for every byte.
    expect(quote("o'brien.cool")).toBe("'o'\\''brien.cool'")
  })

  it('writes an empty value as an empty argument, not as nothing', () => {
    expect(quote('')).toBe("''")
  })
})
