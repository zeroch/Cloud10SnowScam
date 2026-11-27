"""Resolve a manual release selection to an immutable artifact from main's CI."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def git(args, directory):
    result = subprocess.run(['git', *args], cwd=directory, capture_output=True, text=True)
    if result.returncode:
        raise ValueError('Unknown release tag or unavailable Git history')
    return result.stdout.strip()


def select_candidate(selection, repository, api, directory='.'):
    value = selection.strip()
    if re.fullmatch(r'[0-9a-fA-F]{40}', value):
        sha = value.lower()
    elif re.fullmatch(r'#?[1-9][0-9]{0,9}', value):
        pr = api('pulls/' + value.lstrip('#'))
        if not (pr['merged_at'] and pr['base']['ref'] == 'main' and
                pr['base']['repo']['full_name'] == repository):
            raise ValueError('Select a pull request merged into this repository’s main branch')
        sha = pr['merge_commit_sha']
    elif re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,200}', value):
        ref = 'refs/tags/' + value
        git(['check-ref-format', ref], directory)
        sha = git(['rev-parse', '--verify', ref + '^{commit}'], directory)
    else:
        raise ValueError('Enter a merged PR number, release tag, or full commit SHA')

    main_history = git(['rev-list', '--first-parent', 'refs/remotes/origin/main'], directory)
    if sha not in main_history.splitlines():
        raise ValueError('The selected commit was never a main branch tip')

    runs = api('actions/workflows/cloud10-ci.yml/runs', branch='main', event='push',
               head_sha=sha, status='success', per_page=100)['workflow_runs']
    for run in runs:
        if (run['head_sha'] != sha or run['head_branch'] != 'main' or run['event'] != 'push'
                or (run.get('head_repository') or {}).get('full_name') != repository
                or run['status'] != 'completed' or run['conclusion'] != 'success'):
            continue
        name = f"cloud10-{sha}-{run['run_attempt']}"
        artifacts = api(f"actions/runs/{run['id']}/artifacts", name=name, per_page=100)['artifacts']
        for item in artifacts:
            digest = re.fullmatch(r'sha256:([0-9a-f]{64})', item.get('digest') or '')
            if item['name'] == name and not item['expired'] and digest:
                return dict(sha=sha, run_id=run['id'], artifact_id=item['id'], digest=digest[1])
    raise ValueError('No retained release bundle from successful push CI on main for ' + sha)


def main():
    repository = os.environ['GITHUB_REPOSITORY']
    base = os.environ['GITHUB_API_URL'] + '/repos/' + repository + '/'

    def api(path, **query):
        url = base + path + ('?' + urlencode(query) if query else '')
        request = Request(url, headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                                        'Accept': 'application/vnd.github+json'})
        with urlopen(request, timeout=30) as response:
            return json.load(response)

    candidate = select_candidate(os.environ['REQUESTED_VERSION'], repository, api)
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        for name, value in candidate.items():
            print(f'{name}={value}', file=output)
    with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as summary:
        origin = os.environ['GITHUB_SERVER_URL'] + '/' + repository
        print(f"Selected [{candidate['sha']}]({origin}/commit/{candidate['sha']}) "
              f"from [main CI run {candidate['run_id']}]({origin}/actions/runs/{candidate['run_id']}).", file=summary)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(str(error))
