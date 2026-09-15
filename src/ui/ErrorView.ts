/**
 * Refusals, rendered (spec §10).
 *
 * Every refusal names the file's actual state and the concrete fix. The reader
 * writes the sentence — it knows the actual value — and this view supplies the
 * heading, the "what to do" guidance and, where one exists, the action that
 * resolves it. Switching on `code` rather than pattern-matching the prose is
 * what makes each refusal read specifically instead of all of them reading like
 * "could not open file".
 *
 * The `__unbinned__` case matters more than its size suggests: it is
 * deliberately *not* the unknown-label error, so a user who types
 * `__unbinned__` learns that unassigned contigs are not a genome rather than
 * doubting a name they read in the file.
 *
 * ## One refusal has an answer that is not in the table
 *
 * A `401` or a `403` from `www.googleapis.com` or `storage.googleapis.com` is a
 * `bad-uri` or a `remote-no-ranges` like any other, and the advice above it —
 * host a public object, check the bucket key — is the wrong advice for it: the
 * object is fine, the reader simply is not signed in, or the token this page
 * held has run out (SPECS §24.7). So that pair of codes, and only from that pair
 * of hosts, carries an extra line and the sign-in that resolves it. Everything
 * else keeps the wording it had, which is why the test for this asserts the
 * other host's refusal is *unchanged*.
 */

import { ViewerError, type ErrorCode } from '../errors'
import { button, el } from './dom'
import { GOOGLE_HOSTS, GOOGLE_SIGN_IN_AVAILABLE, googleState, signIn } from '../auth/google'

export interface ErrorViewProps {
  error: unknown
  /** Offered on every screen: go back to the picker. */
  onOpenFilePicker(): void
  /** Offered when the error names entries of a collection. */
  onOpenEntry?(entry: string): void
  /** Offered when the failed action can simply be retried. */
  onRetry?(): void
  /**
   * The open to run again once a Google sign-in offered here has succeeded.
   *
   * Separate from {@link onRetry}, which is a *button* a caller offers when an
   * action is repeatable and which most refusals deliberately do not get. This
   * is not a button: it is what happens after the sign-in, because a reader who
   * has just granted this page access to the file should not then have to find
   * their way back to it.
   */
  onSignedIn?(): void
}

interface Guidance {
  title: string
  advice: string[]
}

