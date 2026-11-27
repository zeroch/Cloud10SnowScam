# Cloud10 project memory

## AI-authored changes and human review

On November 26, 2026, the repository owner chose `github-actions[bot]` to open PRs for AI changes and `@zeroch` to review them. This lets the sole contributor approve changes even when Git pushes authenticate as `zeroch`. The PR author is the account that opens it.

The repository enables **Allow GitHub Actions to create and approve pull requests** with read-only default workflow permissions. The PR-opening job grants `contents: read` and `pull-requests: write` and requests the human reviewer. The main ruleset requires one approving review and a passing **Cloud10 CI** check. After merge, a successful main build stages on the Worker's Version URL and starts the automatic 30-minute rollout.

[Agent procedure](AGENTS.md) · [PR-opening workflow](.github/workflows/open-ai-pr.yml) · [Main ruleset](.github/rulesets/main.json)
