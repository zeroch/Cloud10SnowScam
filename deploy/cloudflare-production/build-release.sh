#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
deploy=deploy/cloudflare-production
bin="$deploy/node_modules/.bin"
config="$deploy/wrangler.example.jsonc"
out=dist/cloudflare-production
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export WRANGLER_SEND_METRICS=false

# Build into an empty directory so removed assets cannot leak into a rebuild.
node "$deploy/build-assets.mjs" . "$scratch/bundle"
flags=(--bundle --platform=neutral --target=es2022 --format=esm "--alias:cloud10-release=$PWD")
"$bin/esbuild" "$deploy/index.mjs" "${flags[@]}" --minify --outfile="$scratch/bundle/production.mjs"
"$bin/esbuild" "$deploy/worker.mjs" "${flags[@]}" --outfile="$scratch/handoff.mjs"
node "$deploy/check-handoff.mjs" "$scratch/handoff.mjs"
mkdir -p dist
rm -rf "$out"
mv "$scratch/bundle" "$out"
# Keep the versioned runtime compatibility settings with the tested bundle.
node -e 'const fs = require("node:fs"); const c = JSON.parse(fs.readFileSync(process.argv[1])); console.log(JSON.stringify({compatibility_date:c.compatibility_date, compatibility_flags:c.compatibility_flags || []}));' "$config" > "$out/runtime.json"

"$bin/wrangler" versions upload --dry-run --no-bundle --config "$config" --outdir "$scratch/dry-run"
for schema in deploy/cloudflare-pilot/schema.sql "$deploy/schema.sql"; do
  "$bin/wrangler" d1 execute DB --local --config "$config" --persist-to "$scratch/d1" --file "$schema" >/dev/null
done
node "$deploy/check-assets.mjs" "$scratch/d1"
