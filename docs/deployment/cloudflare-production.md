# Release Cloud10 to Cloudflare

For AI changes, push a `codex/` branch. The Actions bot opens a PR against `main` and requests `@zeroch` for review. Merge requires one approving review, an up-to-date branch and passing **Cloud10 CI**. The check runs the Node tests, release selection tests, collector handoff checks and Wrangler checks. Each successful push build on `main` captures the Worker and browser files together for 90 days. [Agent procedure](../../AGENTS.md)

## Preview each merged PR

After a PR merges, successful push CI on `main` triggers **Stage Cloudflare preview**. GitHub uploads the tested Worker version at 0% production traffic and publishes a Version URL for that exact commit. The staging bookmark follows the latest successful `main` build. Both previews read the live forecast database. [Staging forecast](https://staging-cloud10-forecast.chenze62.workers.dev/)

Open the **Stage and verify** job summary for the Git SHA, Worker version ID, exact preview link and Chinese Crystal Mountain page. The job checks the build archive, manifest routes, release SHA, D1 health and four resort dashboards. Uploads run one at a time so a delayed older build gets its own preview and preserves the newer bookmark.

To stage a retained build again, select **Actions → Stage Cloudflare preview → Run workflow** on `main`. Enter its merged PR number (for example `#42`), release tag, or full main commit SHA.

## Switch production traffic manually

1. Open the exact Version URL from the successful staging job for the build you want. Copy its Worker version ID. The staging bookmark may already point to a newer merge.
2. In **Cloudflare → Workers & Pages → cloud10-forecast → Deployments**, record the version and percentage under **Active deployment**. Find the staged version by its ID and Git commit message. Open its **More options → Split versions** control to choose the share of production requests it should receive.
3. Review the version IDs and percentages, then confirm the deployment in Cloudflare. Set the staged version to **100%** for a full switch, or apply a smaller share to try it with live traffic. Each increase requires another manual deployment.
4. Check **Active deployment** for the applied percentages. At 100%, the public health endpoint should return the selected Git SHA in `release` and four current forecasts. [Public health](https://forecast.cloud10snow.com/api/health) · [Cloudflare traffic splits](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)

## Restore the previous version

In **Deployments**, find the previously serving version you recorded. Choose **More options → Rollback**, confirm, and check that **Active deployment** shows it at 100%. To restore a previous split, choose **Split versions** and reapply its recorded percentages. D1 keeps its current forecast data. [Cloudflare rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

The GitHub **Roll back production** workflow can restore a deployment created by the former automated rollout while that deployment still owns traffic. For releases switched in the dashboard, use the Cloudflare controls above.

## Repository and Worker setup

The repository has an active branch ruleset for `main`. The importable settings are in [main.json](../../.github/rulesets/main.json). The required check is **Cloud10 CI** from the GitHub Actions app and the bypass list is empty.

The GitHub environment **production** holds the Worker credentials and restricts jobs to `main`. Staging uses this environment to upload a preview. Environment approval and wait timers are disabled so every successful merge can stage. Production traffic is controlled in the Cloudflare dashboard.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare account token with **Individual Workers → Editor** scoped to `cloud10-forecast`. Rotate it in Cloudflare and GitHub before expiry. |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Production Cloudflare account ID |
| Variable | `CLOUDFLARE_D1_DATABASE_ID` | ID of the existing forecast D1 database bound as `DB` |

In the Worker’s **Settings → Domains & Routes**, enable **Version URLs**. An uploaded version uses its own static assets and the existing D1 binding. The release workflow uses the existing hostname and cron. Its live probes use read-only application endpoints. [Cloudflare Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)

For a new installation, provision the Worker, D1, hostname and trigger once. Apply [the shared schema](../../deploy/cloudflare-pilot/schema.sql) followed by [the production schema](../../deploy/cloudflare-production/schema.sql). The example config includes the collector schedule. The separate [pilot configuration](../../deploy/cloudflare-pilot/wrangler.example.jsonc) describes the optional 24-hour measurement window.

The production Worker records a D1 heartbeat on the hour. It collects upstream data from minute 22 through minute 34 at 00, 06, 12 and 18 UTC. The Worker enforces these windows for existing installations with more frequent triggers, so the six-hour cadence takes effect with the Worker release.

## Verify locally

Use Node.js 22.23.3, Python 3 and the pinned tools in the deployment package. From the repository root run

```sh
npm ci --prefix deploy/cloudflare-production
npm test
python3 -m unittest discover -s deploy/cloudflare-production/tests
bash deploy/cloudflare-production/build-release.sh
```

The script builds `dist/cloudflare-production/`, checks the collector handoff using synthetic upstream responses, runs a Wrangler dry run and serves every manifest entry from a local Worker with a temporary D1 database. To verify an already populated deployment against the same bundle, supply its URL and expected SHA.

```sh
python3 deploy/cloudflare-production/verify-live.py "$FORECAST_URL" \
  dist/cloudflare-production/manifest.json dist/cloudflare-verification.json "$RELEASE_SHA"
```
