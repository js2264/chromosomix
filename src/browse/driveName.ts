/**
 * What Drive calls a file, for an address that only says its id (SPECS §24.9).
 *
 * A share link pasted into the URL box becomes the API's media URL, and that
 * address ends in an id: nothing in it says whether the bytes are a contact
 * map or a bigWig, and nothing in it is a name a tab could show. A folder
 * listing hands the name along beside the address; a pasted link has no folder.
 * So the file is asked, once, before it is opened — `files.get` with
 * `fields=name`, on the same key or token the read itself will carry — which is
 * one small request against the same project, and it costs less than what it
 * replaces: a name decides the door (`routeFor`), where the bytes had to be
 * asked.
 *
 * ## Never in the way
 *
 * A name is a courtesy. This answers `null` rather than throwing for an address
 * that is not Drive's, for a site with nothing to ask with (no key and no
 * sign-in — Google refuses an anonymous `files.get` even for a public file, so
 * the round trip is not spent), for a refusal, and for a network that never
 * answered; the open then goes ahead under the id, exactly as it did before. A
 * refusal is not memoised, because the reader may sign in next.
 *
 * ## Its own module
 *
 * Not in `browse/gdrive.ts`, which registers a folder backend on import and is
 * loaded only where a Drive folder can be listed. A pasted link is opened in
 * every build, and this has no side effect to keep out of one.
 */

import { accessHeadersFor } from '../s3/credentials'
import { applyAccess } from '../sources/access'

/** The Drive API's files collection, as `browse/gdrive.ts` spells it. */
const FILES = 'https://www.googleapis.com/drive/v3/files'

/** Names already answered, by file id, for the life of the page. */
const names = new Map<string, Promise<string | null>>()

/**
 * The file id in a Drive API media URL, or `null` for any other address.
 *
 * The one spelling `sources/rewrite.ts` and `browse/gdrive.ts` both produce —
 * `…/drive/v3/files/<id>?alt=media…` — and not the listing URL, whose path
 * ends at `files`. Decoded, because the id was encoded on the way in.
 */
export function driveFileIdOf(url: string): string | null {
  const match = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?#]+)(?:[?#]|$)/i.exec(url)
  if (match === null) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/**
 * The name Drive has for the file at `url`, or `null` where nothing can say.
 *
 * Asked once per id: two doors that open the same file in one page — the
 * sniff and then the map door, say — share the one answer.
 */
export async function driveFileName(url: string): Promise<string | null> {
  const id = driveFileIdOf(url)
  if (id === null) return null
  const held = names.get(id)
  if (held !== undefined) return held
  const asked = ask(id)
  names.set(id, asked)
  const name = await asked
  if (name === null) names.delete(id)
  return name
}

async function ask(id: string): Promise<string | null> {
  const url = `${FILES}/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`
  const headers = accessHeadersFor(url)
  if (Object.keys(headers).length === 0) return null
  try {
    const response = await fetch(url, applyAccess(undefined, { url, headers }))
    if (!response.ok) return null
    const body: unknown = await response.json()
    const name =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['name'] : undefined
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
  } catch {
    return null
  }
}
