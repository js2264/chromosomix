/**
 * A number of contacts as a reader types it into the breadcrumb's box, or after
 * `chromosomix --contacts` — one parser for both (§6.5).
 */

import { describe, expect, it } from 'vitest'

import { contactsText, depthPhrase, parseContacts } from '../../src/contacts'

describe('parseContacts', () => {
  it('reads the forms a methods section and cooler info print', () => {
    expect(parseContacts('10M')).toBe(10_000_000)
    expect(parseContacts('10m')).toBe(10_000_000)
    expect(parseContacts('23,000,000')).toBe(23_000_000)
    expect(parseContacts('23 000 000')).toBe(23_000_000)
    expect(parseContacts('23_000_000')).toBe(23_000_000)
    expect(parseContacts('179175551')).toBe(179_175_551)
    expect(parseContacts('2.5e7')).toBe(25_000_000)
    expect(parseContacts('1.5k')).toBe(1_500)
    expect(parseContacts('1.1M')).toBe(1_100_000)
    expect(parseContacts('1.2G')).toBe(1_200_000_000)
    expect(parseContacts('3B')).toBe(3_000_000_000)
    expect(parseContacts('  19,632,515 ')).toBe(19_632_515)
  })

  it('reads an empty box as the file as stored', () => {
    expect(parseContacts('')).toBeNull()
    expect(parseContacts('   ')).toBeNull()
  })

  it('refuses what is not a whole, positive number of contacts, saying why', () => {
    expect(parseContacts('lots')).toEqual({ refused: expect.stringMatching(/not a number of contacts/) })
    expect(parseContacts('10MB')).toEqual({ refused: expect.stringMatching(/not a number of contacts/) })
    expect(parseContacts('-5')).toEqual({ refused: expect.stringMatching(/not a number of contacts/) })
    expect(parseContacts('1.5')).toEqual({ refused: expect.stringMatching(/not a whole number/) })
    expect(parseContacts('0')).toEqual({ refused: expect.stringMatching(/at least one contact/) })
    expect(parseContacts('1e30')).toEqual({ refused: expect.stringMatching(/past what can be counted/) })
  })
})

describe('what a resampled map is called', () => {
  it('groups every digit', () => {
    expect(contactsText(179_175_551)).toBe('179,175,551')
  })

  it('says which way, from what, and names Boost-HiC for an oversample', () => {
    expect(depthPhrase({ mode: 'sub', contacts: 10_000_000, total: 179_175_551 })).toBe(
      'subsampled to 10,000,000 contacts (of 179,175,551)',
    )
    expect(depthPhrase({ mode: 'over', contacts: 179_175_551, total: 19_632_515 })).toBe(
      'oversampled to 179,175,551 contacts (of 19,632,515, Boost-HiC)',
    )
    expect(depthPhrase({ mode: 'none', contacts: 5, total: 5 })).toBe('')
  })
})
