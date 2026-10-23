/**
 * The account of what this browser keeps, and the sweep that ends it.
 *
 * One test here matters more than the rest, and it is the last one: **every key
 * this app writes begins with the prefix the sweep is written over.** The sweep
 * is deliberately a prefix rule rather than a list of names, because a list only
 * covers the keys somebody remembered to add to it — and the failure mode of a
 * forgotten key is the worst one this feature has. The reader presses "forget
 * everything", is told it worked, and their bucket secret is still on the disk.
 *
 * So the rule is enforced against the *source* rather than trusted: a future
 * `localStorage.setItem('something-else', …)` fails here, in a test whose name
 * says why, rather than silently surviving a sweep that claims to be total.
 */

// @vitest-environment jsdom

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PREFIX, forgetEverything, storedItems } from '@/state/stored'
import { resetActions } from '@/state/actions'
import { STORES, store } from '@/state/idb'
import { WORKSPACE_VERSION, flushWorkspace, forgetWorkspace, writeWorkspace } from '@/state/workspace'
import { buildConfig } from '@/state/SessionConfig'
import { DEFAULT_UI_PLOT_OPTIONS } from '@/ui/plotOptions'

/**
 * From the working directory rather than from `import.meta.url`, because this
 * file asks for jsdom and jsdom's `import.meta.url` is not a `file:` URL.
 * Vitest's root is this repository (`vitest.config.ts` sits in it), so `src/` is
 * where the config already says it is.
 */
const SRC = join(process.cwd(), 'src')

function config(uri: string) {
  return buildConfig({
    state: { uri, view: 'region' },
    memoryKey: `stored|${uri}`,
    plot: DEFAULT_UI_PLOT_OPTIONS,
    now: new Date('2026-08-13T09:00:00Z'),
  })
}

beforeEach(async () => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  await forgetWorkspace()
})

afterEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  // The log is a module singleton, so a test that planted one must not leave it
  // in memory for the next: `storedItems` reads the list, not the raw key.
  resetActions()
})

