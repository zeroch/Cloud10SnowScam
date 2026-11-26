import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class UploadedVersionTests(unittest.TestCase):
    def test_only_the_uploads_immutable_forecast_url_can_be_promoted(self):
        version = '12345678-aabb-4ccd-8eef-123456789abc'
        host = '12345678-cloud10-forecast.example.workers.dev'
        for url, accepted in [
            ('https://' + host, True), (None, False),
            ('https://cloud10-forecast.example.workers.dev', False),
            ('https://87654321-cloud10-forecast.example.workers.dev', False),
            ('https://' + host + '.example.org', False),
        ]:
            with self.subTest(url=url), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                record = dict(type='version-upload', worker_name='cloud10-forecast',
                              version_id=version, preview_url=url)
                (root / 'upload').write_text(json.dumps(record) + '\n')
                result = subprocess.run(
                    [sys.executable, str(Path(__file__).resolve().parents[1] / 'uploaded-version.py'),
                     str(root / 'upload')], capture_output=True,
                    env=dict(os.environ, GITHUB_OUTPUT=str(root / 'output'),
                             GITHUB_STEP_SUMMARY=str(root / 'summary'), RELEASE_SHA='a' * 40))
                self.assertEqual(result.returncode == 0, accepted, result.stderr)
                if accepted:
                    self.assertEqual((root / 'output').read_text(), f'id={version}\nurl={url}\n')
                else:
                    self.assertFalse((root / 'output').exists())
