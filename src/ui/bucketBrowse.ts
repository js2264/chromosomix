/**
 * The folder view over a bucket prefix, and the dialog that offers it anywhere.
 *
 * `BucketsCard` grew this first, and grew it in the wrong place: browsing lived
 * inside the screen where keys are *typed*, so reaching a file meant opening the
 * credentials dialog and scrolling past the secret-key form to a folder list
 * underneath it. That is the right home for the form and the wrong one for the
 * listing — the listing answers "which file", which is a question asked at every
 * box in the application that takes a URL, and not one of them is a place to be
 * looking at an access key.
 *
 * So the view is a component and the dialog around it is thin. `BucketsCard`
 * keeps it inline, where it still doubles as the test that a key just typed
 * works; every URL box opens the same view in a modal through
 * `ui/browseButton.ts`.
 *
 * ## And then the view stopped being a bucket's
 *
 * A directory on the machine is a folder in the same sense, and the crumbs, the
 * filter, the list and the line underneath were the same five things over a
 * different backend. They moved to `ui/folderBrowse.ts`, over
 * `browse/folder.ts`'s interface. What is left here is the bucket-shaped door:
 * a scope goes in, `browse/bucket.ts` turns it into a folder, and a pick comes
 * back out as the `BucketObject` and `BucketScope` that every caller of this
 * module already expects.
 *
 * **The modal stays bucket-only, and that is deliberate.** It is opened from
 * boxes that take a *URL*, and a file in a local directory has none — offering
 * one there would produce a pick the box cannot hold. The Files panel is where
 * a local folder is browsed, because that is the surface with somewhere to put
 * the answer.
 *
 * ## Why a picked file is opened rather than typed into the box
 *
 * The box beside the button is for a URL somebody has; this is for one they do
 * not, and handing back a forty-character signed-prefix URL for the reader to
 * press *add* on would be asking them to confirm a string they have no way to
 * check. The pick is the instruction. It carries the scope it was listed under,
 * so the file opens with the key that found it rather than with whatever a
 * second lookup resolves — the same rule `s3/attach.ts` states from the other
 * side.
 */

import { Modal } from './Modal'
import { button, el } from './dom'
import { FolderBrowseView } from './folderBrowse'
import { bucketFolder } from '../browse/bucket'
import { addressOf, readScopes, scopeFor, type BucketScope } from '../s3/credentials'
import type { BucketObject } from '../s3/list'

export { note } from './folderBrowse'

/**
 * What a chosen file is handed back as.
 *
 * The scope is `null` only when the file was chosen through the credentials
 * dialog opened from the empty state, where the caller has a URL and no
 * listing behind it. Every caller treats that as "look the key up" — which is
 * what happens at the worker boundary anyway — so it is a narrowing, not a
 * failure.
 */
export type BucketPick = (url: string, scope: BucketScope | null) => void

export interface BrowseViewProps {
  onPick(object: BucketObject, scope: BucketScope): void
}

/**
 * One level of one prefix, in the shape this module's callers already speak.
 *
 * An adapter over {@link FolderBrowseView} and nothing more. The entry it hands
 * back is rebuilt as a {@link BucketObject} because that is what `BucketsCard`
 * and the modal below take, and because a `FolderEntry`'s `path` *is* the
 * object's URL for a bucket (`browse/bucket.ts`) — so the rebuild reads one
 * field rather than recomputing anything.
 */
export class BucketBrowseView {
  readonly el: HTMLElement
  private readonly view: FolderBrowseView

  constructor(props: BrowseViewProps) {
    this.view = new FolderBrowseView({
      onPick: (entry, folder) => {
        const scope = this.scopes.get(folder.id)
        if (scope === undefined) return
        props.onPick(
          { key: entry.path, name: entry.name, size: entry.size ?? 0, url: entry.path },
          scope,
        )
      },
    })
    this.el = this.view.el
  }

  /** Which scope each folder id came from, so a pick can name it again. */
  private readonly scopes = new Map<string, BucketScope>()

