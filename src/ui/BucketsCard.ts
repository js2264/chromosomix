/**
 * Buckets: the entries, the keys some of them carry, and the folder view.
 *
 * The URL box beside this one already opens anything public, and with a key
 * stored here it opens anything private too — so the *credentials* half of this
 * dialog is small and the *browsing* half is the point. Nobody remembers the
 * key of a `.mcool` inside `collections/hum53/2026-03-run2/`, and a lab that
 * keeps a list of them beside the bucket has to keep the list in step with the
 * bucket. `ListObjectsV2` with a delimiter asks S3 for one level at a time, so
 * the folder view is the bucket rather than a description of it.
 *
 * **An entry need not have a key**, since `s3/credentials.ts` learned to hold a
 * public prefix, so this screen is no longer only about secrets. The heading
 * kept the word *private* for one release and lost it here, because a dialog
 * called "private buckets" listing a public one is a dialog that has to be
 * explained. What it is is the list of buckets this browser knows about.
 *
 * ## Two things this dialog says out loud
 *
 * **Scope the key.** A secret in `localStorage` is readable by any script on
 * this origin, and there is no arrangement here that avoids that — the app has
 * no backend by construction (SPECS C1), so whatever signs a request holds the
 * key that signs it. What bounds the damage is the key's own permissions, so
 * the form says which two it needs and the note says to grant no others.
 *
 * **A prefix, not a bucket.** The scope is `…/collections/`, not
 * `…/rsglab-data/`, and that is not fussiness: signing the *public* `demo/`
 * requests would add a preflight and a signature to every one of them for
 * nothing, and would fail outright once the key is scoped the way the note
 * asks. Unsigned is the correct request for public data, not a lesser one.
 *
 * ## What is deliberately not here
 *
 * No "test connection" button. The listing *is* the test — it uses the same
 * credential, the same signature and the same preflight as every later read —
 * and a separate probe would be a second code path whose passing would mean
 * nothing about the first.
 *
 * And not the folder view's own code: that is `ui/bucketBrowse.ts`, because the
 * question it answers — *which file* — is asked at every URL box in the
 * application and none of those is a place to be looking at an access key. This
 * screen keeps it inline for the reason above, as the check on a key just typed.
 *
 * Nor the add form, for the same reason one level up: `ui/bucketForm.ts`, shared
 * with the Connect dialog, because two copies of six fields writing one
 * `localStorage` key is two places for the validation to drift apart.
 */

import { Modal } from './Modal'
import { button, el } from './dom'
import { icon, iconButton } from './icons'
import { BucketBrowseView } from './bucketBrowse'
import { bucketForm } from './bucketForm'
import { announce } from '../browse/connected'
import {
  addressOf,
  credentialOf,
  isSigned,
  readScopes,
  writeScopes,
  type BucketScope,
} from '../s3/credentials'
import type { SourceSpec } from '../worker/protocol'

export interface BucketsProps {
  /** The picker's own opener, so a listed file opens exactly as a typed URL does. */
  onOpen(uri: string, source: SourceSpec): void
  onClose?(): void
}

export function openBuckets(props: BucketsProps): Modal {
  return new Modal({
    title: 'Buckets',
    variant: 'modal-wide',
    ...(props.onClose === undefined ? {} : { onClose: props.onClose }),
    body: (close) => new BucketsBody(props, close).el,
  })
}

class BucketsBody {
  readonly el: HTMLElement
  private scopes: BucketScope[]
  private readonly listEl: HTMLElement
  /**
   * The same folder view the URL boxes open in a modal (`ui/bucketBrowse.ts`),
   * inline here — where it doubles as the check that the key just typed works,
   * against the same signature and the same preflight as every later read.
   */
  private readonly browser = new BucketBrowseView({
    onPick: (object, scope) => {
      // Opened with the credential already attached, rather than left to the
      // lookup in `s3/attach.ts`. The lookup would find the same one — the URL
      // is under this scope's prefix by construction — but a file the user
      // reached *through* a key should be opened with that key rather than with
      // whatever a second resolution happens to pick.
      //
      // A public scope has none, and then the field is left off entirely rather
      // than set to `null`: `withCredential` treats an absent one as "look it
      // up", which resolves to the same nothing, and the wire shape stays what
      // every other unsigned open sends.
      const credential = credentialOf(scope)
      this.close()
      this.props.onOpen(object.url, {
        kind: 'remote',
        url: object.url,
        ...(credential === null ? {} : { credential }),
      })
    },
  })

