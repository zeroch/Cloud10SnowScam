# Cloud10 on Cloudflare Workers

The production Worker serves the four dashboards, reads weather snapshots from D1 and refreshes them on a cron schedule. A separate static Worker supplies the browser assets through the `ASSETS` binding. The Node server can export those assets from a clean checkout using an empty weather loader.

## Build

Run the following from the repository root with Node.js 22.13 or newer and the esbuild CLI on your path.

```sh
node deploy/cloudflare-production/build-assets.mjs . dist/cloudflare-production
esbuild deploy/cloudflare-production/index.mjs --bundle --format=esm --target=es2022 --platform=neutral --minify --alias:cloud10-release="$PWD" --outfile=dist/cloudflare-production/production.mjs
```

The output directory contains `production.mjs`, the `assets/` directory and `manifest.json`. The manifest lists each route, exported file, byte size and SHA-256 digest. Both commands use the current checkout so the Worker and browser apply the same forecast calculations.

## Configure a deployment

1. Create a D1 database and apply `deploy/cloudflare-pilot/schema.sql`, followed by `deploy/cloudflare-production/schema.sql`. Production uses the shared snapshot tables and maintains its own collection history.
2. Upload `dist/cloudflare-production/assets/` as the static Worker (the example service name is `cloud10-forecast-assets`).
3. Copy `deploy/cloudflare-production/wrangler.example.jsonc` to `deploy/cloudflare-production/wrangler.jsonc`. Set your D1 name and ID, static service name and runtime Worker name. Configure the hostname in your own Cloudflare account.
4. Deploy the application with `wrangler deploy --config deploy/cloudflare-production/wrangler.jsonc`. The production trigger staggers resort requests across the hour. A new database can use production directly. An existing 24-hour pilot hands forecast collection to production after its 48 half-hour slots.

The optional pilot has its own [configuration example](../../deploy/cloudflare-pilot/wrangler.example.jsonc). Its date-specific trigger and the `pilot_window` table bound the original measurement run. Use a separate database for an independent pilot.

## Verify

Run the collector handoff and routing checks locally against an in-memory database and synthetic upstream responses.

```sh
esbuild deploy/cloudflare-production/worker.mjs --bundle --format=esm --target=es2022 --platform=neutral --alias:cloud10-release="$PWD" --outfile=dist/cloudflare-production/handoff.mjs
node deploy/cloudflare-production/check-handoff.mjs dist/cloudflare-production/handoff.mjs
```

After the live collector has populated all four resorts, the verification script checks the deployed responses against the exported manifest and reads the health, resort and dashboard endpoints. Pass the deployment URL as the first argument.

```sh
python3 deploy/cloudflare-production/verify-live.py "$FORECAST_URL" dist/cloudflare-production/manifest.json dist/cloudflare-production/verification.json
```
