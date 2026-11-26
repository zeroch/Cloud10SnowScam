"""Expose only the immutable version ID and its matching Cloudflare preview URL."""
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
from uuid import UUID

records = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
[version] = [r for r in records if r.get('type') == 'version-upload' and r.get('worker_name') == 'cloud10-forecast']
version_id = str(UUID(version['version_id']))
url = version.get('preview_url') or ''
hostname = version_id[:8] + '-cloud10-forecast.'
parts = urlsplit(url)
if (parts.scheme != 'https' or not re.fullmatch(re.escape(hostname) + r'[a-z0-9-]+\.workers\.dev', parts.netloc)
        or parts.path not in ('', '/') or parts.query or parts.fragment):
    sys.exit('Upload succeeded without a matching immutable Version URL. Enable Version URLs for cloud10-forecast.')
with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
    print(f'id={version_id}\nurl={url}', file=output)
with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as summary:
    print(f"Uploaded Git `{os.environ['RELEASE_SHA']}` as Cloudflare version `{version_id}`. [Version URL]({url}).", file=summary)
