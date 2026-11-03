/** Types for `webp-size.mjs`, which the repository's suite imports. */

/** A WebP's width in pixels, read from its header, or `null` for a file that is not one. */
export declare function webpWidth(bytes: Buffer): number | null
