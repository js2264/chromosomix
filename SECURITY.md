# Security policy

## Supported versions

The newest release, at <https://chromosomix.app/>, and `main`. Older releases, kept at their own
addresses, are not patched: a fix comes in a new release.

## Reporting a vulnerability

Please do not open a public issue. Report it privately, through
[GitHub's vulnerability reporting](https://github.com/js2264/chromosomix/security/advisories/new),
or by email to the maintainer at <jacquesserizay@gmail.com>. Say what it affects, how to reproduce
it, and which build (**About → version**, or `chromosomix --version`).

Once it is fixed and released, the advisory is published, crediting you unless you ask otherwise.

## Scope

chromosomix has no server, no account and no upload: the web app, the desktop app, the command line
and the notebook widgets read files in place or from the hosts the user points them at
([Privacy](https://doc.chromosomix.app/advanced/privacy/)). What matters most:

- a file, a link, a workspace or a message from an embedding page that makes the app run code, read
  a file the user did not choose, or send data anywhere;
- the credentials the app holds for a bucket, Google Drive or Dropbox leaving the browser for any host
  but their own;
- the widgets' file server on `127.0.0.1` serving a file outside the directory it was given.
