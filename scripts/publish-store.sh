#!/usr/bin/env bash
#
# Make the lab's store on the bucket what `demo/store/MANIFEST.tsv` says it is.
#
# The store (`demosStore()` in `src/ui/examples.ts`, SPECS §24.3) is one folder,
# `s3://rsglab-data/demo/store/`, a directory a card or a dataset. Most of what
# is in it is too large for git — 4DN's mouse map is 7 GB — so the repository
# holds its workspaces and the manifest, one line a file:
#
#   <path under demo/store/> <TAB> <source> <TAB> <what it is>
#
# and a source is one of three things:
#
#   s3://bucket/key   copied on the bucket's side, from the lab's own bucket or
#                     from 4DN's open-data one: nothing passes through here
#   repo:<path>       a file of this repository, uploaded
#   work:<name>       a file `scripts/make_rsg_store.py derive` wrote, uploaded
#                     from the directory given as --work
#
#   python3 scripts/make_rsg_store.py derive --work ~/rsg-store   # once: the derived files
#   ./scripts/publish-store.sh --work ~/rsg-store --dry-run       # what would be copied
#   ./scripts/publish-store.sh --work ~/rsg-store                 # copy, upload, verify
#
# A file already on the bucket at the size its source has is left alone, so a
# second run copies nothing. **Nothing is deleted or moved**: the files the
# folder held at its root before it was tidied into directories are still there
# afterwards, and removing them is a separate decision (`aws s3 rm`).
#
# The bucket's CORS policy is `publish-demo.sh --cors`'s, since a policy is
# bucket-wide and this folder is under the prefix it was written for.
#
# Needs the AWS CLI and credentials with `s3:PutObject` on the bucket and read
# access to the sources — the CLI's usual chain, as for publish-demo.sh. Written
# for the bash 3.2 a Mac still ships: no associative arrays, no `mapfile`.

set -euo pipefail

BUCKET="${DEMO_BUCKET:-rsglab-data}"
PREFIX="${DEMO_PREFIX:-demo}/store"
REGION="${DEMO_REGION:-eu-west-3}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/demo/store/MANIFEST.tsv"

WORK=''
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --work) WORK="${2:?--work needs a directory}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null || { echo "the AWS CLI is not on PATH; see https://aws.amazon.com/cli/" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "no manifest at $MANIFEST" >&2; exit 1; }

# Who the CLI is, before anything is asked of S3. Every read below is signed, dry run included,
# so a CLI with no working credentials fails each one the same way — and the size check that asks
# first, which has to stay quiet about an object that is simply not there yet, could only call it
# "cannot read". This needs no permission at all, so its only failures are the credentials'.
if ! IDENTITY="$(aws sts get-caller-identity --region "$REGION" --query Arn --output text 2>&1 </dev/null)"; then
  echo "the AWS CLI has no working credentials:" >&2
  printf '%s\n' "$IDENTITY" | sed 's/^/    /' >&2
  echo "set them up (aws configure, aws sso login, or AWS_PROFILE=<a profile>) and run this again" >&2
  exit 1
fi

# The region a source bucket answers in. A copy names it (`--source-region`)
# because the two buckets are on different continents and S3 will not guess.
region_of() {
  case "$1" in
    4dn-open-data-public) echo us-east-1 ;;
    *) echo "$REGION" ;;
  esac
}

# The size of an object, or nothing when there is no such object (or no right to see it).
size_on_s3() {
  aws s3api head-object --region "$1" --bucket "$2" --key "$3" \
    --query ContentLength --output text 2>/dev/null </dev/null || true
}

# Why a source could not be sized: S3's answer in the CLI's own words, which `size_on_s3` hides
# because a destination not there yet is the common case. And where the object answers an unsigned
# request it is public, so the refusal is about these credentials rather than about the file: a
# server-side copy reads its source as the caller, who needs s3:GetObject on it — on 4DN's bucket
# too, which is in another account.
unreadable() {
  echo "FAIL: cannot read $1 as $IDENTITY" >&2
  # `|| true`: under pipefail the CLI's own failure, the point of the call, would end the script here.
  aws s3api head-object --region "$2" --bucket "$3" --key "$4" 2>&1 >/dev/null </dev/null | sed 's/^/    /' >&2 || true
  if aws s3api head-object --no-sign-request --region "$2" --bucket "$3" --key "$4" >/dev/null 2>&1 </dev/null; then
    echo "    the object is public (an unsigned request reads it), so these credentials are what S3 refuses:" >&2
    echo "    they need s3:GetObject on s3://$3/*" >&2
  fi
}

# Every data file is `application/octet-stream`, uncompressed and cached for a
# year, for publish-demo.sh's reasons (S3 does not compress that type, and a
# compressed body cannot be range-read); a workspace is JSON and minutes, since
# it is the one thing here edited in place.
type_of() {
  case "$1" in
    *.json) echo application/json ;;
    *) echo application/octet-stream ;;
  esac
}
cache_of() {
  case "$1" in
    *.json) echo 'public, max-age=300' ;;
    *) echo 'public, max-age=31536000, immutable' ;;
  esac
}

