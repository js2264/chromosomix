/**
 * Private buckets: the keys, and the folder view they unlock.
 *
 * The URL box beside this one already opens anything public, and with a key
 * stored here it opens anything private too — so the *credentials* half of this
 * dialog is small and the *browsing* half is the point. Nobody remembers the
 * key of a `.mcool` inside `collections/hum53/2026-03-run2/`, and a lab that
 * keeps a list of them beside the bucket has to keep the list in step with the
 * bucket. `ListObjectsV2` with a delimiter asks S3 for one level at a time, so
 * the folder view is the bucket rather than a description of it.
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
 */

import { Modal } from './Modal'
import { button, el, field } from './dom'
import { icon, iconButton } from './icons'
import { BucketBrowseView } from './bucketBrowse'
import {
  addressOf,
  credentialOf,
  normaliseBase,
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

/**
 * An id that does not collide with one already stored.
 *
 * `crypto.randomUUID` is not reachable in every context this ships to — it
 * needs a secure origin, which `file://` in a packaged build is not — so the
 * id is built from the count and a random suffix. Nothing depends on it being
 * unguessable; it exists so a row can be replaced rather than matched by a
 * label the user is free to reuse.
 */
function mintId(existing: readonly BucketScope[]): string {
  const taken = new Set(existing.map((scope) => scope.id))
  for (let n = existing.length; ; n++) {
    const id = `b${n}-${Math.floor(Math.random() * 1e6).toString(36)}`
    if (!taken.has(id)) return id
  }
}

export function openBuckets(props: BucketsProps): Modal {
  return new Modal({
    title: 'Private buckets',
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
      this.close()
      this.props.onOpen(object.url, {
        kind: 'remote',
        url: object.url,
        credential: credentialOf(scope),
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
          'A bucket entry is a URL prefix and the key that reads it. Requests under that ' +
          'prefix are signed; everything else — the public demos included — is fetched ' +
          'unsigned, as before.',
      }),
      this.listEl,
      this.addForm(),
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
            // permissions problem rather than as a typo four fields up.
            el('span', { class: 'bucket-row-meta', text: `${scope.region} · ${scope.accessKeyId}` }),
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
    // A listing left on screen under a key that has just been deleted is a
    // folder view of a bucket this app can no longer read.
    if (this.browser.isShowing(id)) this.browser.clear()
    this.renderList()
  }

  /**
   * The add form.
   *
   * Six fields and no step-by-step: every one of them is something the user is
   * copying out of the AWS console or a `credentials` file, and splitting a
   * copy-paste across two screens makes it longer rather than simpler.
   */
  private addForm(): HTMLElement {
    const label = el('input', { class: 'input', type: 'text', placeholder: 'lab collections' })
    const base = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'https://rsglab-data.s3.eu-west-3.amazonaws.com/collections/',
    })
    const region = el('input', { class: 'input', type: 'text', placeholder: 'eu-west-3' })
    const keyId = el('input', { class: 'input', type: 'text', placeholder: 'AKIA…' })
    // `type=password` so a key is not read over a shoulder or caught by a
    // screen recording during a demo — which is exactly when someone opens this
    // dialog to show how it works.
    const secret = el('input', { class: 'input', type: 'password', placeholder: 'secret key' })
    const token = el('input', {
      class: 'input',
      type: 'password',
      placeholder: 'session token (only for temporary credentials)',
    })
    const error = el('p', { class: 'hint bucket-error' })

    const save = (): void => {
      const normalised = normaliseBase(base.value)
      if (normalised === null) {
        // The `https:` requirement is a refusal rather than a normalisation:
        // over `http:` the `Authorization` header crosses the wire in clear,
        // and quietly upgrading the scheme would mean the app deciding on the
        // user's behalf which host they meant.
        error.textContent =
          'The prefix must be an https:// URL — a bucket reached over http:// would send the ' +
          'signature in clear.'
        return
      }
      if (region.value.trim() === '' || keyId.value.trim() === '' || secret.value === '') {
        error.textContent = 'Region, access key ID and secret key are all part of the signature.'
        return
      }
      const sessionToken = token.value.trim()
      this.scopes = [
        ...this.scopes,
        {
          id: mintId(this.scopes),
          label: label.value.trim() === '' ? normalised : label.value.trim(),
          base: normalised,
          region: region.value.trim(),
          accessKeyId: keyId.value.trim(),
          secretAccessKey: secret.value,
          ...(sessionToken === '' ? {} : { sessionToken }),
        },
      ]
      writeScopes(this.scopes)
      error.textContent = ''
      for (const input of [label, base, region, keyId, secret, token]) input.value = ''
      this.renderList()
    }

    return el(
      'div',
      { class: 'bucket-add' },
      el('h3', { text: 'Add a bucket' }),
      field('name', label, 'What you call it. Never sent anywhere.'),
      field('prefix', base, 'Everything under this URL is signed with the key below.'),
      field('region', region, "The bucket's region. Part of the signature, so a wrong one is a 403."),
      field('access key ID', keyId),
      field('secret key', secret),
      field('session token', token, 'Only for STS or SSO credentials.'),
      error,
      el('div', { class: 'bucket-actions' }, button('save', save, { class: 'btn btn-primary' })),
    )
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
