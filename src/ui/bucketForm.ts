/**
 * The form that adds a bucket, and the only copy of it.
 *
 * One screen asks for a bucket now — the Connect dialog, where a *folder* is
 * attached and a bucket is one of the four kinds it can be. It was two, the
 * credentials dialog beside it, and this file exists because of what that
 * costs: two copies of six fields writing one `localStorage` key is two places
 * for the validation to drift apart, and the half that drifts is always the one
 * opened less. It stays one function for the same reason, against the next
 * screen that wants one.
 *
 * ## Public first, and it is one field
 *
 * The public case is the one a reader arrives with — a link somebody put in a
 * paper — and it needs nothing but that link, so it is what the form opens on.
 * The five signing fields are behind *Additional settings* rather than below the
 * URL, because a form that shows six boxes to someone who has one is a form that
 * reads as *you need six things*, and the commonest outcome of that is the
 * reader deciding this is not for them.
 *
 * A disclosure, and not a switch declaring which kind of bucket this is. That
 * switch read *public* against *needs a key*, and it asked the reader to
 * classify the prefix before describing it — a question answerable only in terms
 * of the five fields the answer then reveals, which is backwards. Whether a
 * scope is signed now *follows* from whether a key was typed into it: all three
 * of region, key id and secret, or none of them, which is the one rule the
 * button still has to enforce.
 *
 * What the form no longer explains, the pane's `?` does (`ui/ConnectCard.ts` on
 * `bucketHelp`): where a key is kept and what that costs, and the two policies a
 * bucket needs before any of this reaches it.
 *
 * ## What it does not do
 *
 * No "test connection" button: the listing *is* the test, against the same
 * signature and the same preflight as every later read, and a separate probe
 * would be a second code path whose passing would mean nothing about the first.
 * Pressing *connect this bucket* lands the reader in the folder view, which is
 * the honest version of the same reassurance — and is why the button says
 * *connect* rather than *save*, after a door that said *connect a bucket…*
 * (§20.3). It does save the bucket; the Files column is where that shows.
 */

import { button, el, field } from './dom'
import { icon } from './icons'
import { announce } from '../browse/connected'
import {
  normaliseBase,
  readScopes,
  writeScopes,
  type BucketScope,
} from '../s3/credentials'

/**
 * An id that does not collide with one already stored.
 *
 * `crypto.randomUUID` is not reachable in every context this ships to — it
 * needs a secure origin, which `file://` in a packaged build is not — so the
 * id is built from the count and a random suffix. Nothing depends on it being
 * unguessable; it exists so a row can be replaced rather than matched by a
 * label the user is free to reuse.
 */
export function mintScopeId(existing: readonly BucketScope[]): string {
  const taken = new Set(existing.map((scope) => scope.id))
  for (let n = existing.length; ; n++) {
    const id = `b${n}-${Math.floor(Math.random() * 1e6).toString(36)}`
    if (!taken.has(id)) return id
  }
}

export interface BucketFormProps {
  /**
   * The scope that was just written, so the host can do the one thing worth
   * doing with it: show what is inside.
   */
  onSaved(scope: BucketScope): void
  /** Heading text, or none where the host has already provided one. */
  heading?: string
}

/**
 * The form, as an element.
 *
 * Writes the scope itself rather than handing one up: every host wants it
 * stored, `writeScopes` is the whole of storing it, and a host that had to
 * remember to would be the one place a bucket is added and not kept.
 */
let formSerial = 0

