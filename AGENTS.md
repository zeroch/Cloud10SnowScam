# Cloud10 agent instructions

## Opening a pull request

1. Start from the current `main` and push changes to a same-repository `codex/<topic>` branch. Give the commit that first goes up a clear subject and a body explaining the change and its verification. The workflow uses them as the initial PR title and description.
2. Let **Open AI pull request** open the PR into `main` as `github-actions[bot]` and request `@zeroch`. For a branch that predates the workflow, run it from **Actions → Open AI pull request → Run workflow**, select `main`, and enter the full `codex/...` branch name.
3. Verify the author and reviewer on GitHub. Push follow-up commits to the open PR's head branch. Agent sessions must leave code approval and merge to `@zeroch`. Using `zeroch` to push Git commits is fine. Opening the PR under that account prevents its owner from approving it.
4. GitHub may show **Approve workflows to run** on a bot-created PR. This starts CI. The separate **Files changed → Review changes → Approve** action supplies the code review. Merging requires an up-to-date branch, passing **Cloud10 CI**, and one approving review.

For an open PR already authored by `zeroch`, create a new `codex/` branch pointing to the exact head commit. Have the bot open its replacement and request `@zeroch`. Preserve the original PR's title, description and issue links. Verify the base, head SHA and changed files before closing the original. Keep the original branch and use the replacement head for subsequent commits.

[Project memory](MEMORY.md) · [Cloudflare release procedure](docs/deployment/cloudflare-production.md)
