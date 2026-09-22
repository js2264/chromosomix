/**
 * The Groups card: what is in each group, and the three decisions about it.
 *
 * A group is a claim that these tracks are comparable, and for a long time the
 * card that showed it existed only in the 1D browser — so beside a contact map
 * the claim could be made, from the per-row select or the batch bar, and then
 * never checked or undone from the one place in the application that exists to
 * show it. It is a card and not a view's method now, and both Aesthetics columns
 * mount the same one.
 *
 * Each group lists its members by name and colour, and each name carries the ×
 * that takes it back out. The two mode buttons are buttons rather than menus
 * because each has exactly two states, and a two-item dropdown is a click, a
 * read and a second click for something a button says outright.
 *
 * Each of them is a **toggle**, lit when the group is in that state, and each
 * wears one mark rather than swapping between two. They used to be labelled by
 * what pressing them does — `unlink` offering to unlink — on the argument that
 * the state is visible in the picture. It is not: a shared axis looks like two
 * axes that happen to agree, so a reader comparing two tracks could not tell
 * whether `unlink` meant *these are linked* or *link these*, and the button was
 * the only place the answer could have been. The action is in the tooltip,
 * which is where §26.3 puts what a press will do.
 */

import type { GroupSettings } from '../annotations/groups'
import type { AnnotationStore } from '../annotations/store'
import { el } from './dom'
import { cardTitle, iconButton } from './icons'
import { laneSize } from './trackControls'

export interface GroupsCardOptions {
  store: AnnotationStore
  groups: GroupSettings
  /** Ask the surface for a repaint; a mode change is a different picture. */
  onChange(): void
}

export class GroupsCard {
  readonly el: HTMLElement
  private readonly host = el('div', { class: 'panel-controls' })
  /**
   * Groups the reader has *folded away*, so a repaint does not reopen them.
   *
   * A group is a row in a card, exactly as a track is one in the panel beside
   * it: a name, an eye, and everything else behind a chevron. Held here rather
   * than in the store for the reason a card's own fold set is held in the card —
   * which of them is folded is a gesture in progress, not a property of the
   * group.
   *
   * The set names the *closed* ones, which inverts the default: a group arrives
   * open. A track row starts folded because there are usually many of them and
   * the reader is looking for one; a group is the opposite — it exists because
   * somebody deliberately made it, there are rarely more than two or three, and
   * the three settings behind the chevron are the entire reason to have made
   * one. Folded by default meant every group had to be opened before the card
   * said anything a reader could act on.
   */
  private readonly closed = new Set<string>()
  private readonly unsubscribes: Array<() => void> = []

  constructor(private readonly options: GroupsCardOptions) {
    this.el = el(
      'div',
      { class: 'controls-card' },
      cardTitle('Groups', 'layers', 'controls-title'),
      this.host,
    )
    this.unsubscribes.push(options.store.subscribe(() => this.paint()))
    this.unsubscribes.push(options.groups.subscribe(() => this.paint()))
    this.paint()
  }

  destroy(): void {
    for (const off of this.unsubscribes) off()
    this.unsubscribes.length = 0
  }