export function bucketForm(props: BucketFormProps): HTMLElement {
  const label = el('input', { class: 'input', type: 'text', placeholder: 'optional' })
  const base = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'https://bucket.s3.amazonaws.com/prefix/ or s3://bucket/prefix/',
  })
  const region = el('input', { class: 'input', type: 'text', placeholder: 'eu-west-3' })
  const keyId = el('input', { class: 'input', type: 'text', placeholder: 'AKIA…' })
  // `type=password` so a key is not read over a shoulder or caught by a screen
  // recording during a demo — which is exactly when someone opens this form to
  // show how it works.
  const secret = el('input', { class: 'input', type: 'password', placeholder: 'secret key' })
  const token = el('input', {
    class: 'input',
    type: 'password',
    placeholder: 'session token (only for temporary credentials)',
  })
  const error = el('p', { class: 'hint bucket-error' })

  const keyFields = el(
    'div',
    { class: 'bucket-keys hidden', id: `bucket-keys-${++formSerial}` },
    field('region', region, "The bucket's region. Part of the signature, so a wrong one is a 403."),
    field('access key ID', keyId),
    field('secret key', secret),
    field('session token', token, 'Only for STS or SSO credentials.'),
  )

  // Open the fields, rather than declare which of two kinds this is. The
  // switch here used to be *public* against *needs a key*, and it asked the
  // reader to classify the bucket before describing it — a question they can
  // only answer in terms of the five fields it governs. A disclosure asks
  // nothing: the common case is a URL and the box stays shut, and whether the
  // scope is signed follows from whether a key was actually typed into it.
  let open = false
  const more = button('additional settings', () => setOpen(!open), { class: 'btn bucket-more' })
  more.setAttribute('aria-controls', keyFields.id)
  more.prepend(icon('chevron-down', { size: 14 }))
  function setOpen(next: boolean): void {
    open = next
    keyFields.classList.toggle('hidden', !next)
    more.classList.toggle('is-on', next)
    more.setAttribute('aria-expanded', String(next))
    more.replaceChildren(icon(next ? 'chevron-up' : 'chevron-down', { size: 14 }))
    more.append('additional settings')
  }
  setOpen(false)

  /** A key was offered, so the scope is a signed one. */
  const signedNow = (): boolean =>
    region.value.trim() !== '' || keyId.value.trim() !== '' || secret.value !== ''

  const save = (): void => {
    // With the region, so `s3://bucket/prefix` lands on the bucket's own
    // endpoint when the reader has said which that is.
    const normalised = normaliseBase(base.value, { region: region.value })
    if (normalised === null) {
      // The `https:` requirement is a refusal rather than a normalisation: over
      // `http:` a signed request sends its signature in clear, and an unsigned
      // one is blocked as mixed content before it leaves. Quietly upgrading the
      // scheme would mean the app deciding on the user's behalf which host they
      // meant.
      error.textContent =
        'The prefix must be an https:// URL or an s3://bucket/prefix — a bucket reached over ' +
        'http:// would send the signature in clear, and a page served over https:// cannot read ' +
        'one at all.'
      return
    }
    const signed = signedNow()
    // All three or none: a scope carrying two of them would be saved, and then
    // fail at the first read with a signature error naming none of this.
    if (signed && (region.value.trim() === '' || keyId.value.trim() === '' || secret.value === '')) {
      error.textContent = 'Region, access key ID and secret key are all part of the signature.'
      // Shut, the missing box is invisible and the sentence is about nothing.
      setOpen(true)
      return
    }
    const scopes = readScopes()
    const sessionToken = token.value.trim()
    const scope: BucketScope = {
      id: mintScopeId(scopes),
      label: label.value.trim() === '' ? normalised : label.value.trim(),
      base: normalised,
      ...(signed
        ? {
            region: region.value.trim(),
            accessKeyId: keyId.value.trim(),
            secretAccessKey: secret.value,
            ...(sessionToken === '' ? {} : { sessionToken }),
          }
        : {}),
    }
    writeScopes([...scopes, scope])
    // A bucket entry *is* a connected folder, so the Files panel has to hear
    // about one added from anywhere — including this form's other host, the
    // Buckets dialog, which knows nothing about that panel and should not have
    // to. Said here rather than inside `writeScopes` because `s3/credentials.ts`
    // is below `browse/` and must not import upward.
    announce()
    error.textContent = ''
    for (const input of [label, base, region, keyId, secret, token]) input.value = ''
    props.onSaved(scope)
  }

  return el(
    'div',
    { class: 'bucket-add' },
    props.heading === undefined ? null : el('h3', { text: props.heading }),
    field('name', label),
    field('URL', base),
    el('div', { class: 'bucket-more-row' }, more),
    keyFields,
    error,
    el('div', { class: 'bucket-actions' }, button('connect this bucket', save, { class: 'btn btn-primary' })),
  )
}
