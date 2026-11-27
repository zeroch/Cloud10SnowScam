import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class PromotionTests(unittest.TestCase):
    def test_ambiguous_upload_response_checks_traffic_before_reporting_success(self):
        script = Path(__file__).resolve().parents[1] / 'promote.sh'
        for active, succeeds in [('requested', True), ('previous', False)]:
            with self.subTest(active=active), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                deploy = root / 'deploy/cloudflare-production'
                bin_dir = deploy / 'node_modules/.bin'
                bin_dir.mkdir(parents=True)
                (deploy / 'wrangler.jsonc').write_text('{"name":"cloud10-forecast","observability":{"enabled":true}}')
                cli = bin_dir / 'wrangler'
                cli.write_text("""#!/bin/sh
case "$1 $2" in
  'versions deploy') exit 1 ;;
  'deployments status') printf '{"versions":[{"version_id":"%s","percentage":100}]}' "$ACTIVE" ;;
  *) exit 2 ;;
esac
""")
                cli.chmod(0o755)
                result = subprocess.run(
                    ['bash', str(script)], cwd=root, capture_output=True, text=True,
                    env=dict(os.environ, ACTIVE=active, VERSION_ID='requested', RELEASE_SHA='a' * 40,
                             GITHUB_STEP_SUMMARY=str(root / 'summary'), RUNNER_TEMP=str(root)))
                self.assertEqual(result.returncode == 0, succeeds, result.stderr)
                self.assertIn(active, (root / 'summary').read_text())