  private paint(): void {
    const groups = this.options.store.scaleGroups()
    if (groups.size === 0) {
      // Two sentences: what there is none of, and the one gesture that makes
      // one, naming the controls by what they say on screen. What this replaces
      // was eleven lines teaching the theory of shared limits — the longest
      // paragraph in the column, on every fresh file, in a card with no control
      // in it — and it pointed at a bar two panels away as "below them".
      this.host.replaceChildren(
        el('p', {
          class: 'hint',
          text:
            'No groups yet. Tick two tracks in the Tracks card and choose a group below them, ' +
            'or set one from a track’s settings; grouped tracks share one scale.',
        }),
      )
      return
    }
    const { store, groups: settings } = this.options
    const rows: HTMLElement[] = []
    for (const [name, members] of groups) {
      const overlaid = settings.modeOf(name) === 'overlay'
      const shared = settings.scalingOf(name) === 'shared'
      const open = !this.closed.has(name)
      // A group is shown when any of its members is: hiding one member by hand
      // and then pressing the group's eye should hide the rest, not reveal the
      // one that was put away.
      const shown = members.some((member) => member.visible)

      const eye = iconButton(
        shown ? 'eye' : 'eye-off',
        shown ? `Hide every track in ${name}` : `Show ${name} again`,
        () => {
          for (const member of members) store.update(member.id, { visible: !shown })
        },
        { class: 'btn btn-icon ann-eye', size: 14 },
      )
      eye.setAttribute('aria-pressed', String(shown))

      const fold = iconButton(
        open ? 'chevron-down' : 'chevron-right',
        open ? `Fold ${name}` : `What is in ${name}, and how it is drawn`,
        () => {
          if (open) this.closed.add(name)
          else this.closed.delete(name)
          this.paint()
        },
        // The row's own classes, not lookalikes: a group *is* a row, and two
        // sets of rules for the same control is how the two drift apart.
        { class: 'btn btn-icon ann-more', size: 14 },
      )
      fold.setAttribute('aria-expanded', String(open))

      const head = el(
        'div',
        { class: 'group-head' },
        el('span', { class: 'group-title', text: name, title: name }),
        el('span', { class: 'hint group-count', text: `${members.length}` }),
        eye,
        fold,
      )

      // Lit means these are in one lane; unlit means a lane each. One mark
      // either way, as every other icon toggle in this column is.
      const overlayButton = iconButton(
        'layers',
        overlaid
          ? 'Drawn in one lane. Press to give each of these a lane of its own again'
          : 'A lane each. Press to draw all of these into one lane, against one axis',
        () => {
          settings.setMode(name, overlaid ? 'stacked' : 'overlay')
          this.options.onChange()
        },
        { class: 'btn btn-icon btn-toggle', size: 14 },
      )
      overlayButton.setAttribute('aria-pressed', String(overlaid))
      // And lit means one pair of limits over all of them, which is the claim
      // the group exists to make.
      const linkButton = iconButton(
        'link',
        shared
          ? 'One pair of limits over all of them. Press to let every track here find its own, as an ungrouped one does'
          : 'Each track on its own limits. Press to scale them together, which is what makes them comparable',
        () => {
          settings.setScaling(name, shared ? 'each' : 'shared')
          this.options.onChange()
        },
        { class: 'btn btn-icon btn-toggle', size: 14 },
      )
      linkButton.setAttribute('aria-pressed', String(shared))

      const body = el(
        'div',
        { class: 'group-body' },
        el(
          'div',
          { class: 'plot-icon-row' },
          // The two states first, then the two levellings, which are actions.
          // A word for either would say the same thing in a column sixteen
          // characters wide that has four other things to fit in it.
          overlayButton,
          linkButton,
          iconButton(
            'unfold-vertical',
            'Give every track in this group the height of its tallest member',
            () => {
              const tallest = laneSize(Math.max(...members.map((member) => member.style.size)))
              for (const member of members) store.restyle(member.id, { size: tallest })
            },
            { class: 'btn btn-icon', size: 14 },
          ),
          // The same levelling from the other end. A group is a set of tracks
          // read against one axis, so one height for all of them is the whole
          // point — and which height that is depends entirely on whether the
          // reader is making room or using it.
          iconButton(
            'fold-vertical',
            'Give every track in this group the height of its shortest member',
            () => {
              const shortest = laneSize(Math.min(...members.map((member) => member.style.size)))
              for (const member of members) store.restyle(member.id, { size: shortest })
            },
            { class: 'btn btn-icon', size: 14 },
          ),
        ),
        el(
          'div',
          { class: 'group-members' },
          // One member per row, name left and × right, so the crosses line up as
          // a column: pills wrapping mid-name put every × at a different offset,
          // and a list of things you can remove wants one place to aim at.
          ...members.map((member) =>
            el(
              'div',
              { class: 'group-member', title: member.label },
              el('span', {
                class: 'group-member-chip',
                style: { background: member.style.colour },
              }),
              el('span', { class: 'group-member-name', text: member.label }),
              // The same × the annotations card puts on a row, at the same size:
              // this one takes a track out of a group rather than out of the
              // session, and the two should not be two different marks.
              iconButton(
                'x',
                `Take ${member.label} out of ${name}`,
                () => store.restyle(member.id, { group: '' }),
                { class: 'btn-close group-member-out', size: 14 },
              ),
            ),
          ),
        ),
      )

      rows.push(
        el(
          'div',
          { class: `group-card${shown ? '' : ' is-hidden'}` },
          head,
          ...(open ? [body] : []),
        ),
      )
    }
    this.host.replaceChildren(...rows)
  }
}