# Read the manifest once, failing before anything is copied if a local source is missing.
LINES="$(grep -v '^#' "$MANIFEST" | tail -n +2)"
missing=0
while IFS="$(printf '\t')" read -r path source _; do
  [ -n "$path" ] || continue
  case "$source" in
    repo:*) [ -f "$ROOT/${source#repo:}" ] || { echo "missing: $path comes from ${source#repo:}, which is not here" >&2; missing=1; } ;;
    work:*)
      if [ -z "$WORK" ]; then
        echo "missing: $path is derived; give the directory make_rsg_store.py derive wrote with --work" >&2; missing=1
      elif [ ! -f "$WORK/${source#work:}" ]; then
        echo "missing: $path — no ${source#work:} in $WORK; run make_rsg_store.py derive --work $WORK" >&2; missing=1
      fi ;;
    s3://*) ;;
    *) echo "unreadable source for $path: $source" >&2; missing=1 ;;
  esac
done <<EOF
$LINES
EOF
[ "$missing" = 0 ] || exit 1

echo "==> s3://$BUCKET/$PREFIX/ from $MANIFEST, as $IDENTITY"
EXPECTED="$(mktemp)"
trap 'rm -f "$EXPECTED"' EXIT
copied=0; current=0
while IFS="$(printf '\t')" read -r path source _; do
  [ -n "$path" ] || continue
  key="$PREFIX/$path"
  case "$source" in
    s3://*)
      from="${source#s3://}"; from_bucket="${from%%/*}"; from_key="${from#*/}"
      want="$(size_on_s3 "$(region_of "$from_bucket")" "$from_bucket" "$from_key")"
      [ -n "$want" ] && [ "$want" != None ] ||
        { unreadable "$source" "$(region_of "$from_bucket")" "$from_bucket" "$from_key"; exit 1; } ;;
    repo:*) local_file="$ROOT/${source#repo:}"; want="$(wc -c < "$local_file" | tr -d ' ')" ;;
    work:*) local_file="$WORK/${source#work:}"; want="$(wc -c < "$local_file" | tr -d ' ')" ;;
  esac
  printf '%s\t%s\n' "$path" "$want" >> "$EXPECTED"
  have="$(size_on_s3 "$REGION" "$BUCKET" "$key")"
  if [ "$have" = "$want" ]; then
    current=$((current + 1))
    continue
  fi
  copied=$((copied + 1))
  if [ "$DRY" = 1 ]; then
    echo "    would put $path ($want bytes) from $source"
    continue
  fi
  echo "    $path ($want bytes) from $source"
  case "$source" in
    s3://*)
      # A server-side copy; over 5 GB the CLI turns it into a multipart one.
      aws s3 cp "$source" "s3://$BUCKET/$key" --only-show-errors \
        --source-region "$(region_of "$from_bucket")" --region "$REGION" \
        --metadata-directive REPLACE \
        --content-type "$(type_of "$path")" --cache-control "$(cache_of "$path")" </dev/null ;;
    *)
      aws s3 cp "$local_file" "s3://$BUCKET/$key" --only-show-errors --region "$REGION" \
        --content-type "$(type_of "$path")" --cache-control "$(cache_of "$path")" </dev/null ;;
  esac
done <<EOF
$LINES
EOF
echo "==> $copied to put, $current already there"

if [ "$DRY" = 1 ]; then
  echo "==> dry run; nothing copied"
  exit 0
fi

# The manifest goes up too, so the folder says where each of its files came from.
aws s3 cp "$MANIFEST" "s3://$BUCKET/$PREFIX/MANIFEST.tsv" --only-show-errors --region "$REGION" \
  --content-type 'text/tab-separated-values; charset=utf-8' --cache-control 'public, max-age=300'

# ---------------------------------------------------------------------------
# Verify, anonymously: every file answers a plain HEAD at the size it should
# have, uncompressed, and a map answers a ranged read the way a browser asks.
# ---------------------------------------------------------------------------
BASE="https://$BUCKET.s3.$REGION.amazonaws.com/$PREFIX"
echo "==> verifying $BASE/"
bad=0
while IFS="$(printf '\t')" read -r path want; do
  headers="$(curl -sSI -H 'Accept-Encoding: gzip, deflate, br' "$BASE/$path" </dev/null | tr -d '\r')"
  status="$(printf '%s\n' "$headers" | awk 'toupper($1) ~ /^HTTP/ { code = $2 } END { print code }')"
  size="$(printf '%s\n' "$headers" | awk 'tolower($1) == "content-length:" { print $2 }' | tail -n 1)"
  if [ "$status" != 200 ]; then
    echo "FAIL: $path answers ${status:-nothing} to an anonymous HEAD" >&2; bad=1
  elif [ "$size" != "$want" ]; then
    echo "FAIL: $path is $size bytes on the bucket, $want at its source" >&2; bad=1
  elif printf '%s\n' "$headers" | grep -qi '^content-encoding:'; then
    echo "FAIL: $path is served compressed; ranges cannot address it" >&2; bad=1
  fi
done < "$EXPECTED"

ranged="$(curl -sSI -H 'Range: bytes=0-1023' -H 'Origin: https://js2264.github.io' \
  "$BASE/yeast/GSE151553_A364_merged.mcool")"
if ! grep -qiE '^HTTP/[0-9.]+ 206' <<<"$ranged"; then
  echo "FAIL: ranges ignored on the micro-C map (expected 206)" >&2; bad=1
fi
if ! grep -qi '^access-control-expose-headers:.*content-range' <<<"$ranged"; then
  echo "FAIL: Content-Range is not exposed to JavaScript; run publish-demo.sh --cors" >&2; bad=1
fi
[ "$bad" = 0 ] || exit 1
echo "==> ok: $(wc -l < "$EXPECTED" | tr -d ' ') files, each readable anonymously at its size, ranged and uncompressed"