const GUIDANCE: Record<ErrorCode, Guidance> = {
  'not-hdf5': {
    title: 'This is not an HDF5 file',
    advice: [
      'The first bytes are not an HDF5 signature, so it is not a cooler, a metacool or an mcool.',
      'If it is compressed (.gz, .zip), decompress it first — HDF5 is read in place and cannot be decompressed on the fly.',
    ],
  },
  'not-a-cooler': {
    title: 'HDF5, but not a cooler or metacool',
    advice: [
      'The file opened as HDF5 but carries neither a cooler nor a metacooler format attribute.',
      'Check you picked the right file; `metacooler attrs <file>` prints what is actually there.',
    ],
  },
  'mmetacool-root': {
    title: 'This is a collection, not a single map',
    advice: [
      'An .mmetacool holds complete metacool entries and is not itself a cooler, so it cannot be opened at its root.',
      'Address one entry with the :: syntax, e.g. file.mmetacool::entries/<name>.',
    ],
  },
  'mcool-root': {
    title: 'This is a resolution ladder, not a single map',
    advice: [
      'An .mcool holds one complete cooler per resolution and is not itself a cooler, so it cannot be opened at its root.',
      'Pick a resolution with the :: syntax, e.g. file.mcool::resolutions/1000 — or just drop the file again and the finest one opens.',
    ],
  },
  'pairs-binning-needed': {
    title: 'This is a contact list, not a map',
    advice: [
      'A .pairs file lists individual contacts and declares no resolution of its own, so a bin size has to be chosen before there is a map to draw.',
      'Pick a base resolution and how many rungs the ladder should have; the file is read once and every rung is served from memory afterwards.',
    ],
  },
  'entry-not-found': {
    title: 'No such entry in this collection',
    advice: ['Pick one of the entries listed below, or drop the :: suffix to see them all.'],
  },
  'bad-format-version': {
    title: 'Unsupported format version',
    advice: [
      'This viewer implements metacooler format version 1.',
      'Re-create the file with a matching metacooler release, or use a viewer build that matches the file.',
    ],
  },
  'bad-ordering': {
    title: 'Contigs are not grouped by genome',
    advice: [
      'The viewer requires contig-ordering = genome-then-length, because that is what makes each genome one contiguous bin range — every view depends on it.',
      'Re-create the file with the default ordering: `metacooler create ... --contig-order genome-then-length`.',
      'Files built from a cooler (cool ordering) or from a FASTA-ordered assembly land here; this is a known and deliberate exclusion.',
    ],
  },
  'variable-bins': {
    title: 'Variable-bin file',
    advice: [
      'This viewer supports fixed-bin files only. Fragment-level and contig-level metacools have variable bins and are refused.',
      'Produce a fixed-bin file with `metacooler binnify <file> --binsize <bp>` and open that.',
    ],
  },
  'unbinned-not-displayable': {
    title: 'Unassigned contigs are not a genome',
    advice: [
      '__unbinned__ holds every contig binning failed to assign. It is a bookkeeping row, not an organism, and there is nothing coherent to display for it.',
      'Its size is reported once, as a QC statistic, in the file info panel.',
    ],
  },
  'dense-too-large': {
    title: 'Selection too large to draw',
    advice: [
      'The requested block would need more memory than a browser tab can be asked for.',
      'Switch to contig level, narrow the range, or open a coarser resolution.',
    ],
  },
  'unknown-label': {
    title: 'Unknown genome or contig',
    advice: [
      'The label before the colon matched neither a genome nor a contig in this file.',
      'Genome and contig namespaces can collide; when they do, the genome wins.',
    ],
  },
  'scool-listing-cost': {
    title: 'This single-cell file has to be read whole, or read slowly',
    advice: [
      'Listing the cells means reading HDF5 link records that writers scatter across the entire file, so there is no bounded read that reaches them.',
      'Either download the object once — fast afterwards, but the whole file crosses the network — or read it in small pieces, which moves far fewer bytes but takes many round trips.',
      'A copy on your own disk has neither cost: drop it here and it is read in place.',
    ],
  },
  'hicpro-no-bins': {
    title: 'This is half of a contact map',
    advice: [
      'A HiC-Pro map is two files: the `.matrix` of pixel counts, and the `_abs.bed` beside it that says which genomic interval each bin id means. Neither is a map on its own.',
      'Drop the two together, or connect the folder they are in and pick the matrix there — the bin file comes with it.',
      'For a URL whose bin file is somewhere unguessable, name it: `<matrix>#bins=<url>`.',
    ],
  },
  'hicpro-load-cost': {
    title: 'This HiC-Pro matrix has to be read whole',
    advice: [
      'A HiC-Pro matrix is a list of pixels as text with no index, so there is no way to reach a region without reading everything before it.',
      'It is read once and then behaves exactly like a cooler — every region and every zoom afterwards is instant.',
      'For a fine resolution, convert it instead: `cooler load -f coo <bins> <matrix> out.cool`.',
    ],
  },
  'cell-not-found': {
    title: 'No such cell in this file',
    advice: [
      'A link or a saved view named cells this .scool does not carry — most often a link made against a different file, or one whose cells were renamed.',
      'The cells table lists every cell this file has; tick the ones you want there.',
    ],
  },
  'bad-range': {
    title: 'That range does not parse',
    advice: [
      'Coordinates use cooler syntax: contig, or contig:start-end with optional thousands separators and k/M/G units.',
      'The end must not be before the start, and neither may fall outside the contig.',
    ],
  },
  unsupported: {
    title: 'Not available in the viewer',
    advice: [
      'This operation exists in the metacooler CLI but not here, because the browser reader deliberately never reads the table it would need.',
      'Run the equivalent `metacooler` command locally.',
    ],
  },
  'genome-coordinate-suffix': {
    title: 'Genome ranges are whole-genome',
    advice: [
      'A genome is a set of contigs, so a base-pair interval on it is not well defined.',
      'Use the genome name alone, or address one of its contigs with contig:start-end.',
    ],
  },
  'bigwig-no-overlap': {
    title: 'This bigWig names different sequences',
    advice: [
      'bigWig files are keyed on chromosome names, which here are contig names from /contigs — not genome names.',
      'Check the track was made against the same assembly as this map.',
    ],
  },
  'remote-no-ranges': {
    title: 'That host does not serve byte ranges',
    advice: [
      'The viewer reads a few kilobytes at a time; without Accept-Ranges: bytes it would have to download the whole file.',
      'Host the file on object storage with range support (any S3-compatible bucket), or download it and drop it here instead.',
    ],
  },
  'remote-compressed': {
    title: 'That host is compressing the file in transit',
    advice: [
      'With Content-Encoding set, a Range request addresses the compressed stream, not the file — so every read after the first returns bytes from the wrong place.',
      'Browsers cannot ask for an uncompressed copy: Accept-Encoding is a forbidden header, so this has to be fixed on the host.',
      'Object storage (S3, R2, GCS) serves application/octet-stream uncompressed by default. GitHub Pages compresses it and offers no way to turn that off.',
      'Downloading the file and dropping it here always works.',
    ],
  },
  'remote-cors': {
    title: 'That host will not let this page read the file',
    advice: [
      'Cross-origin GET and HEAD must be allowed, and Content-Length and Content-Range must be exposed.',
      'GEO and SRA cannot be used as hosts: they serve downloads as attachments, without range or CORS support.',
      'Downloading the file and dropping it here always works.',
    ],
  },
  'remote-too-large': {
    title: 'Too much to download for this operation',
    advice: [
      'This action reads every pixel, which over the network means fetching the whole file.',
      'Run it on a local copy, or publish a genome edge list beside the file (`metacooler network --level genome --header`).',
    ],
  },
  'bad-uri': {
    title: 'That URI does not parse',
    advice: ['Expected file, or file::group — for example file.mmetacool::entries/rep1.'],
  },
  format: {
    title: 'This file does not match the format',
    advice: ['`metacooler check <file>` reports what is wrong without raising.'],
  },
}