  constructor(
    private readonly props: BucketsProps,
    private readonly close: () => void,
  ) {
    this.scopes = readScopes()
    this.listEl = el('div', { class: 'bucket-list' })

    this.el = el(
      'div',
      { class: 'modal-body bucket-body' },
      el('p', {
        class: 'hint',
        text:
          'A bucket entry is a URL prefix, and optionally the key that reads it. Requests under ' +
          'a prefix that has one are signed; everything else — the public demos included — is ' +
          'fetched unsigned, as before.',
      }),
      this.listEl,
      bucketForm({
        heading: 'Add a bucket',
        // Straight into the folder view, which is the honest version of a "test
        // connection" button: same request, same signature, same preflight as
        // every later read.
        onSaved: (scope) => {
          this.scopes = readScopes()
          this.renderList()
          void this.browser.browse(scope, addressOf(scope.base)?.prefix ?? '')
        },
      }),
      this.securityNote(),
      this.browser.el,
    )
    this.renderList()
  }

  // -------------------------------------------------------------------------
  // The stored entries
  // -------------------------------------------------------------------------

  private renderList(): void {
    if (this.scopes.length === 0) {
      this.listEl.replaceChildren(
        el('p', { class: 'hint bucket-empty', text: 'No buckets yet. Add one below.' }),
      )
      return
    }
    this.listEl.replaceChildren(
      ...this.scopes.map((scope) =>
        el(
          'div',
          { class: 'bucket-row' },
          el(
            'div',
            { class: 'bucket-row-text' },
            el('strong', { text: scope.label }),
            el('span', { class: 'bucket-row-base', text: scope.base }),
            // The region is shown because it is the field that is wrong most
            // often and the one whose being wrong is least legible: a bucket in
            // `eu-west-3` signed for `us-east-1` answers 403, which reads as a
            // permissions problem rather than as a typo four fields up. A public
            // entry has neither field and says which of the two kinds it is,
            // because "no key" is the answer to why nothing here is signed.
            el('span', {
              class: 'bucket-row-meta',
              text: isSigned(scope) ? `${scope.region} · ${scope.accessKeyId}` : 'public — no key',
            }),
          ),
          button(
            'browse',
            () => void this.browser.browse(scope, addressOf(scope.base)?.prefix ?? ''),
            { class: 'btn' },
          ),
          iconButton('x', `Remove ${scope.label}`, () => this.remove(scope.id), {
            class: 'btn-close',
            size: 15,
          }),
        ),
      ),
    )
  }

  private remove(id: string): void {
    this.scopes = this.scopes.filter((scope) => scope.id !== id)
    writeScopes(this.scopes)
    // The same entry is a connected folder in the Files panel, which is a second
    // screen showing a bucket this app can no longer read.
    announce()
    // A listing left on screen under a key that has just been deleted is a
    // folder view of a bucket this app can no longer read.
    if (this.browser.isShowing(id)) this.browser.clear()
    this.renderList()
  }

  private securityNote(): HTMLElement {
    return el(
      'div',
      { class: 'bucket-note' },
      icon('info', { size: 16 }),
      el(
        'div',
        {},
        el('strong', { text: 'Use a key that can do only this.' }),
        el('span', {
          text:
            ' The key is kept in this browser and signs requests from this page, so anything ' +
            'able to run script on this origin can read it. There is no server to hide it ' +
            'behind — that is the same property that makes a dropped file never leave your ' +
            'machine. Create an IAM user with s3:GetObject and s3:ListBucket on this prefix ' +
            'and nothing else, and never paste an administrator key here.',
        }),
      ),
    )
  }
}
