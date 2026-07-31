/**
 * `intAttr` — the mirror of `metacooler.schema._int_attr` (spec §3.2,
 * correction #3).
 *
 * This one function is what stands between the viewer and a variable-bin file.
 * metacooler omits `bin-size` for variable bins, but a file that has been
 * through cooler carries the literal **string** `"null"` instead — and
 * `Number('null')` is `NaN` while `Boolean('null')` is `true`, so the idiomatic
 * JS spelling (`Number(v) || null`, or `v ? Number(v) : null`) accepts that
 * file and then divides by a bin size that does not exist. `variable.metacool`
 * is exactly that file, and `detect.test.ts` drives this function over it.
 *
 * Every expectation is the observed output of the Python original, obtained by
 * writing each value as a real h5py attribute and calling `_int_attr` on it —
 * so the ordering of the type checks (string, then **bool**, then int, then
 * integral float) is pinned by the oracle rather than by reading the source.
 */

import { describe, expect, it } from 'vitest'

import type { AttrValue } from '../../src/h5/api'
import { MetaCoolerFormatError } from '../../src/errors'
import { intAttr } from '../../src/metacooler/detect'
import { pyInt } from '../../src/format'
import { withHandle } from './_golden'

const KEY = 'bin-size'

/** `intAttr({ 'bin-size': value }, 'bin-size')`. */
function read(value: AttrValue): number | null {
  return intAttr({ [KEY]: value }, KEY)
}

describe('intAttr: absent and the null sentinels', () => {
  it('reads a missing attribute as absent', () => {
    expect(intAttr({}, KEY)).toBeNull()
    expect(read(null)).toBeNull()
  })

  // `_int_attr` lowercases and strips before comparing, so every casing and
  // padding of the four sentinels means "the writer had nothing to say".
  it.each([
    'null',
    'NULL',
    'Null',
    'none',
    'None',
    'NONE',
    ' None ',
    'nan',
    'NaN',
    'NAN',
    '\tnan\n',
    '',
    '   ',
  ])('reads %j as absent, not as a bin size', (sentinel) => {
    expect(read(sentinel)).toBeNull()
  })

  it('does not mistake a sentinel for a number', () => {
    // The bug this suite exists to prevent, spelled out. Both of these are how
    // the value would be read by an implementation that reached for Number().
    expect(Number('null')).toBeNaN()
    expect(Boolean('null')).toBe(true)
    expect(read('null')).toBeNull()
  })
})

describe('intAttr: values it accepts', () => {
  it.each<[AttrValue, number]>([
    [1000, 1000],
    [2000, 2000],
    // One JS number type covers Python's `int` branch and its
    // `float(...).is_integer()` branch at once.
    [1000.0, 1000],
    [-2000.0, -2000],
    [0, 0],
    ['1000', 1000],
    ['  1000  ', 1000],
    ['+1000', 1000],
    ['-5', -5],
    // Python's int() accepts single underscores between digits.
    ['1_000', 1000],
  ])('reads %j as %i', (value, expected) => {
    expect(read(value)).toBe(expected)
  })
})

describe('intAttr: values it refuses', () => {
  const refuse = (value: AttrValue): MetaCoolerFormatError => {
    let thrown: unknown
    try {
      read(value)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MetaCoolerFormatError)
    return thrown as MetaCoolerFormatError
  }

  it.each<[string, AttrValue]>([
    ['a boolean true', true],
    ['a boolean false', false],
    ['a fractional float', 1000.5],
    ['a non-numeric string', 'abc'],
    ['the bin-type value', 'fixed'],
    ['scientific notation', '1e3'],
    ['a float-shaped string', '1000.0'],
    ['a hex literal', '0x10'],
    ['a doubled underscore', '1__0'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s', (_label, value) => {
    const error = refuse(value)
    expect(error.message.startsWith(`attrs['bin-size'] must be an integer, got `)).toBe(true)
    expect(error.detail).toEqual({ key: KEY, value })
  })

  it('refuses a boolean *before* treating it as a number', () => {
    // In Python `isinstance(True, int)` is true, so the bool check has to come
    // first or `bin-size = True` silently means a one-base-pair bin.
    expect(Number(true)).toBe(1)
    expect(() => read(true)).toThrowError(/must be an integer/)
  })
})

describe('intAttr over real attributes', () => {
  // The three storage forms `bin-size` actually takes on disk, one fixture
  // each. h5py writes an int64 attribute for a Python int, an int32 one for a
  // numpy int32, and a fixed-length string for the variable-bin sentinel — and
  // an int64 attribute reaches JS as a **BigInt** unless the HDF5 layer
  // narrows it, which `typeof value === 'number'` would then miss.
  it('reads the int64 bin-size of basic.metacool', async () => {
    await withHandle('basic.metacool', (h) => {
      const attrs = h.attrs()
      expect(typeof attrs['bin-size']).toBe('number')
      expect(intAttr(attrs, 'bin-size')).toBe(1000)
      expect(intAttr(attrs, 'metacooler-format-version')).toBe(1)
    })
  })

  it('reads the int32 bin-size of floatcount.metacool', async () => {
    await withHandle('floatcount.metacool', (h) => {
      const attrs = h.attrs()
      expect(typeof attrs['bin-size']).toBe('number')
      expect(intAttr(attrs, 'bin-size')).toBe(1000)
    })
  })

  it("reads variable.metacool's literal 'null' string as absent", async () => {
    await withHandle('variable.metacool', (h) => {
      const attrs = h.attrs()
      // The attribute really is the four-character string, not a missing key:
      // if the HDF5 layer ever returned '' or undefined here the sentinel test
      // would pass for the wrong reason.
      expect(attrs['bin-size']).toBe('null')
      expect(attrs['bin-type']).toBe('variable')
      expect(intAttr(attrs, 'bin-size')).toBeNull()
    })
  })
})

describe('pyInt', () => {
  // The string branch of `_int_attr` is `int(value)`; these are its rules.
  it.each<[string, number | null]>([
    ['1000', 1000],
    ['  1000  ', 1000],
    ['+1000', 1000],
    ['-5', -5],
    ['1_000', 1000],
    ['1_0_0', 100],
    ['1__0', null],
    ['_1', null],
    ['1_', null],
    ['1e3', null],
    ['1000.0', null],
    ['0x10', null],
    ['', null],
    ['abc', null],
  ])('int(%j) === %s', (text, expected) => {
    expect(pyInt(text)).toBe(expected)
  })
})
