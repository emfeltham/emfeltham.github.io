#!/usr/bin/env bash
# Upload one gated item (paper PDF or talk recording) to the private R2 bucket.
#
#   bin/upload-media.sh "papers/Some Paper.pdf" feltham-2026-short-slug
#   bin/upload-media.sh "~/talks/seminar.mp4"   feltham-sfi-2026-cognitive-representations
#
# The slug must match a CATALOG key in worker/src/index.js, and the object is
# stored as <slug>.<ext> with a content type inferred from the extension. The
# bucket stays private; the Worker reads it via its binding, so nothing here
# creates a public URL.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
fi

file=$1
slug=$2
bucket=working-papers

[[ -f $file ]] || { echo "error: no such file: $file" >&2; exit 66; }
[[ $slug =~ ^[a-z0-9-]+$ ]] || { echo "error: slug must match [a-z0-9-]+ : $slug" >&2; exit 65; }

ext=${file##*.}
ext=$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')
case $ext in
  pdf)  ctype=application/pdf ;;
  mp4|m4v) ctype=video/mp4 ;;
  webm) ctype=video/webm ;;
  mov)  ctype=video/quicktime ;;
  m4a)  ctype=audio/mp4 ;;
  mp3)  ctype=audio/mpeg ;;
  *) echo "error: unsupported extension '.$ext' — add it to $0" >&2; exit 65 ;;
esac

if ! grep -q "'$slug'" worker/src/index.js; then
  echo "warning: '$slug' is not in the CATALOG in worker/src/index.js." >&2
  echo "         The Worker will 404 this item until you add it." >&2
fi

if ! grep -q "key: '$slug.$ext'" worker/src/index.js; then
  echo "warning: CATALOG has no \"key: '$slug.$ext'\" — check the extension matches." >&2
fi

bytes=$(wc -c < "$file" | tr -d ' ')
echo "Uploading $file ($bytes bytes, $ctype) -> r2://$bucket/$slug.$ext"
npx wrangler r2 object put "$bucket/$slug.$ext" \
  --file "$file" \
  --content-type "$ctype" \
  --remote
echo "Done. Verify size with: npx wrangler r2 object get $bucket/$slug.$ext --remote --pipe | wc -c"
