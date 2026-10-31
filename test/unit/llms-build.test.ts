/**
 * The site build's half of the files for language models (`scripts/llms.mjs`):
 * that a Vite server made for the purpose loads the app's renderers and gets
 * back exactly what they write in memory, `llms-full.txt` folded after them.
 *
 * Under `node` rather than jsdom, as the build runs: esbuild, which the server
 * transforms through, refuses jsdom's `TextEncoder`. The rest of what the files
 * say is held in `test/dom/llms.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import { buildAgentFiles } from '../../scripts/llms.mjs'
import { renderAgentFiles } from '@/llms/render'

describe('the files the site build writes for language models', () => {
  it('are what the app renders, and llms-full.txt after them', async () => {
    const built = await buildAgentFiles()
    const rendered = renderAgentFiles()
    expect([...built.keys()]).toEqual([...rendered.map((file) => file.path), 'llms-full.txt'])
    for (const file of rendered) expect(built.get(file.path), file.path).toBe(file.text)
    expect(built.get('llms-full.txt')?.startsWith('# chromosomix')).toBe(true)
    for (const file of rendered.slice(1)) expect(built.get('llms-full.txt')).toContain(file.text.trimEnd())
  }, 120_000)
})
