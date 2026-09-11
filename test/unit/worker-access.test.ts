/**
 * The one shape question in `worker/sources.ts`: a whole-object read is handed
 * either the access bag or a bare credential, and must sign in both cases.
 *
 * Held here because the failure it guards is silent — a bag read off a
 * credential is empty, the request goes out unsigned, and the host's 403 is
 * reported against the file rather than against the missing signature.
 */

import { describe, expect, it } from 'vitest'

import { asAccess } from '@/worker/sources'

const credential = { accessKeyId: 'AKIA', secretAccessKey: 's', region: 'eu-west-3' }

describe('asAccess', () => {
  it('passes a bag through untouched', () => {
    const bag = { credential, headers: { Authorization: 'Bearer t' } }
    expect(asAccess(bag)).toBe(bag)
  })

  it('wraps a bare credential, so it is still what signs the request', () => {
    expect(asAccess(credential)).toEqual({ credential })
  })

  it('is empty for nothing', () => {
    expect(asAccess(undefined)).toEqual({})
    expect(asAccess({})).toEqual({})
  })
})