describe('storedItems', () => {
  it('says nothing is kept when nothing is', async () => {
    expect(await storedItems()).toEqual([])
  })

  it('counts the tabs of a remembered workspace', async () => {
    writeWorkspace({
      version: WORKSPACE_VERSION,
      savedAt: '2026-08-13T09:00:00.000Z',
      sessions: [
        { id: 's1', config: config('a.cool') },
        { id: 's2', config: config('b.cool') },
      ],
      active: 's1',
    })
    await flushWorkspace()
    const items = await storedItems()
    expect(items[0].label).toBe('Remembered workspace')
    expect(items[0].detail).toContain('2 tabs')
    expect(items[0].detail).toContain('2026-08-13')
  })

  it('names bucket keys outright rather than counting them among the settings', async () => {
    // Every other line describes something whose loss costs a preference. This
    // one describes a secret, and a reader deciding whether to press the button
    // on a borrowed machine must not have to press it to find out it is there.
    window.localStorage.setItem(`${PREFIX}theme`, 'dark')
    window.localStorage.setItem(`${PREFIX}buckets`, '[{"secretAccessKey":"shh"}]')
    const items = await storedItems()
    const labels = items.map((item) => item.label)
    expect(labels).toContain('Preferences')
    expect(labels).toContain('Bucket keys')
    // Counted once, as a preference or as a key, never as both.
    expect(items.find((item) => item.label === 'Preferences')?.detail).toContain('1 setting')
    expect(items.find((item) => item.label === 'Bucket keys')?.detail).not.toContain('secret')
  })

  it('lists a public bucket as an address, not as a key, since it holds none', async () => {
    // A scope with no key is a bookmark of a public prefix (`s3/credentials.ts`).
    // It was listed as *Bucket keys — access keys for private buckets*, which
    // told a reader with nothing secret on the disk that there was a key to
    // forget.
    window.localStorage.setItem(
      `${PREFIX}buckets`,
      JSON.stringify([{ id: 'p', label: 'demo data', base: 'https://lab.s3.eu-west-3.amazonaws.com/demo/' }]),
    )
    const items = await storedItems()
    const labels = items.map((item) => item.label)
    expect(labels).toContain('Buckets you connected')
    expect(labels).not.toContain('Bucket keys')
    expect(items.find((item) => item.label === 'Buckets you connected')?.detail).toMatch(/^demo data — /)
    // A bucket is not a preference either, whichever line it is on.
    expect(labels).not.toContain('Preferences')
  })

  it('lists a key and a public bucket each as what it is, side by side', async () => {
    window.localStorage.setItem(
      `${PREFIX}buckets`,
      JSON.stringify([
        { id: 'p', label: 'demo data', base: 'https://lab.s3.eu-west-3.amazonaws.com/demo/' },
        {
          id: 's',
          label: 'collections',
          base: 'https://lab.s3.eu-west-3.amazonaws.com/collections/',
          region: 'eu-west-3',
          accessKeyId: 'AKIAEXAMPLE',
          secretAccessKey: 'shh',
        },
      ]),
    )
    const items = await storedItems()
    expect(items.find((item) => item.label === 'Buckets you connected')?.detail).toMatch(/^demo data — /)
    expect(items.find((item) => item.label === 'Buckets you connected')?.detail).not.toContain('collections')
    expect(items.map((item) => item.label)).toContain('Bucket keys')
    expect(JSON.stringify(items)).not.toContain('shh')
    expect(JSON.stringify(items)).not.toContain('AKIAEXAMPLE')
  })

  it('lists nothing for Google or Dropbox, because this browser keeps nothing of them', async () => {
    // The site's client id, API key and app key are in the page rather than
    // in storage (`config/siteDefaults.ts`), and the tokens a sign-in produces
    // are held in memory and never written (SPECS §24.7). Rows an older build
    // wrote for them are swept by the prefix rule below and never listed.
    window.localStorage.setItem(`${PREFIX}theme`, 'dark')
    window.localStorage.setItem(`${PREFIX}access`, '[{"id":"google-api-key","kind":"google-api-key","key":"AIzaX"}]')
    window.localStorage.setItem(`${PREFIX}google`, '{"clientId":"123-abc.apps.googleusercontent.com"}')
    window.localStorage.setItem(`${PREFIX}dropbox`, '{"appKey":"a1b2c3d4e5f6g7h"}')
    const items = await storedItems()
    const labels = items.map((item) => item.label)
    expect(labels).not.toContain('Google API key')
    expect(labels).not.toContain('Google client id')
    expect(labels).not.toContain('Dropbox app key')
    expect(JSON.stringify(items)).not.toContain('AIzaX')
    // Counted once, as a preference, and the three old rows not at all.
    expect(items.find((item) => item.label === 'Preferences')?.detail).toContain('1 setting')
  })

  /**
   * A store is somewhere the reader connected to, so it is named rather than
   * counted — the rule the granted files and the connected folders follow, and
   * for the same reason: the labels are the part worth reading back before
   * deciding what to do on a borrowed machine.
   */
  it('names the stores that have been connected, and does not count them twice', async () => {
    window.localStorage.setItem(`${PREFIX}theme`, 'dark')
    window.localStorage.setItem(
      `${PREFIX}stores`,
      JSON.stringify([{ id: 'store:1', label: 'Lab shelf', url: 'https://lab.example/store.json' }]),
    )
    const items = await storedItems()
    const stores = items.find((item) => item.label === 'Stores you connected')
    expect(stores?.detail).toContain('Lab shelf')
    // Counted as a store or as a preference, never as both: a reader told "2
    // settings — theme, column widths, overlays" when one of the two is a
    // catalogue URL has been told something false.
    expect(items.find((item) => item.label === 'Preferences')?.detail).toContain('1 setting')
  })

  it('says nothing about stores when none have been connected', async () => {
    window.localStorage.setItem(`${PREFIX}theme`, 'dark')
    const labels = (await storedItems()).map((item) => item.label)
    expect(labels).not.toContain('Stores you connected')
  })

  it('names the console on its own line rather than counting it as a setting', async () => {
    // A list of the files a reader opened and the loci they looked at, which is
    // exactly the kind of thing §11 says somebody on a borrowed machine is owed
    // a straight answer about before they decide whether to press the button.
    window.localStorage.setItem(`${PREFIX}theme`, 'dark')
    window.localStorage.setItem(
      `${PREFIX}actions`,
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'a', at: Date.now(), kind: 'open', line: 'opened patient_04.cool', status: 'ok' },
        ],
      }),
    )
    resetActions()
    const items = await storedItems()
    const recorded = items.find((item) => item.label === 'Console')
    expect(recorded?.detail).toContain('1 line')
    // Counted once, as a record or as a preference, never as both.
    expect(items.find((item) => item.label === 'Preferences')?.detail).toContain('1 setting')
    // The names themselves stay out of it: the count is what the reader needs.
    expect(recorded?.detail).not.toContain('patient_04')
  })

  it('ignores keys that are not this app’s', async () => {
    window.localStorage.setItem('some-other-app', 'x')
    window.sessionStorage.setItem('unrelated', 'y')
    expect(await storedItems()).toEqual([])
  })
})