export class ErrorView {
  readonly el: HTMLElement

  constructor(props: ErrorViewProps) {
    const error = props.error
    const viewerError = error instanceof ViewerError ? error : null
    const guidance =
      viewerError === null
        ? { title: 'Something went wrong', advice: ['This is not one of the format refusals; the message below is the underlying failure.'] }
        : GUIDANCE[viewerError.code]

    const entries = extractEntries(viewerError)
    const actions: HTMLElement[] = []
    if (entries.length > 0 && props.onOpenEntry) {
      const open = props.onOpenEntry
      actions.push(
        el('div', { class: 'entry-list' }, ...entries.map((entry) => button(entry, () => open(entry)))),
      )
    }
    const google = googleRefusal(viewerError)
    // Built whether or not it is used, and put in the tree only where a sign-in
    // is actually offered: an empty `.inline-error` is a coloured pill with
    // nothing in it, and `hidden` alone would leave one in every other refusal's
    // markup for a stylesheet to get wrong later.
    const signInError = el('p', { class: 'inline-error' })
    signInError.hidden = true
    // Pushed before `try again`, on purpose: repeating an unauthorised request
    // is precisely what does not work, and a reader offered both reaches for
    // whichever reads like the smaller step.
    if (google !== null && google.offer !== null) {
      const offer = google.offer
      const signInButton = button(
        offer === 'again' ? 'sign in again' : 'sign in',
        () => {
          signInError.hidden = true
          signInButton.disabled = true
          void signIn()
            .then(() => props.onSignedIn?.())
            .catch((cause: unknown) => {
              signInError.textContent = cause instanceof Error ? cause.message : String(cause)
              signInError.hidden = false
              signInButton.disabled = false
            })
        },
        { class: 'btn btn-primary' },
      )
      actions.push(signInButton)
    }
    if (props.onRetry) actions.push(button('try again', props.onRetry))
    actions.push(button('open another file', props.onOpenFilePicker, { class: 'btn btn-quiet' }))

    this.el = el(
      'section',
      { class: 'view view-error' },
      el('h2', { class: 'error-title', text: guidance.title }),
      el('p', { class: 'error-message', text: error instanceof Error ? error.message : String(error) }),
      el(
        'ul',
        { class: 'advice' },
        ...[...guidance.advice, ...(google === null ? [] : google.advice)].map((line) =>
          el('li', { text: line }),
        ),
      ),
      detailBlock(viewerError),
      el('div', { class: 'error-actions' }, ...actions),
      google !== null && google.offer !== null ? signInError : null,
    )
  }
}

