import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import live_checks


ORIGIN = "https://forecast.example"
HTML = (b'<!DOCTYPE html><html><body data-resort="crystal"><main>Forecast</main>'
        b'<script type="module" src="/app.mjs"></script>\n</body></html>')
DETECTION = b"<script>load('/cdn-cgi/challenge-platform/scripts/jsd/main.js')</script>"
ANALYTICS = b'<script defer src="https://static.cloudflareinsights.com/beacon.min.js/v123"></script>'


class LiveChecksTests(unittest.TestCase):
    def setUp(self):
        self.assets = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.entry = {"route": "/location/crystal/snow-summary", "asset": "detail.body",
                      "sha256": hashlib.sha256(HTML).hexdigest()}
        (self.assets / self.entry["asset"]).write_bytes(HTML)

    def verify(self, body, *, status=200, public=True):
        with patch.object(live_checks, "fetch", return_value=(status, body)):
            return live_checks.check_asset(ORIGIN, self.entry, self.assets if public else None)

    def test_release_client_identifies_every_request_including_post(self):
        with patch("subprocess.check_output", return_value=b"not allowed\n405") as curl:
            self.assertEqual(live_checks.fetch(ORIGIN, "/api/dashboard", "POST"), (405, b"not allowed"))
        args = curl.call_args.args[0]
        self.assertIn("--user-agent", args)
        self.assertEqual(args[args.index("--user-agent") + 1], "Cloud10-Release/1.0")
        self.assertEqual(args[args.index("-X") + 1], "POST")

    def test_public_html_accepts_each_edge_script_or_both_after_original_page(self):
        for extra in (DETECTION, ANALYTICS, DETECTION + b"\n" + ANALYTICS + b"\n"):
            with self.subTest(extra=extra):
                served = HTML.replace(b"</body>", extra + b"</body>")
                self.assertEqual(self.verify(served), len(HTML))

    def test_staging_requires_exact_bytes(self):
        self.assertEqual(self.verify(HTML, public=False), len(HTML))
        with self.assertRaises(ValueError):
            self.verify(HTML.replace(b"</body>", DETECTION + b"</body>"), public=False)

    def test_public_rejects_denied_request_even_if_body_matches(self):
        with self.assertRaisesRegex(ValueError, r"/location/crystal/snow-summary.*403"):
            self.verify(HTML, status=403)

    def test_public_rejects_challenge_wrong_page_and_altered_application(self):
        for body in (b"<html><body>Just a moment...</body></html>",
                     HTML.replace(b"crystal", b"mtbaker"),
                     HTML.replace(b"/app.mjs", b"/other.mjs"),
                     HTML.replace(b"</body>", DETECTION + b"<p>changed</p>" + ANALYTICS + b"</body>"),
                     HTML.replace(b"</body>", b'<script src="/unknown.mjs"></script></body>')):
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.verify(body)

    def test_public_rejects_modified_javascript_and_stale_archived_html(self):
        self.entry["sha256"] = hashlib.sha256(b"export default 1").hexdigest()
        (self.assets / self.entry["asset"]).write_bytes(b"export default 1")
        with self.assertRaises(ValueError):
            self.verify(b"export default 2")
        (self.assets / self.entry["asset"]).write_bytes(HTML)
        with self.assertRaises(ValueError):
            self.verify(HTML.replace(b"</body>", DETECTION + b"</body>"))
