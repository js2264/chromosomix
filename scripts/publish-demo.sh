#!/usr/bin/env bash
#
# Put the demo datasets on the bucket the picker reads.
#
# The repository's `demo/` directory and the bucket's `demo/` prefix are the
# same tree; this script is the one that makes that true. Everything the app
# offers on its landing page is under it — the three published sessions and the
# files they name — and `test/unit/demo-examples.test.ts` checks the copy on
# disk, so a demo that would 404 on the site fails in CI first.
#
#   ./scripts/publish-demo.sh              # sync, then verify
#   ./scripts/publish-demo.sh --dry-run    # print what would be uploaded
#   ./scripts/publish-demo.sh --cors       # (re)apply the bucket CORS policy
#
# Needs the AWS CLI and credentials with `s3:PutObject` on the bucket — an
# access key from `aws configure`, an SSO profile via `AWS_PROFILE`, anything
# the CLI's usual chain accepts. Nothing here reads a credential out of the
# repository, and nothing here should ever be given one.

set -euo pipefail

BUCKET="${DEMO_BUCKET:-rsglab-data}"
PREFIX="${DEMO_PREFIX:-demo}"
REGION="${DEMO_REGION:-eu-west-3}"

# The origins allowed to make *signed* requests — the private-prefix half of the
# CORS policy, spliced into `apply_cors` as the body of a JSON array. The dev
# server is in the list because a private bucket that can only be browsed from
# the published site cannot be debugged from a checkout.
DEFAULT_APP_ORIGINS='"https://js2264.github.io", "https://jserizay.com", "http://localhost:5173"'
APP_ORIGINS="${DEMO_APP_ORIGINS:-$DEFAULT_APP_ORIGINS}"
# The one the verify step preflights with; must be among APP_ORIGINS.
CHECK_ORIGIN="${DEMO_CHECK_ORIGIN:-https://js2264.github.io}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/demo"

# A plain string rather than an array, and expanded unquoted at the call sites.
#
# The array version is what you would write, and it does not run on a Mac:
# macOS still ships bash 3.2 (the last GPLv2 release, from 2007), where
# `"${ARRAY[@]}"` on an *empty* array counts as an unbound variable under
# `set -u` and aborts. Bash 4.4 fixed it, so the same script works on Linux and
# fails on the machine most likely to run it.
#
# The portable array idiom — `${DRY[@]+"${DRY[@]}"}` — is the other fix and is
# unreadable. This value is one fixed token with no whitespace and no glob
# characters, which is the narrow case where an unquoted expansion is exactly
# right: empty expands to no argument at all, which is the behaviour wanted.
DRY=''
CORS_ONLY=0
# Guarded, because `"$@"` with no positional parameters is itself unbound under
# `set -u` in some bash 3.2 builds — the same class of bug, one line up.
if [ $# -gt 0 ]; then
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY='--dryrun' ;;
      --cors) CORS_ONLY=1 ;;
      -h|--help)
        echo "usage: $0 [--dry-run] [--cors]" >&2
        exit 0
        ;;
      *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
  done
fi

