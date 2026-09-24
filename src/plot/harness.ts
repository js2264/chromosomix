/**
 * The door `metacooler-plot` drives a window through (§27).
 *
 * `metacooler-plot` is a shell command that saves every figure a workspace
 * would show, and it does that by running **this app**, headless, rather than
 * by drawing anything itself: a figure here is a map read through a worker,
 * lanes sampled through another, a 3D model lit on a GPU and a chart laid out by
 * a library, and a second implementation of any of them for a shell would be a
 * second picture to keep in step with the one a reader sees. So the command
 * serves the viewer, opens it with `?plot=1`, and calls the object this module
 * installs on `window` over the DevTools protocol — one method per thing a
 * reader would do: open the workspace, bring a tab in front, wait for it to
 * finish drawing, press **save**.
 *
 * Every figure comes back through the surface's own export — the map's Export
 * card, the deck's, the 1D browser's, a structure cell's row, a drawer figure's
 * PNG and PDF buttons — minus the save dialog in front of it. What crosses back
 * to the shell is bytes, held here under a reference and read in pieces, so a
 * 600 dpi deck is not one message of a hundred megabytes.
 *
 * ## Knowing the picture is finished
 *
 * The one question a program has to answer that a reader answers by looking.
 * {@link PlotApi.settle} asks two things until both have said *nothing* for a
 * short while together: every request a worker has not answered
 * (`perf/inflight.ts`), and whatever the tab itself says it is still doing — a
 * file opening, a loading screen, a track still being read, the analysis chunk
 * (`Session.plotSurface`). *For a while*, because a picture's work is a chain —
 * a block arrives, the lanes ask for their samples, a paint is scheduled — and
 * the links are microseconds apart; a gap of this length is a chain that ended.
 *
 * ## What it is not
 *
 * Not an API anybody else should script against. It is versioned by
 * {@link PLOT_PROTOCOL} so the command can refuse a viewer built from another
 * source, and it changes with the command that drives it.
 */

import { inflightKinds } from '../perf/inflight'
import { applyTheme } from '../ui/ThemeToggle'
import { setExportPref } from '../ui/exportPrefs'
import { setTextScale } from '../ui/textScale'
import { COMMIT, PRODUCER, VERSION } from '../version'
import { setPlotAnswers } from './answers'
import { PLOT_PROTOCOL, type BlobRef, type PlotApi, type WireRequest } from './protocol'
import type { PlotHost, PlotRequest, RunFigure, SessionPlot } from './types'

/** How long the tab has to have been doing nothing before its picture is taken as finished. */
const QUIET_MS = 600
/** How often the two counts are read while waiting. */
const POLL_MS = 50

declare global {
  interface Window {
    metacoolerPlot?: PlotApi
  }
}

