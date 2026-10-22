/**
 * What each task re-implements (`src/analysis/references.ts`): the table the
 * Analysis column's `?` reads, held to the tasks that exist, to the validation
 * notebook that says how each came out, and to the tasks that re-implement
 * nothing.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { TASK_REFERENCES, isValidated, referenceOf } from '@/analysis/references'
import { TASKS } from '@/analysis/registry'

const VALIDATION = readFileSync(join(__dirname, '..', '..', 'notebooks', 'validation.qmd'), 'utf8')

/** The notebook's own table of sections: `| 1 | Diamond insulation | … |`. */
const SECTIONS = new Map(
  [...VALIDATION.matchAll(/^\| (\d+) \| ([^|]+) \|/gm)].map(([, number, analysis]) => [Number(number), analysis.trim()]),
)

describe('the references', () => {
  it('are each a task’s', () => {
    const ids = new Set(TASKS.map((task) => task.id))
    for (const id of Object.keys(TASK_REFERENCES)) expect(ids.has(id), id).toBe(true)
  })

  it('cite a DOI, bare, and a method in a sentence', () => {
    for (const [id, reference] of Object.entries(TASK_REFERENCES)) {
      expect(reference.doi, id).toMatch(/^10\.\d{4,9}\/\S+$/)
      expect(reference.method, id).toMatch(/^\S.{10,110}\.$/)
    }
  })

  it('name the section of the validation that found each identical or equivalent', () => {
    expect(SECTIONS.size).toBeGreaterThan(20)
    for (const [id, reference] of Object.entries(TASK_REFERENCES)) {
      if (isValidated(reference)) expect(SECTIONS.has(reference.section ?? -1), `${id} § ${reference.section}`).toBe(true)
      else expect(reference.section, id).toBeUndefined()
    }
    // Two tasks are not one section, so no section stands for two.
    const sections = Object.values(TASK_REFERENCES).flatMap((reference) => reference.section ?? [])
    expect(new Set(sections).size).toBe(sections.length)
  })

  it('are green where the validation says so and untested elsewhere', () => {
    expect(referenceOf('insulation')).toMatchObject({ agreement: 'identical', section: 1 })
    expect(SECTIONS.get(1)).toBe('Diamond insulation')
    expect(referenceOf('compartments')?.agreement).toBe('equivalent')
    expect(referenceOf('reconstruct3d')?.agreement).toBe('equivalent')
    for (const id of ['scalogram', 'hicscore', 'cellqc']) expect(referenceOf(id)?.agreement, id).toBe('untested')
  })

  it('leave out the tasks that re-implement nothing', () => {
    // Biology read off the map, or an implementation of the app's own: no `?`.
    for (const id of ['interarm', 'oriter', 'structuremap', 'spatialtracks', 'dotplot', 'magqc', 'magnetwork', 'magpurity', 'magsplit']) {
      expect(TASKS.some((task) => task.id === id), id).toBe(true)
      expect(referenceOf(id), id).toBeNull()
    }
  })
})
