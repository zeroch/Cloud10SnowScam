# Release Cloud10 to Cloudflare

Open a pull request against `main`. The **Cloud10 CI** check runs the Node tests, release selection tests, collector handoff checks and Wrangler checks. The branch rules require an up-to-date check and one approving review from someone with write access. Pushing new reviewable changes dismisses the approval. Each successful push build on `main` captures the Worker and browser files together for 90 days.

## Choose a release

1. In GitHub, open **Actions → Release to Cloudflare → Run workflow**. Use the `main` branch. Enter a merged PR number such as `#42`, a release tag, or a full 40-character commit SHA.
2. Open the run. **Resolve reviewed main build** shows the exact commit and links to its CI run. The commit must be on the first-parent history of `main` and have a retained, successful push build. The job awaiting deployment approval displays that same SHA.
3. Select **Review deployments → production → Approve and deploy**. The workflow checks the archive digest, uploads the version, and reads its immutable Cloudflare Version URL. It checks every exported response against its manifest and verifies the build SHA, D1 health and all four resort dashboards before switching traffic.
4. The run summary records the Git SHA and Cloudflare version ID. The final step checks the public hostname. If a check fails, the failed step shows whether traffic switched. Only one production deployment runs at a time.

To roll back, run the same workflow with the earlier PR, tag or SHA while its CI artifact is retained. For an expired artifact or an emergency, use the previously recorded version ID in **Cloudflare → Workers & Pages → cloud10-forecast → Deployments** and select its rollback action. A Worker rollback reuses the current D1 data. Keep any service used by an older version available for as long as you need to roll back to it.

## Repository and Worker setup

The repository has an active branch ruleset for `main`. The importable settings are in [main.json](../../.github/rulesets/main.json). The required check is **Cloud10 CI** from the GitHub Actions app and the bypass list is empty.

Configure the GitHub environment **production** for branch `main` only. Set the owner as required reviewer, allow the owner to approve a deployment they dispatch and disable administrator bypass. These credentials belong in that environment.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare account token with **Individual Workers → Editor** scoped to `cloud10-forecast`. Rotate it in Cloudflare and GitHub before expiry. |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Production Cloudflare account ID |
| Variable | `CLOUDFLARE_D1_DATABASE_ID` | ID of the existing forecast D1 database bound as `DB` |

Enable **Version URLs** in the Worker's **Settings → Domains & Routes**. An uploaded version uses its own static assets and the existing D1 binding. The release workflow uses the existing hostname and cron and performs no database migrations. Its live probes use read-only application endpoints.

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
