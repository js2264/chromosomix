/**
 * The form that adds a bucket, and the only copy of it.
 *
 * Two screens ask for a bucket — the credentials dialog, which is where keys are
 * managed, and the Connect dialog, which is where a *folder* is attached and a
 * bucket is one of the two kinds. `ui/BucketsCard.ts` states the rule this file
 * exists to keep: two copies of six fields writing one `localStorage` key is two
 * places for the validation to drift apart, and the half that drifts is always
 * the one opened less.
 *
 * ## Public first, and it is one field
 *
 * The public case is the one a reader arrives with — a link somebody put in a
 * paper — and it needs nothing but that link, so it is what the form opens on.
 * The five signing fields are behind a switch rather than below the URL, because
 * a form that shows six boxes to someone who has one is a form that reads as
 * *you need six things*, and the commonest outcome of that is the reader
 * deciding this is not for them.
 *
 * The switch is two buttons and not a checkbox, because what it chooses is which
 * of two arrangements this is — public data, or a key — and both are ordinary.
 * A checkbox called "private" would make one of them the exception.
 *
 * ## What it does not do
 *
 * No "test connection" button, for `BucketsCard`'s reason: the listing *is* the
 * test, against the same signature and the same preflight as every later read,
 * and a separate probe would be a second code path whose passing would mean
 * nothing about the first. Saving lands the reader in the folder view, which is
 * the honest version of the same reassurance.
 */

import { button, el, field } from './dom'
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
export function bucketForm(props: BucketFormProps): HTMLElement {
  const label = el('input', { class: 'input', type: 'text', placeholder: 'lab collections' })
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
    { class: 'bucket-keys hidden' },
    field('region', region, "The bucket's region. Part of the signature, so a wrong one is a 403."),
    field('access key ID', keyId),
    field('secret key', secret),
    field('session token', token, 'Only for STS or SSO credentials.'),
    el('p', {
      class: 'hint',
      text:
        'The key is kept in this browser and signs requests from this page, so anything able to ' +
        'run script on this origin can read it. There is no server to hide it behind — that is ' +
        'the same property that makes a dropped file never leave your machine. Create an IAM ' +
        'user with s3:GetObject and s3:ListBucket on this prefix and nothing else, and never ' +
        'paste an administrator key here.',
    }),
  )

  let signed = false
  const publicButton = button('public', () => setSigned(false), {
    class: 'btn',
    title: 'Anything under this URL is readable without a key',
  })
  const privateButton = button('needs a key', () => setSigned(true), {
    class: 'btn',
    title: 'Requests under this URL are signed with the key below',
  })
  const note = el('p', { class: 'hint' })
  function setSigned(next: boolean): void {
    signed = next
    publicButton.classList.toggle('is-on', !next)
    privateButton.classList.toggle('is-on', next)
    keyFields.classList.toggle('hidden', !next)
    note.textContent = next
      ? 'Requests under this prefix are signed; everything else — the public demos included — is ' +
        'fetched unsigned, as before.'
      : 'Nothing is stored but the URL. Browsing a public prefix also needs the bucket policy to ' +
        'grant s3:ListBucket to everyone, which is a different grant from the one that makes its ' +
        'files downloadable — where it is missing, files under it still open by URL.'
  }
  setSigned(false)

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
    if (signed && (region.value.trim() === '' || keyId.value.trim() === '' || secret.value === '')) {
      error.textContent = 'Region, access key ID and secret key are all part of the signature.'
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
    el('div', { class: 'bucket-kind' }, publicButton, privateButton),
    note,
    field('name', label, 'What you call it. Never sent anywhere.'),
    field('URL', base, 'The prefix this entry covers. Everything under it is browsed and read.'),
    keyFields,
    error,
    el('div', { class: 'bucket-actions' }, button('save', save, { class: 'btn btn-primary' })),
  )
}
