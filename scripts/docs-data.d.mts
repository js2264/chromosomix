/**
 * Types for `docs-data.mjs`, which is plain JavaScript for the reason
 * `llms.mjs` is: a workflow runs it before the documentation is built, and a
 * test imports the functions that read the repository's files.
 */

/** Where the rendered validation notebook is published, beside the app. */
export declare const VALIDATION_URL: string

/** The identifier pandoc, and so Quarto, gives a heading. */
export declare function pandocId(heading: string): string

/** Each numbered section of `notebooks/validation.qmd`, by its number, as its address on the published page. */
export declare function validationAnchors(qmd: string): Record<string, string>

/** One release in `CHANGELOG.md`. */
export interface ChangelogRelease {
  /** `0.19.0`, or `Unreleased`. */
  version: string
  /** `2026-11-01`, or `null` where the section has none. */
  date: string | null
  /** The section's body, its headings raised one level. */
  body: string
}

/** The releases in `CHANGELOG.md`, newest first; `[Unreleased]` first where asked for and not empty. */
export declare function changelogReleases(changelog: string, options?: { unreleased?: boolean }): ChangelogRelease[]

/** `2026-11-01` as `1 November 2026`. */
export declare function longDate(iso: string): string

/** The app's palettes, type and shape from `src/ui/styles.css`, as the documentation's theme reads them. */
export declare function appTokens(css: string): string
