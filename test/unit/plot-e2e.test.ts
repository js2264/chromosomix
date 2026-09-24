/**
 * `metacooler-plot`, end to end: the built command, a real Chromium, the
 * committed demo workspaces, and the files it writes (§27).
 *
 * Every other test of this command stops at a seam; this one goes through all
 * of them, because the ways it can fail that matter most are between the parts
 * — a harness the page never installed, a figure the page drew and the command
 * never read, a tab that failed and took the next tab with it.
 *
 * It needs three things a fresh clone has not got, and skips by name without
 * them: the viewer built with the harness in it (`dist/`, from
 * `npm run build:cli`), the command itself (`dist-cli/metacooler-plot.mjs`), and
 * a Chromium the command can find. CI's fixture-free job has none of them, so
 * there it is a skip rather than a pass.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { findBrowser } from '@/cli/chrome'

const COMMAND = resolve('dist-cli/metacooler-plot.mjs')
const VIEWER = resolve('dist')

/** Whether `dist/` is a viewer with the plot harness in it — a build from before it would wait a minute and fail. */
function viewerHasHarness(): boolean {
  try {
    return (
      existsSync(join(VIEWER, 'index.html')) &&
      readdirSync(join(VIEWER, 'assets')).some((name) => /^harness-.*\.js$/.test(name))
    )
  } catch {
    return false
  }
}

const browser = findBrowser(undefined)
const ready = existsSync(COMMAND) && viewerHasHarness() && browser.path !== null
const suite = ready ? describe : describe.skip

interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

function plot(args: string[]): Ran {
  const ran = spawnSync(process.execPath, [COMMAND, ...args], {
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, SOURCE_DATE_EPOCH: '1767225600' },
  })
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

/** A PNG's pixel size, from its header. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

suite('metacooler-plot, on the demo workspaces', () => {
  let out = ''
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), 'metacooler-plot-e2e-'))
  })
  afterAll(() => rmSync(out, { recursive: true, force: true }))

  it('saves the map of a workspace, as its Export card would, and prints where', () => {
    const ran = plot(['demo/yeast/Yeast_microC.metacooler.json', '-o', join(out, 'map'), '--dpi', '96', '-q'])
    expect(ran.stderr).toBe('')
    expect(ran.code).toBe(0)
    const written = ran.stdout.trim().split('\n')
    expect(written).toEqual([join(out, 'map', 'Yeast_microC_G2M_1kb.png')])
    const size = pngSize(written[0])
    // A map with its lanes on two edges and a caption under it.
    expect(size.width).toBeGreaterThan(600)
    expect(size.height).toBeGreaterThan(600)
  }, 240_000)

  it('saves a 1D browser as a vector PDF, dated by SOURCE_DATE_EPOCH', () => {
    const ran = plot(['demo/yeast/Yeast_tracks.metacooler.json', '-o', join(out, 'tracks'), '--format', 'pdf', '-q'])
    expect(ran.code).toBe(0)
    const [path] = ran.stdout.trim().split('\n')
    const text = readFileSync(path).toString('latin1')
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text).toContain('/CreationDate (D:20260101')
  }, 240_000)

  it('plots a tab over another file, and at a locus, each under its own name', () => {
    const ran = plot([
      'demo/yeast/Yeast_microC.metacooler.json',
      '-o',
      join(out, 'over'),
      '--over',
      'demo/yeast/Yeast_hic.hic',
      '--region',
      'XV',
      '--dpi',
      '48',
      '-q',
    ])
    expect(ran.code).toBe(0)
    expect(ran.stdout.trim().split('\n')).toEqual([join(out, 'over', 'Yeast_hic.png'), join(out, 'over', 'Yeast_hic.XV.png')])
  }, 240_000)

  // One tab that cannot be read is a failure of that tab, not of the run.
  it('carries on past a tab it cannot draw, says why, and exits 1', () => {
    const workspace = JSON.parse(readFileSync('demo/yeast/Yeast_microC.metacooler.json', 'utf8')) as {
      tabs: Array<{ state: { uri: string }; name?: string; tracks: unknown[] }>
    }
    const good = workspace.tabs[0]
    const broken = { ...structuredClone(good), name: 'broken', tracks: [], state: { ...good.state, uri: 'broken.cool' } }
    workspace.tabs = [broken, good]
    const dir = mkdtempSync(join(out, 'ws-'))
    writeFileSync(join(dir, 'broken.cool'), 'this is not an HDF5 file')
    writeFileSync(join(dir, 'two.metacooler.json'), JSON.stringify(workspace))
    const ran = plot([join(dir, 'two.metacooler.json'), '--data', resolve('demo/yeast'), '-o', join(out, 'two'), '--dpi', '48'])
    expect(ran.code).toBe(1)
    expect(ran.stderr).toMatch(/\[1\/2\] broken\n {2}failed: /)
    // Named by the path the reader gave, not the address the page read it at.
    expect(ran.stderr).toContain(join(dir, 'broken.cool'))
    expect(ran.stderr).not.toMatch(/127\.0\.0\.1/)
    expect(ran.stdout.trim().split('\n')).toEqual([join(out, 'two', 'Yeast_microC_G2M_1kb.png')])
    expect(ran.stderr).toMatch(/1 file written, 1 failure/)
  }, 240_000)
})
