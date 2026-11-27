"""Export the immutable rollout target and, when requested, the staging bookmark."""
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
staging_url = None
if os.environ.get('PUBLISH_STAGING') == 'true':
    staging_url = 'https://staging-' + parts.netloc.split('-', 1)[1]
    if version.get('preview_alias_url') not in (staging_url, staging_url + '/'):
        sys.exit('Wrangler did not return the requested staging alias for this Worker.')
with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
    print(f'id={version_id}\nurl={url}', file=output)
    if staging_url:
        print(f'staging_url={staging_url}', file=output)
with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as summary:
    print(f"Uploaded Git `{os.environ['RELEASE_SHA']}` as Cloudflare version `{version_id}`. [Version URL]({url}).", file=summary)