command -v aws >/dev/null || {
  echo "the AWS CLI is not on PATH; see https://aws.amazon.com/cli/" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
#
# The half of docs/hosting.md's requirements that same-origin hosting used to
# waive, and that moving the demos off Pages brings back. Three lines matter and
# each is a distinct failure:
#
#   AllowedMethods   GET and HEAD. `RemoteRangeSource.open` probes with a HEAD
#                    before its first ranged GET, so a policy allowing only GET
#                    fails at the first request of every session.
#   AllowedHeaders   `Range`, or the browser strips it from the preflight and
#                    the reader is handed 200s with whole objects in them.
#   ExposeHeaders    `Content-Length` and `Content-Range`. These are the ones
#                    most often forgotten: without them the response *is*
#                    correct but JavaScript cannot read the size out of it, so
#                    the reader cannot tell a served range from an ignored one.
#
# `AllowedOrigins` is `*` because this prefix is public demonstration data —
# reproductions of published datasets, all with an accession in their `note`.
#
# The second rule is here because **an S3 CORS policy is bucket-wide and this
# call replaces all of it.** A rule has no prefix condition, so there is no such
# thing as "the CORS for demo/", and a one-rule policy written for the demos
# takes the private prefixes down with it: signing sends `Authorization`, which
# is not safelisted, so every read and every listing under a private prefix
# preflights, and a preflight naming headers no rule allows is refused with a
# 403 that reaches the page as an unexplained `Failed to fetch`. The symptom is
# a bucket that serves the landing page perfectly and cannot browse a folder.
#
# S3 answers with the first rule matching origin, method and every requested
# header at once, so the rules do not interfere: an unsigned range read matches
# the first, a signed request falls through it and matches the second. Origins
# are named there rather than wildcarded — not because a wildcard would fail,
# it would not (the request carries no cookies, so it is not credentialed in
# the CORS sense), but because there is no reason to advertise the signed path
# to origins that will never legitimately use it. Add yours to APP_ORIGINS.
#
# A failure here does **not** abort the script, and that is deliberate: it runs
# after the upload, so aborting would throw away the verification of 250 MB that
# did transfer, over a permission (`s3:PutBucketCors`) an upload key may
# reasonably not have. The verify step below tests the policy that matters
# rather than trusting this call, so a bucket whose CORS was set once by hand
# passes and a bucket with none fails with the specific header named.
apply_cors() {
  echo "==> applying CORS to s3://$BUCKET"
  if ! aws s3api put-bucket-cors \
    --region "$REGION" \
    --bucket "$BUCKET" \
    --cors-configuration '{
      "CORSRules": [
        {
          "AllowedOrigins": ["*"],
          "AllowedMethods": ["GET", "HEAD"],
          "AllowedHeaders": ["Range", "If-Match", "If-None-Match"],
          "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
          "MaxAgeSeconds": 86400
        },
        {
          "AllowedOrigins": ['"$APP_ORIGINS"'],
          "AllowedMethods": ["GET", "HEAD"],
          "AllowedHeaders": [
            "Range", "If-Match", "If-None-Match",
            "Authorization", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token"
          ],
          "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
          "MaxAgeSeconds": 86400
        }
      ]
    }'; then
    echo "    could not set CORS (needs s3:PutBucketCors). The verify step below will" >&2
    echo "    say whether the policy already on the bucket is good enough." >&2
  fi
}

if [ "$CORS_ONLY" = 1 ]; then
  apply_cors
  exit 0
fi

