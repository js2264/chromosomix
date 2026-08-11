/**
 * What counts as "the same workspace", which is one line and two decisions.
 *
 * Everything a reader sets up around a file but does not put in a link — the
 * hand-drawn marks, the ticked sequences, a table's filter, how a group of tracks
 * is scaled — hangs on one key. Getting that key wrong does not throw and does
 * not draw anything wrong; it silently answers with somebody else's workspace, or
 * with none.
 *
 * Both halves have been wrong at some point. Without the session id, a second tab
 * on the same file adopted the first one's tracks. With the *entry* in it, every
 * one of those things was lost the moment a reader changed resolution — and lost
 * invisibly, because the previous level's memory stayed in storage under its own
 * key, so it came back if they switched back and stayed gone if they did not. A
 * mark is a contig and a base pair (§8.1); it means the same thing at 1 kb and at
 * 5 kb, which is exactly why the key must not mention the grid.
 */

import { describe, expect, it } from 'vitest'

import { fileMemoryKey, recall, remember } from '@/state/UiMemory'

describe('the key a session’s memory hangs on', () => {
  it('is the same for every resolution of one file', () => {
    const at1kb = fileMemoryKey('s1', 'demo.mcool::resolutions/1000')
    const at5kb = fileMemoryKey('s1', 'demo.mcool::resolutions/5000')
    expect(at1kb).toBe(at5kb)
    // …and for the file addressed at its root, which is how it is dropped.
    expect(fileMemoryKey('s1', 'demo.mcool')).toBe(at1kb)
  })

  it('is the same for every entry of one collection, which is one dataset', () => {
    expect(fileMemoryKey('s1', 'runs.mmetacool::entries/rep1')).toBe(
      fileMemoryKey('s1', 'runs.mmetacool::entries/rep2'),
    )
  })

  it('is not the same for two files', () => {
    expect(fileMemoryKey('s1', 'a.mcool::resolutions/1000')).not.toBe(
      fileMemoryKey('s1', 'b.mcool::resolutions/1000'),
    )
  })

  it('is not the same for two tabs, which is what tabs are for', () => {
    expect(fileMemoryKey('s1', 'demo.mcool')).not.toBe(fileMemoryKey('s2', 'demo.mcool'))
  })

  it('carries a mark across a change of resolution, end to end', () => {
    // The bug as the reader met it: two marks placed at 2 kb, gone at 5 kb.
    const marks = [{ id: 'm1', kind: 'line', axis: 'vertical', at: { contig: 'II', bp: 1500 } }]
    remember(fileMemoryKey('s9', 'demo.mcool::resolutions/2000'), 'manual-annotations', marks)
    expect(
      recall(fileMemoryKey('s9', 'demo.mcool::resolutions/5000'), 'manual-annotations'),
    ).toEqual(marks)
  })
})
