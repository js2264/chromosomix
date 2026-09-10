/**
 * Finding a sequence, as a descriptor.
 *
 * The one question every genome browser is expected to answer and this one could
 * not: *where is `GGTCANNNTGACC`?* It is also the only question in the catalogue
 * whose answer is in no file the reader could drop — it has to be computed from
 * the residues — and it has a natural shape here, because what comes back is a
 * set of intervals and a per-bin count, which are the two objects §18.5 says a
 * task should produce when it wants to be looked at rather than read.
 *
 * ## Why it is a task and not the search box
 *
 * `ui/SearchBox.ts` looks up a locus or a feature *name*, answers instantly from
 * an index already in memory, and puts one result on screen by navigating to it.
 * A motif search is none of those: it reads a whole genome, it takes long enough
 * to need a progress state and a failure state, and its answer is thousands of
 * places rather than one. That list — configured somewhere, priced before it
 * runs, stamped with what it ran on, and outliving the view that started it — is
 * the definition of a job in §18's opening paragraph, and the difference between
 * this and the bespoke card it replaces is everything that follows from being
 * one: the generic form, a stored recipe, provenance on both outputs, a CLI flag
 * per parameter, **Run on all maps**, and rows that come back after a reload
 * with a **Recompute** button rather than silently not coming back at all.
 *
 * ## Why the venue is `annotations`
 *
 * Because the residues are in that worker and nowhere else. A FASTA is parsed
 * there and deliberately never shipped out whole — `bases` answers a *window*
 * and is capped — so a search anywhere else would mean either hauling twelve
 * megabytes across a thread boundary or issuing thirty windowed reads and
 * stitching the seams. It is the same argument the metaplot makes for its own
 * inputs (`analysis/job.ts`), and the capability it needs is
 * `TrackJobContext.residues`.
 *
 * ## The pattern is the one free-text parameter in the catalogue
 *
 * Every other control here names a file, a number, or a choice from a list.
 * A motif is none of those: it is a string in the IUPAC alphabet, out of a space
 * no dropdown could enumerate. {@link TextParam} exists for it, and exists
 * rather than the pattern borrowing the locus box, which would have offered the
 * file's chromosome names as suggestions under a tooltip promising it took a
 * locus. What checks the string is this task's own {@link estimate}, through
 * `compileMotif` — the same function the run uses, so the sentence a reader sees
 * before pressing **Run** is the sentence the runner would have produced.
 */

import { compileMotif, isMotifRefusal } from '../../annotations/motif'
import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { READY, waitingFor } from '../types'

/**
 * How many sites one run may report.
 *
 * Generous on purpose: `GATC` is about 40,000 sites in yeast and a reader
 * looking for a restriction map wants all of them, so a cap that trimmed a
 * genuine answer would be worse than no feature at all. What it is here for is
 * the pathological ask — a single `N`, or `NN` — which on a mammalian reference
 * is three billion hits and would exhaust memory before anything reached the
 * screen.
 *
 * A **parameter** rather than a constant in the worker, unlike the card's
 * version of it, and the reason is §18.4 rather than flexibility: what a run was
 * capped at is part of what the run *was*, so it belongs in the provenance and
 * in the header of every table exported from it. Past it the search stops and
 * says so — in a note, and in the lane's own summary — because a lane that is
 * silently a prefix of the answer is the one failure a reader cannot see.
 *
 * **It is the ceiling as well as the default, and that has to be said out
 * loud.** `analysis/run/motif.ts` clamps the scan to this number whatever the
 * parameter asks for — the memory it guards is the annotations worker's, and a
 * reader who types eight digits into a box would exhaust it before anything
 * reached the screen. For a while only the clamp knew that: the spec below
 * carried `min` and no `max`, so the form accepted 2,000,000, the run capped at
 * 500,000 anyway, and the truncation note quoted the reader's number and told
 * them to *raise* a control that had stopped meaning anything. A reader who
 * followed that instruction got a byte-identical answer and the same sentence
 * again. So the bound is on the spec — the form cannot produce an impossible
 * number — and the runner clamps a second time for the stored recipe, the batch
 * and the CLI, none of which pass through a form. What the provenance records is
 * still the number that was *asked* for and not the one the run used
 * (`analysis/worker/analysis.worker.ts` argues that policy), which is exactly
 * why the ceiling must be visible in the form and in the note rather than
 * applied silently inside the scan.
 */
export const MOTIF_SITE_LIMIT = 500_000

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequence',
    key: 'sequence',
    label: 'Reference',
    hint: 'The FASTA to search. Its own sequences, in its own order.',
  },
  {
    kind: 'text',
    key: 'pattern',
    label: 'Sequence',
    placeholder: 'GGTCANNNTGACC',
    hint:
      'IUPAC: A C G T U, and the ambiguity codes R Y S W K M B D H V N. Spaces are ignored, ' +
      'case is ignored, and overlapping matches all count.',
  },
  {
    kind: 'toggle',
    key: 'bothStrands',
    label: 'Both strands',
    // On by default, because a motif that is not palindromic occurs on both
    // strands of a double-stranded molecule whether or not anybody searched for
    // it, and a reader who asked where `GGTCA` is and got half the sites would
    // have no way of knowing which half. A palindrome is still reported once —
    // see `annotations/motif.ts`, which is where that decision lives.
    hint: 'A palindrome is still reported once, not twice.',
    default: true,
  },
  {
    kind: 'number',
    key: 'limit',
    label: 'Most sites',
    // The ceiling is written from the constant rather than typed out, so a hint
    // promising a number the scan does not honour cannot come back by drift.
    hint:
      `A backstop against a pattern like N. Up to ${MOTIF_SITE_LIMIT.toLocaleString()}; ` +
      'the run says so when it bites.',
    default: MOTIF_SITE_LIMIT,
    min: 1,
    // Both bounds, because {@link MOTIF_SITE_LIMIT} is the ceiling and not only
    // the default: `ParamForm.numberControl` clamps on `change` and on Enter
    // only for a bound that is defined, so a `min` alone let the box commit a
    // number the run would quietly ignore. With the `max` here the box carries
    // it in the DOM too, and the value that reaches the provenance is one the
    // run can honour.
    max: MOTIF_SITE_LIMIT,
    integer: true,
  },
]

