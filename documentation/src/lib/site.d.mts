/** Types for `site.mjs`, which the repository's suite imports. */

export declare const VERSION: string
export declare const IS_DEV: boolean
export declare const BASE: string
export declare const APP_URL: string
export declare const COMMIT: string
export declare const SITE: string
export declare const MANIFEST: string
export declare const REPOSITORY: string
/** The number in `DOCS_PREVIEW`, or `null` for anything that is not a pull request's. */
export declare function previewOf(value: string | undefined): number | null
export declare const PREVIEW: number | null
export declare const PREVIEW_URL: string | null
export declare const VERSION_LABEL: string
export declare const VALIDATE_LINKS: boolean
export declare function withBase(path: string): string
