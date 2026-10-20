/**
 * Types for `third-party-notices.mjs`, which is plain JavaScript for the reason
 * `csp.mjs` is: six Vite configs, two shape checks and a test import it, and a
 * build input that needed compiling before the build could run would be a
 * bootstrapping problem nobody needs.
 */

import type { Plugin } from 'vite'

/** What every build calls the file, beside what it built. */
export declare const NOTICES_FILE: string

/** How the text opens — what a shape check looks for. */
export declare const NOTICES_TITLE: string

/** Material copied or ported into `src/`, and where its licence is. */
export interface VendoredEntry {
  name: string
  files: string[]
  licence: string
  url: string
  what: string
  /** Reads the upstream's version off the copy's own header. */
  version?: RegExp
  /** The installed package the generator read, whose licence files are quoted. */
  from?: string
  /** Licence texts under `licenses/`, one or several, for an upstream that is not an npm package. */
  text?: string | readonly string[]
}

export declare const VENDORED: readonly VendoredEntry[]

/** Package directories, and the names of the vendored entries, a build carried. */
export interface Carried {
  packages: Set<string>
  vendored: Set<string>
}

/** One entry of the notices, as `renderNotices` writes it. */
export interface NoticeEntry {
  name: string
  version: string
  licence: string
  url: string
  author?: string
  what?: string
  files?: string[]
  texts: Array<{ name: string; text: string }>
  /** The texts are the one committed under `licenses/` for a package that ships none. */
  substitute?: boolean
}

/** The directory of the package a module belongs to, or `null` for one of ours. */
export declare function packageDirOf(id: string): string | null

/** Record every module that put code into a bundle, and every file an asset came from. */
export declare function collect(bundle: Record<string, unknown>, into?: Carried): void

/** The text, from what was found. */
export declare function renderNotices(input: {
  version: string
  repository: string
  /** chromosomix's own licence, by SPDX identifier: `package.json`'s. MIT when absent. */
  licence?: string
  /** chromosomix's own LICENSE, reproduced ahead of the others. */
  own?: string
  packages: NoticeEntry[]
  vendored: NoticeEntry[]
}): string

/** The text for what the builds in this process carried. */
export declare function noticesText(from?: Carried): string

/** The text as an HTML comment, for the build that is one file. */
export declare function noticesComment(): string

/** The page's plugin; `fileName: null` collects without emitting. */
export declare function thirdPartyNotices(options?: { fileName?: string | null }): Plugin

/** A worker's plugin, for `worker.plugins`. */
export declare function thirdPartyCollector(): Plugin