/**
 * The pattern, cleaned the way `compileMotif` cleans it.
 *
 * Whitespace out, because a motif copied out of a paper arrives as
 * `GGTCA NNN TGACC` about as often as not; upper case, because a repeat-masked
 * reference writes its repeats in lower case and case means nothing to a search.
 */
export function motifPattern(params: Params): string {
  const value = params.pattern
  return typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : ''
}

/**
 * Priced before it runs, and refused where the parameters cannot answer.
 *
 * **`free` rather than `bounded` or `scan`**, and the three classes make that
 * unambiguous rather than approximate (§18.6): they are about *reads*, and this
 * task performs none at all — no range requests, no bytes, no matrix. The
 * residues are already in memory, having been read when the reader dropped the
 * file, and the scan is one linear pass over them.
 *
 * That is not the same as free of *time*: a scan is one mask test per base of
 * the motif at every position of the reference. The note says so, because a
 * class that prices the reads and a sentence that prices the wait are two
 * different honesties and the reader needs both.
 *
 * **The wait it prices is the one this app can actually reach.** The sentence
 * used to end "a minute or so on a mammalian one", which was a price for a run
 * nobody can start: `annotations/worker/annotations.worker.ts` refuses a FASTA
 * over `FASTA_BYTE_CAP` — 300 MB, checked on the local file's size and again on
 * the decoded bytes — with a refusal saying in as many words that a mammalian
 * genome is the wrong thing to open this way. The largest reference that reaches
 * this task is therefore a few hundred megabases, which is seconds and not a
 * minute, and a sentence that overprices the wait teaches a reader to expect a
 * hang the code has already ruled out.
 */
function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const free = { class: 'free' as const, requests: 0, bytes: 0, note: 'Nothing to read.' }
  const entry = params.sequence
  if (typeof entry !== 'string' || entry === '') {
    return {
      ...free,
      refusal: 'Choose a reference to search. A FASTA dropped on the Annotations panel is one.',
    }
  }
  // The matcher's own sentence, from the same function the runner calls. Said
  // *here* so a reader who typed `ACGX` reads why with **Run** still greyed,
  // rather than pressing it and reading the answer in the drawer afterwards.
  const compiled = compileMotif(motifPattern(params))
  if (isMotifRefusal(compiled)) return { ...free, refusal: compiled.reason }

  const sequence = context.entries.find((row) => row.id === entry)
  const bases = totalBases(context)
  return {
    class: 'free',
    requests: 0,
    bytes: 0,
    note:
      `No file reads at all: one pass over ${sequence?.label ?? 'the reference'}` +
      `${bases === 0 ? '' : `, ${(bases / 1e6).toFixed(1)} Mb`}, in the worker that already ` +
      `holds it. ${compiled.length} ${compiled.length === 1 ? 'base' : 'bases'} tested per ` +
      'position, so it is a moment on a yeast genome and a few seconds on the largest ' +
      'reference this can hold.',
  }
}

/**
 * The assembly's residues, in base pairs, or `0` where the context has none.
 *
 * The *assembly's* rather than the loaded FASTA's, because the entry carries no
 * length and this is a sentence about scale rather than an accounting: a session
 * whose contigs total 12 Mb is a yeast search however the FASTA is spelled.
 */
function totalBases(context: AnalysisContext): number {
  let total = 0
  for (const contig of context.contigs) total += contig.length
  return total
}

export const MOTIF_TASK: AnalysisTask = {
  id: 'motif',
  title: 'Find a sequence',
  blurb: 'Every place a motif occurs, as sites and as a density track.',
  group: 'tracks',
  // The residues live in the annotations worker and are never shipped out
  // whole, so the search goes to them — see the module docstring and
  // `analysis/job.ts`'s `SequenceReader`.
  venue: 'annotations',
  version: 1,
  /**
   * **Waiting, never absent** — the second of §18.1's two kinds of "cannot".
   *
   * A metagenome task on a plain cooler is `absent`: nothing the reader does
   * here produces a `/genomes` table, so listing it would offer something that
   * is not on the menu. A motif search with no reference open is the other kind
   * entirely — it applies perfectly well to this session and is one drag away —
   * and hiding it would teach a reader who has not met the app before that it
   * cannot search a sequence, which is the wrong lesson and the harder one to
   * unlearn. **No map is required either:** this reads a FASTA and nothing else,
   * so it is offered in a 1D browser session exactly as it is beside a map.
   */
  availability: (context) =>
    context.entries.some((entry) => entry.kind === 'sequence')
      ? READY
      : waitingFor('Load a FASTA — the reference to search. Its residues are what this reads.'),
  params: PARAMS,
  // The two lanes `annotations/motifTrack.ts` argues for: a set of sites answers
  // "where exactly" and is a picket fence at chromosome scale; a density answers
  // "how dense here" and is a bar chart of ones at base scale. Neither picture
  // is both, so both are made from the one scan.
  outputs: ['intervals', 'profile'],
  estimate,
}
