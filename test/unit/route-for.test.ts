/**
 * Routing a file by the name it was given, where its address says nothing
 * (`browse/route.ts`), and what a label shows of an address.
 */

import { describe, expect, it } from 'vitest'

import { routeFor, routeOf } from '@/browse/route'
import { fileBaseLabel, fileLabel } from '@/ui/labels'

const DRIVE = 'https://www.googleapis.com/drive/v3/files/1pq7NDWoDdEJNTTOZEnhoKYYrr66zzD7?alt=media&supportsAllDrives=true'

describe('routeFor', () => {
  it('lets the given name decide where the address does not say', () => {
    expect(routeOf(DRIVE)).toBe('unknown')
    expect(routeFor(DRIVE, 'ATAC_rep2_WBcel235.bw')).toBe('genome')
    expect(routeFor(DRIVE, 'HFF_1kb.mcool')).toBe('map')
    expect(routeFor(DRIVE, 'notes.txt')).toBe('unknown')
    expect(routeFor(DRIVE)).toBe('unknown')
  })

  it('lets the address win where it does say', () => {
    expect(routeFor('https://h.example/rep1.mcool', 'the ATAC track')).toBe('map')
    expect(routeFor('https://h.example/atac.bw', 'HFF_1kb.mcool')).toBe('genome')
  })
})

describe('what a label shows of an address', () => {
  it('drops the query string and the fragment, which are the request rather than the name', () => {
    expect(fileBaseLabel(DRIVE)).toBe('1pq7NDWoDdEJNTTOZEnhoKYYrr66zzD7')
    expect(fileBaseLabel('https://b.s3.amazonaws.com/rep1.mcool?X-Amz-Signature=abc')).toBe('rep1.mcool')
    expect(fileBaseLabel('https://h.example/raw/matrix.matrix#bins=abs.bed')).toBe('matrix.matrix')
    expect(fileLabel('https://h.example/multi.mcool?sig=1::resolutions/1000')).toBe('multi.mcool::1000')
  })

  it('keeps a name that is nothing but a query', () => {
    expect(fileBaseLabel('https://h.example/?x=1')).toBe('?x=1')
  })
})
