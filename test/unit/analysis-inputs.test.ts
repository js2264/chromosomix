/**
 * A task's inputs are the loaded files, so the form has to hear about them.
 *
 * The failure this pins produced no error and no wrong number. Open a cooler,
 * open the Analysis panel, drop a loop table, press **Run** on APA — and get
 * *No loop set was chosen*, over a Pairs dropdown that had been empty since
 * before the file existed. `AnalysisWorkspace` subscribed to the runner and to
 * nothing else, and the only thing that pushed a fresh `AnalysisContext` into
 * the form was `Session.syncAnalysis`, which runs after a *view* mounts.
 * Dropping a file mounts no view.
 *
 * The subscription is guarded rather than unconditional, because the store fires
 * on every tick of a colour drag and re-reading a context refills every control
 * — including a column list that reads four hundred features to do it. What a
 * form actually depends on is which entries exist and what they are, which is
 * what {@link entrySignature} captures and what these tests are about.
 */

import { describe, expect, it } from 'vitest'

import { entrySignature } from '@/analysis/workspace'
import { AnnotationStore } from '@/annotations/store'
import { defaultStyle, placementOn } from '@/annotations/types'

let counter = 0

function store(): AnnotationStore {
  const held = new AnnotationStore(`inputs-${counter++}.cool`)
  held.clear()
  return held
}

/** A loaded file, at the point it becomes usable as a task's input. */
function load(held: AnnotationStore, id: string, kind: 'pairs' | 'segments' | 'track'): void {
  held.begin({
    card: kind === 'pairs' ? 'overlay' : 'linear',
    kind,
    id,
    label: id,
    source: { kind: 'remote', url: `https://example.invalid/${id}`, name: id },
    placement: placementOn('bottom'),
    style: defaultStyle(kind, '#0072b2'),
  })
  held.update(id, { status: 'ready' })
}

describe('what makes a task’s inputs different', () => {
  it('changes when a file arrives, which is the case that was missed', () => {
    const held = store()
    const before = entrySignature(held)
    load(held, 'loops.bedpe', 'pairs')
    expect(entrySignature(held)).not.toBe(before)
  })

  it('changes when a file finishes loading, not only when it is dropped', () => {
    // The placeholder row goes in at `loading` and is not a candidate yet; the
    // form has to be told again when the bytes land.
    const held = store()
    held.begin({
      card: 'overlay',
      kind: 'pairs',
      id: 'loops.bedpe',
      label: 'loops',
      source: { kind: 'remote', url: 'https://example.invalid/loops', name: 'loops' },
      placement: placementOn('bottom'),
      style: defaultStyle('pairs', '#0072b2'),
    })
    const loading = entrySignature(held)
    held.update('loops.bedpe', { status: 'ready' })
    expect(entrySignature(held)).not.toBe(loading)
  })

  it('changes when a file is removed', () => {
    const held = store()
    load(held, 'loops.bedpe', 'pairs')
    const before = entrySignature(held)
    held.remove('loops.bedpe')
    expect(entrySignature(held)).not.toBe(before)
  })

  it('does not change for a colour, which fires on every pointer move', () => {
    // The whole reason this is a signature and not a plain `subscribe`. A drag
    // across the colour picker is dozens of store changes a second, and each one
    // would otherwise refill every control in the open form.
    const held = store()
    load(held, 'peaks.bed', 'segments')
    const before = entrySignature(held)
    held.restyle('peaks.bed', { colour: '#d55e00' })
    held.restyle('peaks.bed', { colour: '#009e73' })
    expect(entrySignature(held)).toBe(before)
  })

  it('does not change for a height, an edge or a group', () => {
    const held = store()
    load(held, 'peaks.bed', 'segments')
    const before = entrySignature(held)
    held.restyle('peaks.bed', { size: 140, group: 'atac' })
    held.place('peaks.bed', placementOn('left'))
    expect(entrySignature(held)).toBe(before)
  })

  it('tells two files of different kinds apart', () => {
    // A BEDPE and a BED are one shape and two meanings, and only one of them can
    // be an APA anchor pair. A signature that dropped `kind` would let a form
    // built against one go on believing it had the other.
    const a = store()
    load(a, 'x', 'pairs')
    const b = store()
    load(b, 'x', 'segments')
    expect(entrySignature(a)).not.toBe(entrySignature(b))
  })
})
