// @vitest-environment jsdom
/**
 * The two generated hubs are read from the site the page is on, under `hubs/`,
 * and from nowhere else: same origin, so no CORS enters into it, and a private
 * repository changes nothing — the reason they are no longer read off the
 * `hubs` branch through `raw.githubusercontent.com` (SPECS §24.3).
 */

import { describe, expect, it } from 'vitest'

import { builtinHubs } from '@/ui/examples'

describe('the generated hubs, on a page', () => {
  it('are read from this site, under hubs/', () => {
    const site = new URL(window.location.href).origin
    for (const id of ['4dn', 'encode']) {
      const ref = builtinHubs().find((held) => held.id === id)
      expect(ref?.url).toBe(`${site}/hubs/${id}.json`)
    }
  })
})
