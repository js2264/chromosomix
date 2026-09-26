/**
 * The Tracks card over a workspace's store, as the session mounts it — the one
 * place a synthetic row is listed since the Synthetic tracks card went (§18.5).
 *
 * Every row's settings are opened, because that is where a synthetic row keeps
 * its exports and its framing, and a test pressing *bigWig* is pressing the
 * button a reader reaches through the chevron.
 */

import type { AnalysisWorkspace } from '@/analysis/workspace'
import { AnnotationLoader } from '@/annotations/loader'
import type { AnnotationStore } from '@/annotations/store'
import { AnnotationCard } from '@/ui/AnnotationCard'

export interface MountedTracks {
  card: AnnotationCard
  el: HTMLElement
  destroy(): void
}

export function tracksCardOver(
  store: AnnotationStore,
  workspace: AnalysisWorkspace,
  options: { open?: boolean; maps?: () => Array<{ id: string; label: string }> } = {},
): MountedTracks {
  const loader = new AnnotationLoader(
    store,
    { request: () => Promise.resolve(null), drop: () => {} } as never,
    [],
  )
  const card = new AnnotationCard({
    store,
    loader,
    ...(options.maps === undefined ? {} : { maps: options.maps }),
    onExport: (entry, format) => void workspace.exportEntry(entry, format),
    onRecompute: (entry) => workspace.recompute(entry),
  })
  document.body.appendChild(card.el)
  if (options.open !== false) openEveryRow(card.el)
  return {
    card,
    el: card.el,
    destroy: () => {
      card.destroy()
      card.el.remove()
    },
  }
}

/** Press every row's chevron that is still shut, one rebuild at a time. */
export function openEveryRow(host: HTMLElement): void {
  for (let guard = 0; guard < 100; guard++) {
    const shut = host.querySelector<HTMLButtonElement>('.ann-more[aria-expanded="false"]')
    if (shut === null) return
    shut.click()
  }
}
