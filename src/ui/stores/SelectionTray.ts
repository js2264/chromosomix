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
import { icon } from '../icons'
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
    // The same two verbs a row has (`ui/rowVerbs.ts`), over everything ticked.
    // *Add* joins each file to the session in front, one after another, which
    // is what pressing `+` on each row would do; *open together* is the tray's
    // own verb, a picture in a session of its own.
    const files = selected.filter((entry) => entry.kind !== 'workspace')
    const add = button('add to this session', () => files.forEach((entry) => this.props.host.add(entry)), {
      class: 'btn btn-quiet portal-tray-verb',
      title:
        files.length === selected.length
          ? 'Each file ticked joins the tab in front: a map beside the map, anything else as a track.'
          : 'Each file ticked joins the tab in front. A session ticked is tabs of its own and stays out of this.',
    })
    add.prepend(icon('plus', { size: 14 }))
    const together = button('open together', () => this.props.host.openTogether(selected), {
      class: 'btn btn-primary portal-tray-verb',
      title:
        maps > 0
          ? 'In a session of its own: the first map ticked opens as the tab; every other map joins it as a panel and everything else as a track.'
          : 'In a session of its own: the first file ticked opens as a genome browser; every other one joins it as a track.',
    })
    together.prepend(icon('new-session', { size: 14 }))
    this.el.replaceChildren(
      el('span', { class: 'portal-tray-text', text: traySummary(selected.length, maps, tracks, workspaces) }),
      ...(files.length === 0 ? [] : [add]),
      together,
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
