/**
 * Opening the curation stage on a session's metagenome (SPECS §33.3): the
 * file's binning asked of the reader, the contacts' read gated on a large
 * remote file as the overview's is (§7.3), and the reader's requests handed to
 * the stage. Kept apart from `app/Session.ts`, which calls it and is told when
 * it closes.
 */

import type { CurationStore } from '../../state/curation'
import { REMOTE_SCAN_BYTE_LIMIT } from '../../ui/Overview'
import type { ReaderClient } from '../../worker/client'
import { CurateStage, type CurateLayouts, type CurateParts } from './CurateStage'

export interface OpenCurationStage {
  /** The map's label, and the stem its exports are named from. */
  title: string
  stem: string
  store: CurationStore
  reader: ReaderClient
  /** Where the file is read from, and its size: a remote file past 64 MiB asks before the contacts' read. */
  sourceKind: 'local' | 'remote' | string
  sourceBytes: number | null
  parts: CurateParts
  memoryKey(): string
  onClose(): void
  /** The genomes' edits of the reference, where the reference editing is on (§27.10). */
  layouts?: CurateLayouts
}

/** Open the stage; `null` where the session went away meanwhile. */
export async function openCurationStage(options: OpenCurationStage): Promise<CurateStage | null> {
  const { reader } = options
  const base = await reader.request<'curationBase'>({ kind: 'curationBase' })
  const bytes = options.sourceBytes
  const gate =
    !base.networkHeld && options.sourceKind === 'remote' && bytes !== null && bytes > REMOTE_SCAN_BYTE_LIMIT ? { pixels: base.pixels ?? 0, bytes } : null
  return new CurateStage({
    title: options.title,
    stem: options.stem,
    store: options.store,
    base,
    requests: {
      network: (onProgress) => reader.cancellable<'curationNetwork'>({ kind: 'curationNetwork' }, onProgress),
      state: (curation, weights, declined) => reader.cancellable<'curationState'>({ kind: 'curationState', curation, weights, declined: declined === undefined ? undefined : [...declined] }),
      focus: (contigs) => reader.cancellable<'curationFocus'>({ kind: 'curationFocus', contigs }),
    },
    parts: options.parts,
    memoryKey: options.memoryKey,
    gate,
    onClose: options.onClose,
    ...(options.layouts === undefined ? {} : { layouts: options.layouts }),
  })
}