  /** Whether the scope with this id is the one on screen. */
  isShowing(id: string): boolean {
    return this.view.isShowing(`bucket:${id}`)
  }

  /** Put the view back to showing nothing. */
  clear(): void {
    this.view.clear()
  }

  /** List one level of `prefix`, signed with `scope` where it has a key. */
  async browse(scope: BucketScope, prefix: string): Promise<void> {
    const folder = bucketFolder(scope)
    this.scopes.set(folder.id, scope)
    await this.view.browse(folder, prefix)
  }
}

/**
 * The browser as a dialog, for the URL boxes.
 *
 * Opens on the first stored scope rather than asking which — one is the common
 * case and the chooser above the list moves between them in a click, so
 * demanding the answer first would be a screen everybody passes through to get
 * to the screen they wanted.
 */
export function openBucketBrowser(props: { onPick: BucketPick; onClose?(): void }): Modal {
  return new Modal({
    title: 'Open from a bucket',
    variant: 'modal-wide',
    ...(props.onClose === undefined ? {} : { onClose: props.onClose }),
    body: (close) => browserBody(props.onPick, close),
  })
}

function browserBody(onPick: BucketPick, close: () => void): HTMLElement {
  const scopes = readScopes()
  if (scopes.length === 0) return emptyBody(onPick, close)

  const view = new BucketBrowseView({
    onPick: (object, scope) => {
      close()
      onPick(object.url, scope)
    },
  })
  const root = el('div', { class: 'modal-body bucket-body' })
  if (scopes.length > 1) root.append(chooser(scopes, view))
  root.append(view.el)
  void view.browse(scopes[0], addressOf(scopes[0].base)?.prefix ?? '')
  return root
}

/**
 * Which bucket, when there is more than one.
 *
 * Absent at one scope, because a row of one button is a label that can be
 * pressed. The marked button is the one being browsed, updated here rather than
 * from the view: clicking one of these is the only way the scope changes, so
 * there is nothing else to hear from.
 */
function chooser(scopes: readonly BucketScope[], view: BucketBrowseView): HTMLElement {
  const buttons = scopes.map((scope) =>
    button(scope.label, () => {}, { class: 'btn bucket-pick', title: scope.base }),
  )
  const mark = (chosen: BucketScope): void => {
    for (const [at, node] of buttons.entries()) {
      node.classList.toggle('is-on', scopes[at].id === chosen.id)
    }
  }
  for (const [at, node] of buttons.entries()) {
    const scope = scopes[at]
    node.addEventListener('click', () => {
      mark(scope)
      void view.browse(scope, addressOf(scope.base)?.prefix ?? '')
    })
  }
  mark(scopes[0])
  return el('div', { class: 'bucket-picks' }, ...buttons)
}

/**
 * What the dialog says with no bucket stored.
 *
 * A sentence and one button, rather than the add form inlined here: the form
 * belongs to `ui/bucketForm.ts`, and two copies of it writing the same
 * `localStorage` key is two places for the validation to drift apart.
 */
function emptyBody(onPick: BucketPick, close: () => void): HTMLElement {
  return el(
    'div',
    { class: 'modal-body bucket-body' },
    el('p', {
      class: 'hint',
      text:
        'No buckets are set up yet. A bucket entry is a URL prefix — with a read-only key where ' +
        'the data is private, and with nothing else where it is public: everything under that ' +
        'prefix is then listed and read, and nothing else changes. A file on a public URL needs ' +
        'none of this — paste it into the box instead.',
    }),
    el(
      'div',
      { class: 'bucket-actions' },
      button(
        'add a bucket…',
        () => {
          close()
          void import('./BucketsCard').then(({ openBuckets }) => {
            // The credentials dialog browses too, so a reader who came here for
            // a file gets one from there without a second trip: whatever they
            // open is handed to the same caller, with the scope looked up from
            // the entry they have just saved.
            openBuckets({ onOpen: (uri) => onPick(uri, scopeFor(uri)) })
          })
        },
        { class: 'btn btn-primary' },
      ),
    ),
  )
}