/**
 * Whether this refusal is a Google host saying *not you*, and what to offer.
 *
 * Two things have to be true, and both are read off the detail the reader
 * attached rather than off the prose: a status of `401` or `403`, and a host
 * that is one of the two a sign-in produces a token for (SPECS §24.7). The host
 * is taken from `detail.host` where the refusal carried one and parsed out of
 * `detail.url` where it did not — the ranged-read refusals carry the URL and not
 * the host, and a token that expires *mid-file* surfaces there rather than at
 * the `HEAD`.
 *
 * `offer` is `null` where there is a story to tell and no button to press:
 * nothing is stored to sign in *with*, the build cannot sign in at all, or this
 * page is already signed in — in which case the token is not the problem and
 * pressing the button again would get the same `403` from the same account.
 */
function googleRefusal(
  error: ViewerError | null,
): { advice: string[]; offer: 'in' | 'again' | null } | null {
  if (error === null) return null
  // The two codes a Google host's refusal can arrive under: `bad-uri` from the
  // `HEAD` probe, which is where a file that was never authorised fails, and
  // `remote-no-ranges` from a ranged read, which is where a token that ran out
  // *mid-file* fails. `remote-cors` is not among them and cannot be: it is the
  // refusal for a failure that carried no status at all.
  if (error.code !== 'bad-uri' && error.code !== 'remote-no-ranges') return null
  const status = error.detail['status']
  if (status !== 401 && status !== 403) return null
  // A request that carried a bucket key and was refused is a key problem, and
  // both refusals above already say so in those words. GCS's XML host would take
  // a bearer token as readily as a signature, so this is not about what the host
  // accepts — it is about not answering "your key is wrong" with "sign in".
  if (error.detail['signed'] === true) return null
  const host = hostOfDetail(error.detail)
  if (host === null || !(GOOGLE_HOSTS as readonly string[]).includes(host)) return null

  const what = host === 'www.googleapis.com' ? 'Drive' : 'Cloud Storage'
  if (!GOOGLE_SIGN_IN_AVAILABLE) {
    return {
      advice: [
        `A ${status} from ${host} on a private ${what} file means the request was not ` +
          'authorised, and this build cannot sign in to Google — an OAuth client is registered ' +
          'against an http(s) origin, which neither the single-file build nor the desktop ' +
          'build has. Open the file in the web build, or download it and drop it here.',
      ],
      offer: null,
    }
  }
  const state = googleState()
  if (!state.configured) {
    return {
      advice: [
        `A ${status} from ${host} means this page was not authorised to read that ${what} ` +
          'file. If it is private, signing in is what authorises it — and this site was built ' +
          'without a Google client id, so it cannot sign in; its maintainer provides one as ' +
          'GOOGLE_CLIENT_ID (docs/deploy.md).',
      ],
      offer: null,
    }
  }
  if (state.signedIn) {
    return {
      advice: [
        `This page is signed in to Google and ${host} still answered ${status}, so the token is ` +
          'not what is missing: the account you signed in as cannot read that file — it has not ' +
          'been shared with it — or the project’s Drive quota is spent for the day.',
      ],
      offer: null,
    }
  }
  return state.expiresAt === null
    ? {
        advice: [
          `A ${status} from ${host} on a private ${what} file is this page not being signed in. ` +
            'Signing in grants it read access to your Drive and Cloud Storage for about an hour; ' +
            'the token is held in memory and never stored.',
        ],
        offer: 'in',
      }
    : {
        advice: [
          `The Google token this page held expired, and ${host} answered ${status}. Signing in ` +
            'again picks the file up where it was; nothing else about the session is lost.',
        ],
        offer: 'again',
      }
}

/** The host a refusal names, directly or through the URL it carried. */
function hostOfDetail(detail: Record<string, unknown>): string | null {
  const host = detail['host']
  if (typeof host === 'string' && host !== '') return host.toLowerCase()
  const url = detail['url']
  if (typeof url !== 'string') return null
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

/** Entry names carried on the error, so the UI can offer them as buttons. */
function extractEntries(error: ViewerError | null): string[] {
  if (error === null) return []
  const entries = error.detail['entries']
  if (!Array.isArray(entries)) return []
  return entries.filter((entry): entry is string => typeof entry === 'string')
}

function detailBlock(error: ViewerError | null): HTMLElement | null {
  if (error === null || Object.keys(error.detail).length === 0) return null
  return el(
    'details',
    { class: 'meta' },
    el('summary', { text: 'What the file actually says' }),
    el('pre', { class: 'json', text: JSON.stringify(error.detail, null, 2) }),
  )
}