[ -d "$SRC" ] || { echo "no demo/ directory at $SRC" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------
#
# Two passes, because the content type decides whether the file is readable at
# all. Every data file is `application/octet-stream`: S3 does not compress that
# type, and *not being compressed* is the requirement — `Content-Encoding` on a
# response makes `Range` address the octets of the compressed stream, which
# no browser can opt out of (docs/hosting.md). The CLI would otherwise guess
# from the extension and has no guess for `.mcool`, `.metacool`, `.bw` or `.fa`.
#
# `--size-only` rather than the default timestamp comparison: these files are
# rewritten by a checkout, not by an edit, so mtimes churn while the bytes do
# not, and a default sync re-uploads 250 MB on a fresh clone.
echo "==> syncing $SRC -> s3://$BUCKET/$PREFIX/ ($REGION)"

aws s3 sync "$SRC" "s3://$BUCKET/$PREFIX/" \
  --region "$REGION" \
  --size-only \
  --exclude '*.json' \
  --content-type application/octet-stream \
  --cache-control 'public, max-age=31536000, immutable' \
  $DRY

# The sessions are read with one plain `fetch(...).text()`, so the type is
# cosmetic to the app and useful to anyone who opens one in a browser. Their
# cache lifetime is not cosmetic: a session file is the one thing here that gets
# edited in place, so it is minutes, not a year.
aws s3 sync "$SRC" "s3://$BUCKET/$PREFIX/" \
  --region "$REGION" \
  --size-only \
  --exclude '*' \
  --include '*.json' \
  --content-type application/json \
  --cache-control 'public, max-age=300' \
  $DRY

if [ -n "$DRY" ]; then
  echo "==> dry run; nothing uploaded"
  exit 0
fi

apply_cors

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
#
# docs/hosting.md's three curl calls, run against a real object rather than
# described. The third is the one worth automating: it asks the way a browser
# asks — offering gzip, which `fetch` cannot decline — and a bucket that answers
# with a `Content-Encoding` serves a file this viewer cannot range-read.
URL="https://$BUCKET.s3.$REGION.amazonaws.com/$PREFIX/yeast/Yeast_microC_G2M_1kb.cool"
echo "==> verifying $URL"

headers="$(curl -sSI -H 'Accept-Encoding: gzip, deflate, br' "$URL")"

# The status first, because everything below reads a header out of the response
# and a 403 has none of them. Checked separately so that "the object is not
# public" is reported as itself: uploading does not make an object readable, and
# a bucket that blocks public access answers 403 to exactly this request while
# the sync above reported complete success.
status="$(printf '%s' "$headers" | awk 'toupper($1) ~ /^HTTP/ { code = $2 } END { print code }')"
if [ "$status" != "200" ]; then
  echo "FAIL: the object is not publicly readable — an anonymous HEAD got ${status:-no response}." >&2
  echo "      The upload succeeded; this is the bucket policy, not the files. Allow" >&2
  echo "      s3:GetObject to * on arn:aws:s3:::$BUCKET/$PREFIX/* and make sure the" >&2
  echo "      account-level Block Public Access setting is not overriding it." >&2
  exit 1
fi

if ! grep -qi '^accept-ranges: bytes' <<<"$headers"; then
  echo "FAIL: no 'Accept-Ranges: bytes' — the reader would download whole files" >&2
  exit 1
fi
if grep -qi '^content-encoding:' <<<"$headers"; then
  echo "FAIL: the bucket compressed the response; ranges cannot address it" >&2
  exit 1
fi

ranged="$(curl -sSI -H 'Range: bytes=0-1023' -H 'Origin: https://js2264.github.io' "$URL")"
# `^HTTP/.* 206` rather than the reason phrase: over HTTP/2 curl prints
# `HTTP/2 206` with no `Partial Content` after it, and a check keyed to the
# phrase fails against a bucket that is behaving perfectly.
if ! grep -qiE '^HTTP/[0-9.]+ 206' <<<"$ranged"; then
  echo "FAIL: ranges ignored (expected 206)" >&2
  exit 1
fi
if ! grep -qi '^access-control-expose-headers:.*content-range' <<<"$ranged"; then
  echo "FAIL: Content-Range is not exposed to JavaScript" >&2
  exit 1
fi

# The signed path, asked the way a browser asks it: the `OPTIONS` the browser
# sends before any request carrying `Authorization`. Nothing above touches it —
# every check so far is an unsigned read, which the first CORS rule answers — so
# a policy that lost its second rule passes all of them and takes private
# browsing down anyway. That is exactly the regression this call exists to
# catch, and it needs no credential: a preflight is unauthenticated by
# definition, so this tests the bucket's CORS and nothing about IAM.
preflight="$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS "$URL" \
  -H "Origin: $CHECK_ORIGIN" \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization,x-amz-date,x-amz-content-sha256')"
if [ "$preflight" != "200" ]; then
  echo "FAIL: a signed request would be blocked before it is sent — the preflight for" >&2
  echo "      authorization/x-amz-date/x-amz-content-sha256 from $CHECK_ORIGIN got" >&2
  echo "      $preflight. No CORS rule names those headers for that origin, so private" >&2
  echo "      prefixes cannot be read or browsed; the demos are unaffected. Re-run with" >&2
  echo "      --cors, or see docs/hosting.md#private-files." >&2
  exit 1
fi

echo "==> ok: ranged, uncompressed, readable cross-origin, and signed requests preflight"
