/**
 * The folder backends that register themselves, loaded once at boot.
 *
 * `connected.ts` composes the disk and the bucket by name and takes the rest
 * as registrations (`registerFolderSource`), so that the module every panel
 * subscribes to reaches for no token. Something still has to *load* the
 * modules that register, and this is it: one side-effect import per backend,
 * imported once by `app/App.ts`. A build that should not offer a backend
 * leaves it out here rather than teaching `connected.ts` about builds (§24.9).
 */

import './gdrive'
import './dropbox'