/**
 * What the sweep clears. What it *keeps* cleared — that a pan or a `pagehide`
 * does not write the durable workspace straight back — is one page load per
 * test and therefore lives in `test/unit/forget-everything.test.ts`, since
 * `forgetEverything` now suspends module state that only a reload re-arms.
 * Nothing below this line may write a workspace and expect it to be stored.
 */
describe('forgetEverything', () => {
  it('clears both web storages and the durable stores, and leaves other apps alone', async () => {
    window.localStorage.setItem(`${PREFIX}theme`, 'dark')
    window.localStorage.setItem(`${PREFIX}buckets`, '[{"secretAccessKey":"shh"}]')
    // The stores key is swept by the prefix rule rather than by being named here,
    // which is the promise this module makes; it is in the fixture so that a
    // sweep which stopped covering it would fail rather than pass quietly.
    window.localStorage.setItem(
      `${PREFIX}stores`,
      '[{"id":"store:1","label":"Lab shelf","url":"https://lab.example/store.json"}]',
    )
    // The Google client id, in the fixture for the stores key's reason: it is
    // swept by the prefix rule rather than by being named, and a sweep that
    // stopped covering it should fail here rather than pass quietly.
    window.localStorage.setItem(
      `${PREFIX}google`,
      '{"clientId":"123-abc.apps.googleusercontent.com"}',
    )
    window.sessionStorage.setItem(`${PREFIX}sessions`, '{}')
    window.sessionStorage.setItem(`${PREFIX}ui:s1|a.cool:annotations`, '[]')
    window.localStorage.setItem('some-other-app', 'keep me')
    writeWorkspace({
      version: WORKSPACE_VERSION,
      savedAt: '',
      sessions: [{ id: 's1', config: config('a.cool') }],
      active: 's1',
    })
    await flushWorkspace()
    await store(STORES.handles).set('a.cool', { name: 'a.cool' })

    await forgetEverything()

    expect(await storedItems()).toEqual([])
    expect(window.localStorage.getItem(`${PREFIX}buckets`)).toBeNull()
    expect(window.localStorage.getItem(`${PREFIX}stores`)).toBeNull()
    expect(window.localStorage.getItem(`${PREFIX}google`)).toBeNull()
    expect(window.sessionStorage.getItem(`${PREFIX}sessions`)).toBeNull()
    expect(await store(STORES.workspace).get('current')).toBeNull()
    // The other half of the durable side. A sweep that cleared the workspace
    // and left the granted file handles behind would still be showing the
    // reader's file names back to them.
    expect(await store(STORES.handles).get('a.cool')).toBeNull()
    expect(window.localStorage.getItem('some-other-app')).toBe('keep me')
  })

  it('keeps telemetry off, the one answer whose loss would send more', async () => {
    // A refusal, not something kept on the reader's behalf: forgetting it would
    // turn the counts back on behind the button that promised less (§31).
    window.localStorage.setItem(`${PREFIX}telemetry`, 'off')
    window.localStorage.setItem(`${PREFIX}theme`, 'dark')
    await forgetEverything()
    expect(window.localStorage.getItem(`${PREFIX}telemetry`)).toBe('off')
    expect(window.localStorage.getItem(`${PREFIX}theme`)).toBeNull()
  })

  it('leaves telemetry on where it was on, writing nothing', async () => {
    window.localStorage.setItem(`${PREFIX}theme`, 'dark')
    await forgetEverything()
    expect(window.localStorage.getItem(`${PREFIX}telemetry`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The rule the sweep depends on
// ---------------------------------------------------------------------------

/** Every `.ts` under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

/**
 * The key argument of every `setItem` in a file, resolved to a literal.
 *
 * Two forms are recognised, which are the two the codebase uses: a literal
 * written at the call, and an identifier declared as a `const` in the same
 * module. An identifier that cannot be resolved is returned as `null` and fails
 * the test — deliberately, because a key this cannot read is a key the reviewer
 * cannot check either, and the fix (name it in a module-level const) is the
 * shape every existing owner already uses.
 */
function storageKeys(source: string): Array<{ raw: string; value: string | null }> {
  const found: Array<{ raw: string; value: string | null }> = []
  /** `const NAME = '…'` in this module, or `null`. */
  const constant = (name: string): string | null => {
    const declared = new RegExp(`const\\s+${name}\\s*=\\s*['"\`]([^'"\`$]*)['"\`]`).exec(source)
    return declared === null ? null : declared[1]
  }

  for (const call of source.matchAll(/\.setItem\(\s*([^,]+?)\s*,/g)) {
    const argument = call[1].trim()

    // A plain literal, which must not be a template with a hole in it — a
    // `${…}` inside backticks is an expression wearing a literal's quotes, and
    // reading it as one is how `` `${spec.key}:width` `` came out as a key
    // beginning with a dollar sign.
    const literal = /^(['"])(.*)\1$/s.exec(argument)
    if (literal !== null) {
      found.push({ raw: argument, value: literal[2] })
      continue
    }
    const plainTemplate = /^`([^`$]*)`$/.exec(argument)
    if (plainTemplate !== null) {
      found.push({ raw: argument, value: plainTemplate[1] })
      continue
    }

    // A template whose *first* piece is a module const — `${PREFIX}…`. The
    // prefix is the whole of what is being asserted, so resolving that one hole
    // settles it and the rest of the string does not matter.
    const leading = /^`\$\{([A-Za-z_$][\w$]*)\}/.exec(argument)
    if (leading !== null) {
      found.push({ raw: argument, value: constant(leading[1]) })
      continue
    }

    if (/^[A-Za-z_$][\w$]*$/.test(argument)) {
      found.push({ raw: argument, value: constant(argument) })
      continue
    }

    found.push({ raw: argument, value: null })
  }
  return found
}

/**
 * The writers whose key is a parameter, so no reading of one file can settle it.
 *
 * Each was checked by hand and each is safe, and the note says how — but the
 * point of the list is not the four entries. It is that **a fifth one fails this
 * test**: an indirect writer is exactly where an unprefixed key would hide from
 * the sweep, so adding one has to be a decision somebody makes on purpose, with
 * the callers checked, rather than a line that slips through because a regex
 * could not follow it.
 */
const INDIRECT_WRITERS = [
  {
    file: 'src/state/UiMemory.ts',
    expression: 'key',
    why: '`write` is called only by `remember`, with `${PREFIX}${uri}:${scope}`.',
  },
  {
    file: 'src/ui/SidePanel.ts',
    expression: 'key',
    why: '`writeFlag` is called only with a `PanelSpec.key`, and all four are prefixed literals.',
  },
  {
    file: 'src/ui/SidePanel.ts',
    expression: '`${spec.key}:width`',
    why: 'Same four specs, with a suffix.',
  },
  {
    file: 'src/ui/VersionPicker.ts',
    expression: 'key',
    why: '`remember` is called only with `DISMISSED`, a prefixed literal.',
  },
]

describe('the prefix rule the sweep is written over', () => {
  const scanned = sourceFiles(SRC).flatMap((path) =>
    storageKeys(readFileSync(path, 'utf8')).map((key) => ({
      ...key,
      file: path.slice(SRC.length - 'src'.length).split('\\').join('/'),
    })),
  )

  it('is obeyed by every key written as a literal or a module const', () => {
    const offenders = scanned
      .filter((key) => key.value !== null && !key.value.startsWith(PREFIX))
      // Named rather than counted, so a failure says which file and which key.
      .map((key) => `${key.file}: setItem writes ${JSON.stringify(key.value)}, not under ${PREFIX}`)
    expect(offenders).toEqual([])
  })

  it('has no writer whose key this cannot follow beyond the four that were checked', () => {
    const indirect = scanned
      .filter((key) => key.value === null)
      .map((key) => `${key.file} ${key.raw}`)
    const known = INDIRECT_WRITERS.map((writer) => `${writer.file} ${writer.expression}`)
    // Sorted and de-duplicated, so the failure message is a set difference
    // rather than an ordering accident.
    expect([...new Set(indirect)].sort()).toEqual([...new Set(known)].sort())
  })

  it('finds the keys it is meant to be checking, so a passing run means something', () => {
    // A regex that matched nothing would pass both tests above for the wrong
    // reason, and would go on passing after somebody changed how keys are
    // written. This is the guard on the guard.
    expect(scanned.length).toBeGreaterThan(8)
    expect(scanned.some((key) => key.value?.startsWith(PREFIX))).toBe(true)
  })
})
