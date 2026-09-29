/**
 * How the built renderer and main process become installers.
 *
 * **`.cjs`, and passed explicitly with `--config`.** Both halves matter.
 * `read-config-file` loads `.yml`, `.yaml`, `.json`, `.json5`, `.toml`, `.js`
 * and `.cjs` — and not `.mjs`; and a `.js` file in this package is ESM, because
 * `package.json` says `type: module`. Getting either wrong fails *silently*: the
 * config is simply not found, every default applies, and the default
 * `directories.output` is `dist` — the directory Vite writes and GitHub Pages
 * uploads. The symptom is a `.dmg` inside the website build, or the website
 * build deleted, and nothing anywhere says the config was ignored.
 *
 * Signing is not configured, deliberately, and the hooks for it are left inert
 * below rather than absent so that turning it on later is a diff to read rather
 * than a design to rediscover. The first releases are unsigned; `docs/desktop.md`
 * says so and gives the user the two warnings verbatim.
 */

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.github.js2264.metacooler-viewer',
  // Not the manifest's parenthesised, em-dashed PWA name. This string becomes
  // the macOS `.app` bundle name and part of every artifact filename, and a
  // filename with an em dash in it is one users cannot type and shells quote
  // wrongly.
  productName: 'metacooler-viewer',
  copyright: 'Copyright © 2026 Jacques Serizay',

  directories: {
    // Never `dist`. See the note at the top of this file.
    output: 'release',
    buildResources: 'build',
  },

  asar: true,
  // Nothing here has a native module: h5wasm is a single file with the wasm
  // inlined, and rebuilding nothing takes time on every platform.
  npmRebuild: false,
  // No update service (spec §1, C1). Publishing is a human pushing a tag.
  publish: null,
  artifactName: '${name}-${version}-${os}-${arch}.${ext}',

  /**
   * What goes in the archive.
   *
   * `!node_modules/**\/*` is the line that matters: the main process imports
   * nothing outside Node's standard library, so the entire dependency tree —
   * including Vite, TypeScript and electron-builder itself — is build-time only.
   * Without it the asar is ~60 MB of tooling instead of ~6 MB of application.
   *
   * The data-extension exclusion is a second line of defence and is expected to
   * match nothing: `publicDir: false` means `public/demo/` was never copied into
   * the renderer build in the first place. It is here because the first guard is
   * one config key away from being reverted, and 250 MB in an installer is a
   * thing nobody notices until a user complains about the download.
   */
  files: [
    'dist-electron/main/**/*',
    'dist-electron/renderer/**/*',
    'package.json',
    '!node_modules/**/*',
    '!**/*.map',
    '!**/demo/**',
    '!**/*.{metacool,mmetacool,cool,mcool,bw,bigWig,narrowPeak,gtf,pairs,tsv}',
  ],

  /**
   * The icon again, this time as a file the running app can hand to the OS.
   *
   * `icon:` below is a *build* input — electron-builder reads it, converts it,
   * and the original is not in the package afterwards. `main.cts` needs the
   * path at runtime for the Linux window icon, and beside the asar rather than
   * inside it, because the compositor is given a path and will not read an
   * archive. 60 KB, on an installer measured in tens of megabytes.
   */
  extraResources: [{ from: 'build/icon.png', to: 'icon.png' }],

  /**
   * Flags compiled into the Electron binary itself, which a packaged app cannot
   * talk its way out of the way it can talk its way past a JavaScript check.
   *
   * `runAsNode: false` is not theoretical. `ELECTRON_RUN_AS_NODE=1` was set in
   * the environment this was developed in, and it silently turns the app into a
   * Node interpreter running whatever it is pointed at — with the app's own
   * identity and file access.
   *
   * `resetAdHocDarwinSignature` is mandatory rather than optional: flipping a
   * fuse rewrites bytes in the binary, which invalidates the ad-hoc signature
   * already applied to it. Without this the macOS build packages cleanly and
   * then refuses to launch on Apple Silicon.
   */
  electronFuses: {
    runAsNode: false,
    enableNodeCliInspectArguments: false,
    enableNodeOptionsEnvironmentVariable: false,
    onlyLoadAppFromAsar: true,
    resetAdHocDarwinSignature: true,
  },

  mac: {
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    icon: 'build/icon.png',
    category: 'public.app-category.education',
    // `'-'` is ad-hoc signing. **Never `null`.** `null` skips signing entirely,
    // and Apple Silicon refuses to execute an unsigned arm64 binary — so the
    // `null` recipe, which is the one every blog post quotes for "unsigned
    // builds", produces a `.dmg` that builds, uploads, installs, and then does
    // nothing at all when double-clicked. CI never notices.
    identity: '-',
    // Both off while unsigned: hardened runtime is meaningful only under a real
    // Developer ID, and notarisation requires one.
    hardenedRuntime: false,
    notarize: false,
    // --- inert hook: real signing ------------------------------------------
    // identity: 'Developer ID Application: … (TEAMID)',
    // hardenedRuntime: true,
    // entitlements: 'build/entitlements.mac.plist',
    // entitlementsInherit: 'build/entitlements.mac.plist',
    // notarize: { teamId: 'TEAMID' },
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
    // `signExecutable: false`, **not** `signAndEditExecutable: false`. The
    // second also disables resedit, which is what writes the icon and the
    // version metadata into the `.exe` — so the build succeeds and ships an
    // executable with the default Electron icon and no version information.
    signExecutable: false,
    // --- inert hook: real signing ------------------------------------------
    // signtoolOptions: { certificateSubjectName: '…' },
  },

  nsis: {
    // A per-user, one-click silent installer is the wrong default for something
    // a researcher installs on a shared or managed machine: it needs no
    // administrator, but it also gives no chance to see where it is going.
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },

  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    icon: 'build/icon.png',
    category: 'Science',
    // Required: fpm refuses to build the `.deb` without it, and it refuses at
    // pack time — which on a tag is after everything else has already passed.
    // A `noreply` address rather than a personal one, because this is baked
    // into a public package and cannot be quietly changed afterwards.
    maintainer: 'Jacques Serizay <js2264@users.noreply.github.com>',
    synopsis: 'Viewer for Hi-C contact maps, genome tracks and 3D models',
  },
}
