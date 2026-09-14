/**
 * What the reader has ticked, and the one thing to do with it.
 *
 * A store row opens one file; the tray opens a *picture*: the map and the
 * three bigWigs ticked beside it, in one tab, the map first and the rest as
 * tracks on it — which is what dropping four files on the window does
 * (`Session.openFiles`), done for files that are somewhere else. It sits along
 * the bottom of the store and is absent until something is ticked, because a
 * bar saying "nothing selected" is furniture.
 */

import { button, el, fmt } from '../dom'
import type { StoreEntry } from '../../state/store'
import type { StoreHost } from './host'

export interface SelectionTrayProps {
  host: StoreHost
  onClear(): void
}

export class SelectionTray {
  readonly el = el('div', { class: 'portal-tray hidden', attrs: { role: 'status' } })

  constructor(private readonly props: SelectionTrayProps) {}

  paint(selected: readonly StoreEntry[]): void {
    if (selected.length === 0) {
      this.el.classList.add('hidden')
      this.el.replaceChildren()
      return
    }
    const maps = selected.filter((entry) => entry.kind === 'map').length
    const workspaces = selected.filter((entry) => entry.kind === 'workspace').length
    const tracks = selected.length - maps - workspaces
    this.el.classList.remove('hidden')
    this.el.replaceChildren(
      el('span', { class: 'portal-tray-text', text: traySummary(selected.length, maps, tracks, workspaces) }),
      button('open together', () => this.props.host.openTogether(selected), {
        class: 'btn btn-primary',
        title:
          maps > 0
            ? 'The first map ticked opens as the tab; every other map joins it as a panel and everything else as a track.'
            : 'The first file ticked opens as a genome browser; every other one joins it as a track.',
      }),
      button('clear', this.props.onClear, { class: 'btn btn-quiet', title: 'Untick everything.' }),
    )
  }
}

/** `3 selected — 1 map, 2 tracks`, in the words a reader would use. */
export function traySummary(total: number, maps: number, tracks: number, workspaces: number): string {
  const parts: string[] = []
  if (maps > 0) parts.push(`${fmt.int(maps)} ${maps === 1 ? 'map' : 'maps'}`)
  if (tracks > 0) parts.push(`${fmt.int(tracks)} ${tracks === 1 ? 'track' : 'tracks'}`)
  if (workspaces > 0) parts.push(`${fmt.int(workspaces)} ${workspaces === 1 ? 'session' : 'sessions'}`)
  return `${fmt.int(total)} selected — ${parts.join(', ')}`
}
