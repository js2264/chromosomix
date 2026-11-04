/** Types for `live.mjs`, which the repository's suite imports. */

/** The link a picture's title names, `#…` or `?…`, or `null` for a title that names none. */
export declare function liveLink(title: unknown): string | null

/** The address that embeds the app at `app` on `link`: the link with `embed=1` first in its query. */
export declare function embedAddress(app: string, link: string): string

/** The address of the same view in the full app, for a tab of its own. */
export declare function viewerAddress(app: string, link: string): string
export declare const PANELS_FROM: number
export declare function withPanels(address: string): string
