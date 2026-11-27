#!/usr/bin/env bash
set -euo pipefail

deploy=deploy/cloudflare-production
wrangler="$deploy/node_modules/.bin/wrangler"
config="$RUNNER_TEMP/promotion.json"
# Traffic promotion needs the Worker name alone. Leave its non-versioned settings in place.
jq '{name}' "$deploy/wrangler.jsonc" > "$config"

record_traffic() {
  "$wrangler" deployments status --json --config "$config" > "$RUNNER_TEMP/traffic.json"
  jq -er --arg label "$1" '"**" + $label + "** " + (.versions | map("`" + .version_id + "` (" + (.percentage | tostring) + "%)") | join(", "))' \
    "$RUNNER_TEMP/traffic.json" >> "$GITHUB_STEP_SUMMARY"
}

record_traffic 'Traffic before promotion'
if ! "$wrangler" versions deploy "$VERSION_ID@100%" --yes --config "$config" --message "Git $RELEASE_SHA"; then
  echo 'Promotion returned an error. Checking the active deployment before reporting its outcome.' >&2
fi
record_traffic 'Traffic after promotion'
jq -e --arg id "$VERSION_ID" 'any(.versions[]; .version_id == $id and .percentage == 100)' \
  "$RUNNER_TEMP/traffic.json" > /dev/null
printf 'Promoted Git `%s` as Cloudflare version `%s` to 100%% of production traffic.\n' "$RELEASE_SHA" "$VERSION_ID" >> "$GITHUB_STEP_SUMMARY"
