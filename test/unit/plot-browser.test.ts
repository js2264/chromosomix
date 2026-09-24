/**
 * The two pieces of `metacooler-plot` that stand between it and a browser
 * (§27.4): the DevTools protocol over a pair of pipes, and the search for a
 * Chromium to speak it to.
 *
 * The protocol is exercised against a pair of in-memory streams standing in for
 * the browser's file descriptors 3 and 4. What matters is the framing — one JSON
 * message per NUL, arriving split and merged however the pipe pleases — and
 * that a browser going away fails every call still waiting rather than leaving
 * one waiting for ever.
 *
 * The search is exercised against a disk that says only what the test tells it,
 * because the order is the thing under test and a machine with Chrome installed
 * would otherwise answer every question before the one being asked.
 */

import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { CdpConnection, CdpPage } from '@/cli/cdp'
import { findBrowser, type BrowserDisk } from '@/cli/chrome'

/** A connection, the messages it wrote, and a way to answer as the browser. */
function wire(): {
  connection: CdpConnection
  sent: () => Array<Record<string, unknown>>
  answer: (text: string) => void
  output: PassThrough
} {
  const input = new PassThrough()
  const output = new PassThrough()
  const written: Buffer[] = []
  input.on('data', (chunk: Buffer) => written.push(chunk))
  const connection = new CdpConnection(input, output)
  return {
    connection,
    output,
    sent: () =>
      Buffer.concat(written)
        .toString('utf8')
        .split('\0')
        .filter((text) => text !== '')
        .map((text) => JSON.parse(text) as Record<string, unknown>),
    answer: (text) => output.write(text),
  }
}

/** Let the streams deliver what was written to them. */
function tick(): Promise<void> {
  return new Promise((done) => setImmediate(done))
}

describe('CdpConnection', () => {
  it('writes one message per NUL, numbered, and resolves each by its number', async () => {
    const { connection, sent, answer } = wire()
    const first = connection.send('Target.getTargets')
    const second = connection.send('Page.navigate', { url: 'about:blank' }, 'S1')
    await tick()
    expect(sent()).toEqual([
      { id: 1, method: 'Target.getTargets', params: {} },
      { id: 2, method: 'Page.navigate', params: { url: 'about:blank' }, sessionId: 'S1' },
    ])
    // Answered out of order, as a browser may.
    answer('{"id":2,"result":{"frameId":"F"}}\0{"id":1,"result":{"targetInfos":[]}}\0')
    expect(await second).toEqual({ frameId: 'F' })
    expect(await first).toEqual({ targetInfos: [] })
  })

  it('puts a message back together however the pipe splits it', async () => {
    const { connection, answer } = wire()
    const pending = connection.send('Runtime.evaluate', { expression: '1' })
    const message = Buffer.from('{"id":1,"result":{"text":"été — ok"}}\0', 'utf8')
    // Split inside a multi-byte character, one byte at a time for a stretch.
    for (let at = 0; at < message.length; at += 3) answer(message.subarray(at, at + 3) as unknown as string)
    expect(await pending).toEqual({ text: 'été — ok' })
  })

  it('rejects with the method and the browser’s own words', async () => {
    const { connection, answer } = wire()
    const pending = connection.send('Page.navigate', { url: 'nowhere' })
    answer('{"id":1,"error":{"code":-32000,"message":"Cannot navigate","data":"invalid URL"}}\0')
    await expect(pending).rejects.toThrow('Page.navigate: Cannot navigate (invalid URL)')
  })

  it('hands events to their listeners, with the session they came from, until told to stop', async () => {
    const { connection, answer } = wire()
    const heard: Array<[unknown, string | undefined]> = []
    const stop = connection.on('Target.targetCrashed', (params, sessionId) => heard.push([params['targetId'], sessionId]))
    answer('{"method":"Target.targetCrashed","params":{"targetId":"T1"},"sessionId":"S1"}\0')
    await tick()
    stop()
    answer('{"method":"Target.targetCrashed","params":{"targetId":"T2"}}\0')
    await tick()
    expect(heard).toEqual([['T1', 'S1']])
  })

  it('ignores a line that is not JSON, and an answer to nothing it asked', async () => {
    const { connection, answer } = wire()
    const pending = connection.send('Browser.getVersion')
    answer('garbage\0{"id":99,"result":{}}\0{"id":1,"result":{"product":"Chrome"}}\0')
    expect(await pending).toEqual({ product: 'Chrome' })
  })

  // A browser that dies mid-figure must end the wait, not extend it for ever.
  it('fails everything waiting when the browser closes its end, and everything after', async () => {
    const { connection, output } = wire()
    const pending = connection.send('Runtime.evaluate', { expression: 'new Promise(() => {})' })
    output.destroy()
    await expect(pending).rejects.toThrow('the browser closed its end of the DevTools pipe')
    expect(connection.closed?.message).toBe('the browser closed its end of the DevTools pipe')
    await expect(connection.send('Browser.close')).rejects.toThrow(/closed its end/)
  })
})

