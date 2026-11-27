import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class UploadedVersionTests(unittest.TestCase):
    def test_staging_upload_exposes_the_bookmark_alongside_the_immutable_rollout_url(self):
        version = '12345678-aabb-4ccd-8eef-123456789abc'
        url = 'https://12345678-cloud10-forecast.example.workers.dev'
        staging = 'https://staging-cloud10-forecast.example.workers.dev'
        for publish, alias, accepted in [
            (True, staging, True), (True, None, False), (True, url, False),
            (True, 'https://staging-cloud10-forecast.other.workers.dev', False),
            (False, None, True),
        ]:
            with self.subTest(publish=publish, alias=alias), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                (root / 'upload').write_text(json.dumps(dict(type='version-upload', worker_name='cloud10-forecast',
                    version_id=version, preview_url=url, preview_alias_url=alias)))
                result = subprocess.run(
                    [sys.executable, str(Path(__file__).resolve().parents[1] / 'uploaded-version.py'),
                     str(root / 'upload')], capture_output=True,
                    env=dict(os.environ, GITHUB_OUTPUT=str(root / 'output'), GITHUB_STEP_SUMMARY=str(root / 'summary'),
                             RELEASE_SHA='a' * 40, PUBLISH_STAGING=str(publish).lower()))
                self.assertEqual(result.returncode == 0, accepted, result.stderr)
                if accepted:
                    outputs = dict(line.split('=', 1) for line in (root / 'output').read_text().splitlines())
                    self.assertEqual(outputs['url'], url)
                    self.assertEqual(outputs.get('staging_url'), staging if publish else None)
                else:
                    self.assertFalse((root / 'output').exists())

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
