# Release Cloud10 to Cloudflare

Open a pull request against `main`. The **Cloud10 CI** check runs the Node tests, release selection tests, collector handoff checks and Wrangler checks. You can merge your own PR when the branch is up to date and that check passes. Reviewer approval is optional. Each successful push build on `main` captures the Worker and browser files together for 90 days.

## Preview and automatic rollout

After push CI passes on `main`, open **Actions → Release to Cloudflare → Stage and verify**. The job publishes a version of `cloud10-forecast` at 0% production traffic. Its summary links to the exact build and the Chinese Crystal Mountain page. The preview reads the live forecast database. The ordinary Worker URL and `forecast.cloud10snow.com` serve the production deployment.

GitHub checks the archive digest, every exported response, the Git SHA, D1 health and all four resort dashboards on the Version URL. A passing preview starts the rollout automatically. The percentages are shares of requests.

| Time after the first traffic switch | New version | Previous production |
| --- | --- | --- |
| Start | 10% | 90% |
| After 15 healthy minutes | 50% | 50% |
| After another 15 healthy minutes | 100% | 0% |

During each hold the job probes the exact candidate and the public health endpoint about once a minute. At 100% it verifies the public site against the same manifest. A failed check after traffic moves restores the recorded previous production version. Allow for runner startup, retries and Cloudflare propagation.

GitHub serializes production changes. An automatic build superseded on `main` before its turn is skipped. A new merge during an active rollout can stage while the active rollout finishes. To choose a particular retained build yourself, use **Release to Cloudflare → Run workflow** on `main` with a merged PR number such as `#42`, a release tag, or a full main commit SHA. This uses the same checks and rollout schedule.

## Stop or roll back

1. Open **Actions → Roll back production → Run workflow** and choose `main`.
2. Leave the input blank to reverse the managed release currently serving traffic. To stop a specific build, including one still staging, enter its numeric **release run ID** from the staging summary or the release run URL.
3. The workflow stops that run, checks which release owns the live traffic, and restores its actual predecessor at 100%. A stale or repeated rollback request skips the traffic change. D1 keeps its current forecast data.

The baseline version ID is recorded in Cloudflare's deployment message at the first split. If a runner is lost, use the same rollback workflow. For a deployment predating this automation or if GitHub is unavailable, open **Cloudflare → Workers & Pages → cloud10-forecast → Deployments**, select the previous stable version and choose **Rollback**. A running rollout stops when it detects a different deployment. [Cloudflare rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

## Repository and Worker setup

The repository has an active branch ruleset for `main`. The importable settings are in [main.json](../../.github/rulesets/main.json). The required check is **Cloud10 CI** from the GitHub Actions app and the bypass list is empty.

Configure the GitHub environment **production** for the selected branch `main` only. Disable **Required reviewers** and the **Wait timer** so passing main builds can roll out automatically and emergency rollbacks can start immediately. Keep administrator bypass disabled. The Cloudflare credentials belong in this environment.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare account token with **Individual Workers → Editor** scoped to `cloud10-forecast`. Rotate it in Cloudflare and GitHub before expiry. |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Production Cloudflare account ID |
| Variable | `CLOUDFLARE_D1_DATABASE_ID` | ID of the existing forecast D1 database bound as `DB` |

In the Worker’s **Settings → Domains & Routes**, enable **Version URLs**. An uploaded version uses its own static assets and the existing D1 binding. The release workflow uses the existing hostname and cron. Its live probes use read-only application endpoints. [Cloudflare Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)

For a new installation, provision the Worker, D1, hostname and trigger once. Apply [the shared schema](../../deploy/cloudflare-pilot/schema.sql) followed by [the production schema](../../deploy/cloudflare-production/schema.sql). The example config includes the collector schedule. The separate [pilot configuration](../../deploy/cloudflare-pilot/wrangler.example.jsonc) describes the optional 24-hour measurement window.

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