describe('CdpPage', () => {
  it('sends in its own session and hears only its own events', async () => {
    const { connection, sent, answer } = wire()
    const page = new CdpPage(connection, 'S1')
    const heard: unknown[] = []
    page.on('Runtime.consoleAPICalled', (params) => heard.push(params['type']))
    answer('{"method":"Runtime.consoleAPICalled","params":{"type":"error"},"sessionId":"S2"}\0')
    answer('{"method":"Runtime.consoleAPICalled","params":{"type":"log"},"sessionId":"S1"}\0')
    void page.send('Page.enable')
    await tick()
    expect(heard).toEqual(['log'])
    expect(sent()[0]).toMatchObject({ method: 'Page.enable', sessionId: 'S1' })
  })

  it('calls a method on window with its arguments as JSON, and hands back the value', async () => {
    const { connection, sent, answer } = wire()
    const page = new CdpPage(connection, 'S1')
    const pending = page.call<string | null>('metacoolerPlot', 'goToLocus', 'IV:1-2', { quote: '"x"' })
    await tick()
    expect(sent()[0]).toMatchObject({
      method: 'Runtime.evaluate',
      params: {
        expression: 'window.metacoolerPlot.goToLocus(...["IV:1-2",{"quote":"\\"x\\""}])',
        awaitPromise: true,
        returnByValue: true,
      },
    })
    answer('{"id":1,"result":{"result":{"type":"object","subtype":"null","value":null}}}\0')
    expect(await pending).toBeNull()
  })

  // The stack under a page's error is about this app's bundle, and says
  // nothing to the person at the shell.
  it('throws the page’s own sentence, without the stack', async () => {
    const { connection, answer } = wire()
    const page = new CdpPage(connection, 'S1')
    const pending = page.evaluate('boom()')
    answer(
      JSON.stringify({
        id: 1,
        result: {
          result: { type: 'object' },
          exceptionDetails: {
            text: 'Uncaught',
            exception: { description: 'Error: still drawing after 600 s — waiting on reader:tile\n    at settle (harness.js:1:2)' },
          },
        },
      }) + '\0',
    )
    await expect(pending).rejects.toThrow(/^still drawing after 600 s — waiting on reader:tile$/)
  })
})

describe('findBrowser', () => {
  /** A disk holding exactly these files. */
  function disk(files: readonly string[]): BrowserDisk {
    const set = new Set(files)
    return {
      isFile: (path) => set.has(path),
      list: (dir) => {
        const prefix = dir.endsWith('/') ? dir : `${dir}/`
        return [...new Set(files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split('/')[0]))]
      },
    }
  }

  // A reader who named one has said which browser.
  it('takes the browser it is told, or refuses it — never another', () => {
    expect(findBrowser('/opt/chrome', {}, 'linux', disk(['/opt/chrome', '/usr/bin/chromium']))).toEqual({ path: '/opt/chrome' })
    expect(findBrowser('/opt/nothing', {}, 'linux', disk(['/usr/bin/chromium']))).toEqual({
      path: null,
      tried: '--browser /opt/nothing',
    })
  })

  it('reads METACOOLER_BROWSER, then CHROME_PATH, and skips one naming nothing', () => {
    const files = ['/a/chrome', '/b/chrome', '/usr/bin/chromium']
    expect(findBrowser(undefined, { METACOOLER_BROWSER: '/a/chrome', CHROME_PATH: '/b/chrome' }, 'linux', disk(files))).toEqual({
      path: '/a/chrome',
    })
    expect(findBrowser(undefined, { METACOOLER_BROWSER: '/gone', CHROME_PATH: '/b/chrome' }, 'linux', disk(files))).toEqual({
      path: '/b/chrome',
    })
    expect(findBrowser(undefined, { METACOOLER_BROWSER: '' }, 'linux', disk(files))).toEqual({ path: '/usr/bin/chromium' })
  })

  it('prefers a name on PATH, Chrome before Chromium, to an install location', () => {
    const files = ['/home/me/bin/chromium', '/home/me/bin/google-chrome', '/usr/bin/chromium']
    expect(findBrowser(undefined, { PATH: '/home/me/bin' }, 'linux', disk(files))).toEqual({ path: '/home/me/bin/google-chrome' })
  })

  it('finds the newest revision Playwright downloaded, in either layout', () => {
    const cache = '/cache/pw'
    const files = [
      `${cache}/chromium-1100/chrome-linux/chrome`,
      `${cache}/chromium-1200/chrome-linux64/chrome`,
      `${cache}/chromium_headless_shell-1200/chrome-linux/headless_shell`,
      `${cache}/ffmpeg-1010/ffmpeg-linux`,
    ]
    expect(findBrowser(undefined, { PLAYWRIGHT_BROWSERS_PATH: cache }, 'linux', disk(files))).toEqual({
      path: `${cache}/chromium-1200/chrome-linux64/chrome`,
    })
    // The link a pre-installed Playwright image keeps beside its revisions.
    expect(findBrowser(undefined, { PLAYWRIGHT_BROWSERS_PATH: cache }, 'linux', disk([`${cache}/chromium`]))).toEqual({
      path: `${cache}/chromium`,
    })
  })

  it('finds Puppeteer’s download too', () => {
    const cache = '/cache/pptr'
    const files = [`${cache}/chrome/linux-131.0.6778.85/chrome-linux64/chrome`]
    expect(findBrowser(undefined, { PUPPETEER_CACHE_DIR: cache }, 'linux', disk(files))).toEqual({ path: files[0] })
  })

  it('looks where Windows installs them', () => {
    const exe = join('C:/Program Files', 'Google\\Chrome\\Application\\chrome.exe')
    expect(findBrowser(undefined, { PROGRAMFILES: 'C:/Program Files' }, 'win32', disk([exe]))).toEqual({ path: exe })
  })

  it('says everywhere it looked when there is nothing', () => {
    const found = findBrowser(undefined, {}, 'linux', disk([]))
    expect(found.path).toBeNull()
    expect(found).toMatchObject({ tried: expect.stringMatching(/METACOOLER_BROWSER, CHROME_PATH, .* on PATH/) })
  })
})
