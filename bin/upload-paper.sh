#!/usr/bin/env bash
# Upload one working paper to the private R2 bucket.
#
#   bin/upload-paper.sh "papers/Some Paper.pdf" feltham-2025-short-slug
#
# The slug must match a CATALOG key in worker/src/index.js, and the object is
# stored as <slug>.pdf. The bucket stays private; the Worker reads it via its
# binding, so nothing here creates a public URL.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
fi

file=$1
slug=$2
bucket=working-papers

[[ -f $file ]] || { echo "error: no such file: $file" >&2; exit 66; }
[[ $slug =~ ^[a-z0-9-]+$ ]] || { echo "error: slug must match [a-z0-9-]+ : $slug" >&2; exit 65; }

if ! grep -q "'$slug'" worker/src/index.js; then
  echo "warning: '$slug' is not in the CATALOG in worker/src/index.js." >&2
  echo "         The Worker will 404 this paper until you add it." >&2
fi

echo "Uploading $file -> r2://$bucket/$slug.pdf"
npx wrangler r2 object put "$bucket/$slug.pdf" \
  --file "$file" \
  --content-type application/pdf \
  --remote
