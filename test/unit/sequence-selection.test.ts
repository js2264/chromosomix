/**
 * Which sequences are on the browser's axis.
 *
 * The interesting behaviour is all in `restrict`, and specifically in when it
 * returns the assembly *itself*: the browser rebuilds its axis on every
 * notification, so an equal-but-fresh assembly would rebuild the coordinate
 * model — and reset the view — for a change that changed nothing.
 */

import { describe, expect, it, vi } from 'vitest'

import { assemblyOf } from '@/genome/assembly'
import { SequenceSelection } from '@/genome/selection'

const yeast = assemblyOf({
  uri: 'sacCer3.chrom.sizes',
  name: 'sacCer3',
  origin: 'sizes',
  contigs: [
    { name: 'chrI', length: 230_218 },
    { name: 'chrII', length: 813_184 },
    { name: 'chrIII', length: 316_620 },
  ],
})

describe('SequenceSelection', () => {
  it('is the whole genome until something is ticked', () => {
    const selection = new SequenceSelection()
    expect(selection.isWhole).toBe(true)
    expect(selection.restrict(yeast)).toBe(yeast)
  })

  it('narrows the assembly to the ticked sequences, in assembly order', () => {
    const selection = new SequenceSelection(['chrIII', 'chrI'])
    const view = selection.restrict(yeast)
    expect(view.contigs.map((contig) => contig.name)).toEqual(['chrI', 'chrIII'])
    expect(view.total).toBe(230_218 + 316_620)
    // The genome's own identity travels with it: the card above the axis still
    // names the file, not the part of it being read.
    expect(view.name).toBe('sacCer3')
  })

  it('hands back the same assembly when the selection changes nothing', () => {
    expect(new SequenceSelection(['chrI', 'chrII', 'chrIII']).restrict(yeast)).toBe(yeast)
    // A stored selection naming sequences this assembly does not have is a
    // restriction with no way back — it degrades to the whole genome instead.
    expect(new SequenceSelection(['chr1', 'chr2']).restrict(yeast)).toBe(yeast)
  })

  it('notifies and persists once per real change', () => {
    const persist = vi.fn()
    const listener = vi.fn()
    const selection = new SequenceSelection([], persist)
    selection.subscribe(listener)

    selection.toggle('chrI', true)
    expect(selection.names).toEqual(['chrI'])
    expect(persist).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)

    // Ticking what is already ticked is not a change.
    selection.toggle('chrI', true)
    expect(listener).toHaveBeenCalledTimes(1)

    selection.toggle('chrI', false)
    expect(selection.isWhole).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('ensure() widens a selection but never starts one', () => {
    const selection = new SequenceSelection()
    // Nothing is ticked, so everything is already on the axis: going somewhere
    // must not silently restrict the view to wherever that was.
    selection.ensure('chrII')
    expect(selection.isWhole).toBe(true)

    selection.toggle('chrI', true)
    selection.ensure('chrII')
    expect(selection.names).toEqual(['chrI', 'chrII'])
    selection.ensure('chrII')
    expect(selection.names).toEqual(['chrI', 'chrII'])
  })

  it('unsubscribes', () => {
    const selection = new SequenceSelection()
    const listener = vi.fn()
    const off = selection.subscribe(listener)
    off()
    selection.toggle('chrI', true)
    expect(listener).not.toHaveBeenCalled()
  })
})