/** Install {@link PlotApi} on `window`, driving `host`. Called once, by `App`, on a plot mount. */
export function installPlotHarness(host: PlotHost): void {
  const held = new Map<string, Blob>()
  let nextRef = 1
  /** The figures each task's last run drew, on the tab in front. */
  const drawn = new Map<string, RunFigure[]>()

  const current = (): SessionPlot | null => host.tabs()[host.active()] ?? null

  const hold = (blob: Blob | null): BlobRef | null => {
    if (blob === null) return null
    const ref = `b${nextRef++}`
    held.set(ref, blob)
    return { ref, size: blob.size, type: blob.type }
  }

  const requestOf = (wire: WireRequest): PlotRequest => {
    const now = wire.now === undefined ? new Date() : new Date(wire.now)
    return {
      format: wire.format === 'pdf' ? 'pdf' : 'png',
      dpi: Number.isFinite(wire.dpi) && wire.dpi > 0 ? wire.dpi : 300,
      now: Number.isNaN(now.getTime()) ? new Date() : now,
    }
  }

  const busyReasons = (): string[] => {
    const out: string[] = []
    for (const [kind, count] of Object.entries(inflightKinds())) {
      out.push(count === 1 ? kind : `${count} × ${kind}`)
    }
    out.push(...(current()?.busy() ?? []))
    if (typeof document.fonts !== 'undefined' && document.fonts.status === 'loading') {
      out.push('fonts loading')
    }
    return out
  }

  const api: PlotApi = {
    protocol: PLOT_PROTOCOL,
    build: { version: VERSION, commit: COMMIT, producer: PRODUCER },

    configure(config) {
      // The theme is written on the document and nowhere else: this window is
      // nobody's, and a stored choice would be a choice for nobody.
      if (config.theme !== undefined) applyTheme(config.theme)
      if (config.caption !== undefined) setExportPref('caption', config.caption)
      if (config.textScale !== undefined) setTextScale(config.textScale)
      setPlotAnswers({
        ...(config.scool === undefined ? {} : { scool: config.scool }),
        pairs: config.pairs ?? null,
      })
    },

    open(text, label) {
      drawn.clear()
      return host.openWorkspace(text, label)
    },

    activate(index) {
      drawn.clear()
      host.activate(index)
    },

    async settle(timeoutMs) {
      const started = performance.now()
      let quietSince: number | null = null
      let last: string[] = []
      for (;;) {
        const now = performance.now()
        const reasons = busyReasons()
        if (reasons.length > 0) {
          quietSince = null
          last = reasons
        } else if (quietSince === null) {
          quietSince = now
        } else if (now - quietSince >= QUIET_MS) {
          break
        }
        if (now - started > timeoutMs) {
          throw new Error(
            `still drawing after ${Math.round(timeoutMs / 1000)} s — waiting on ${last.join(', ') || 'nothing it could name'}`,
          )
        }
        await pause(POLL_MS)
      }
      // Two frames, so the paint every arrival scheduled has happened: the
      // export redraws from the data, and a caption reads what was painted.
      await frame()
      await frame()
      return { ms: Math.round(performance.now() - started) }
    },

    describe() {
      const tabs = host.tabs()
      const index = host.active()
      const tab = tabs[index] ?? null
      const state = tab?.state() ?? null
      return {
        index,
        count: tabs.length,
        label: tab?.label() ?? '',
        view: state?.view ?? null,
        uri: state?.uri ?? null,
        failure: tab === null ? 'no tab is open' : tab.failure(),
        figure: tab?.figureKind() ?? { kind: null, why: 'no tab is open' },
        bookmarks: tab?.bookmarks() ?? [],
        structures: (tab?.structures() ?? []).map((cell) => ({ label: cell.label })),
        notices: host.takeNotices(),
      }
    },

    async figure(request) {
      return hold((await current()?.figure(requestOf(request))) ?? null)
    },

    goToBookmark(index) {
      current()?.goToBookmark(index)
    },

    goToLocus(locus) {
      const tab = current()
      return tab === null ? 'no tab is open' : tab.goToLocus(locus)
    },

    async structureFigure(index, request) {
      const cell = current()?.structures()[index]
      if (cell === undefined) return null
      return hold(await cell.figure(requestOf(request)))
    },

    analyses() {
      return current()?.analysis()?.recorded() ?? null
    },

    async runAnalysis(task, timeoutMs) {
      const analysis = current()?.analysis() ?? null
      if (analysis === null) return { status: 'unavailable', message: 'this tab has no Analysis panel' }
      let timer: ReturnType<typeof setTimeout> | null = null
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${task} was still running after ${Math.round(timeoutMs / 1000)} s`)),
          timeoutMs,
        )
      })
      try {
        const result = await Promise.race([analysis.run(task), expired])
        if (result.status !== 'done') return { status: result.status, message: result.message }
        drawn.set(task, result.figures)
        return {
          status: 'done',
          notes: result.notes,
          figures: result.figures.map((figure, index) => ({
            index,
            output: figure.output,
            label: figure.label,
            drawable: figure.drawable,
          })),
        }
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    },

    async analysisFigure(task, index, request) {
      const figure = drawn.get(task)?.[index]
      if (figure === undefined) return null
      return hold(await figure.figure(requestOf(request)))
    },

    closeAnalysis() {
      current()?.analysis()?.close()
    },

    async read(ref, offset, length) {
      const blob = held.get(ref)
      if (blob === undefined) throw new Error(`no bytes are held under ${ref}`)
      return base64Of(blob.slice(offset, offset + length))
    },

    drop(ref) {
      held.delete(ref)
    },
  }

  window.metacoolerPlot = api
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/**
 * Bytes as base64, through the platform's own encoder.
 *
 * A data URL is the one base64 the browser writes for us, off the main thread's
 * JavaScript heap; building the string a character at a time for a slice of a
 * few megabytes is what that would otherwise cost.
 */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('the bytes could not be read back'))
    reader.readAsDataURL(blob)
  })
}
