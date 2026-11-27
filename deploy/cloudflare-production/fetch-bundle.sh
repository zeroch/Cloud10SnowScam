#!/usr/bin/env bash
set -euo pipefail

archive="$RUNNER_TEMP/cloud10.zip"
curl --fail --silent --show-error --location --retry 3 \
  -H "Authorization: Bearer $GH_TOKEN" \
  "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/artifacts/$ARTIFACT_ID/zip" --output "$archive"
printf '%s  %s\n' "$DIGEST" "$archive" | sha256sum --check --strict
mkdir -p dist/cloudflare-production
unzip -q "$archive" -d dist/cloudflare-production
