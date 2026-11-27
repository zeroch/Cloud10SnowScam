"""Move traffic between existing cloud10-forecast versions, with a recorded rollback target."""
import json
import os
from http.client import HTTPException
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID


PUBLIC = 'https://forecast.cloud10snow.com'
NOTE = re.compile(r'Cloud10 (rollout|rollback) run=(\d+) git=([0-9a-f]{40}) '
                  r'previous=([0-9a-f-]{36}) candidate=([0-9a-f-]{36})')


def report(message):
    print(message, flush=True)
    if path := os.environ.get('GITHUB_STEP_SUMMARY'):
        with Path(path).open('a') as output:
            print(message, file=output)


def retry(operation, *, attempts=3, delay=5):
    for attempt in range(attempts):
        try:
            return operation()
        except (HTTPException, OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
            if attempt + 1 == attempts:
                raise
            print(f'Retrying after {error}', file=sys.stderr, flush=True)
            time.sleep(delay)


class Deployments:
    def __init__(self):
        account = os.environ['CLOUDFLARE_ACCOUNT_ID']
        self.url = f'https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/cloud10-forecast/deployments'
        self.headers = {'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'],
                        'Content-Type': 'application/json'}

    def request(self, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        with urlopen(Request(self.url, data=data, headers=self.headers), timeout=15) as response:
            body = json.load(response)
        if not body.get('success'):
            raise RuntimeError(f"Cloudflare deployment API failed: {body.get('errors')}")
        return body['result']

    def history(self):
        deployments = retry(self.request)['deployments']
        if not deployments:
            raise RuntimeError('The Worker has no active deployment.')
        return deployments

    def current(self):
        return self.history()[0]

    def set(self, weights, message):
        self.request({'strategy': 'percentage', 'annotations': {'workers/message': message},
                      'versions': [{'version_id': v, 'percentage': p} for v, p in weights.items()]})


def traffic(deployment):
    return {str(UUID(v['version_id'])): v['percentage'] for v in deployment['versions']}


def note(deployment):
    return (deployment.get('annotations') or {}).get('workers/message', '')


class DeploymentChanged(RuntimeError):
    """Another deployment now owns the traffic switch."""


def require_current(api, expected):
    if api.current()['id'] != expected['id']:
        raise DeploymentChanged('The active Cloudflare deployment changed. Stopping this rollout.')


def switch(api, expected, weights, message, sleep, *, reconcile=True):
    require_current(api, expected)
    try:
        api.set(weights, message)
    except (HTTPException, OSError, ValueError, RuntimeError) as error:
        # A write can succeed even if its response is lost. Never blindly replay a write.
        print(f'Checking actual traffic after an ambiguous deployment response: {error}', file=sys.stderr)
    for attempt in range(4):
        history = api.history()
        active = history[0]
        if note(active) == message and traffic(active) == weights:
            # The API has no conditional deployment write. Check the actual predecessor
            # in case an operator changed traffic between our GET and POST.
            if len(history) < 2:
                raise DeploymentChanged('Cloudflare deployment history changed or is incomplete. Inspect traffic.')
            intervening = history[1]
            if intervening['id'] != expected['id']:
                if reconcile:
                    switch(api, active, traffic(intervening), note(intervening), sleep, reconcile=False)
                raise DeploymentChanged('Production changed during the switch. Inspect the deployment history.')
            report('Cloudflare traffic: ' + ', '.join(f'`{v}` {p}%' for v, p in weights.items()))
            return active
        if active['id'] != expected['id']:
            raise DeploymentChanged('The active Cloudflare deployment changed during the switch.')
        if attempt < 3:
            sleep(3)
    raise RuntimeError('Cloudflare did not confirm the requested traffic allocation.')


def rollback(api, run_id, *, sleep=time.sleep, expected_message=None, confirmed_id=None):
    active = api.current()
    if confirmed_id and active['id'] != confirmed_id:
        raise DeploymentChanged('The active Cloudflare deployment changed before rollback.')
    if expected_message and note(active) != expected_message:
        return False
    match = NOTE.fullmatch(note(active))
    if not match or match[2] != run_id or match[1] == 'rollback':
        report(f'Release run {run_id} has no active rollout to reverse.')
        return False
    previous, candidate = match[4], match[5]
    if candidate not in traffic(active) or set(traffic(active)) - {previous, candidate}:
        raise RuntimeError('The active versions differ from the recorded release. Check Cloudflare Deployments.')
    message = note(active).replace('Cloud10 rollout ', 'Cloud10 rollback ', 1)
    switch(api, active, {previous: 100}, message, sleep)
    report(f'Restored the previous production version for release run {run_id}.')
    return True


def older_commit(candidate_sha, handled_sha, directory='.'):
    result = subprocess.run(['git', 'merge-base', '--is-ancestor', candidate_sha, handled_sha], cwd=directory)
    if result.returncode not in (0, 1):
        raise RuntimeError('Could not compare release commits. Check the main history before retrying.')
    return result.returncode == 0


def promote(api, run_id, sha, candidate, probe, final_check, *, automatic=False,
            clock=time.monotonic, sleep=time.sleep):
    active = api.current()
    weights = traffic(active)
    if len(weights) != 1 or 100 not in weights.values():
        raise RuntimeError('Production already has a traffic split. Finish it or roll it back first.')
    previous = next(iter(weights))
    existing = NOTE.fullmatch(note(active))
    if previous == candidate or (existing and existing[3] == sha and (automatic or existing[1] == 'rollout')):
        report(f'Git {sha} was already handled. Skipping duplicate deployment.')
        return
    if automatic and existing and older_commit(sha, existing[3]):
        report(f'Git {sha} was superseded by already handled commit {existing[3]}.')
        return
    message = f'Cloud10 rollout run={run_id} git={sha} previous={previous} candidate={candidate}'
    report(f'Previous production version: `{previous}`. Release run: `{run_id}`.')
    probe()
    confirmed_id = None
    try:
        for percent in (10, 50, 100):
            weights = {candidate: percent}
            if percent < 100:
                weights[previous] = 100 - percent
            confirmed_id = None
            active = switch(api, active, weights, message, sleep)
            confirmed_id = active['id']
            if percent == 100:
                final_check()
                require_current(api, active)
                break
            deadline = clock() + 15 * 60
            while True:
                require_current(api, active)
                probe()
                remaining = deadline - clock()
                if remaining <= 0:
                    break
                sleep(min(60, remaining))
    except DeploymentChanged:
        raise
    except (Exception, KeyboardInterrupt):
        # An operator may already have rolled back or deployed another release.
        # Restore only the deployment owned by this run.
        rollback(api, run_id, sleep=sleep, expected_message=message, confirmed_id=confirmed_id)
        raise


def check_health(origin, expected_sha=None):
    # Cloudflare's Worker edge rejects urllib's default client identity.
    request = Request(origin.rstrip('/') + '/api/health', headers={'User-Agent': 'Cloud10-Release/1.0'})
    try:
        with urlopen(request, timeout=10) as response:
            health = json.load(response)
    except HTTPError as error:
        error.close()
        raise RuntimeError(f'{request.full_url} returned HTTP {error.code}.') from error
    if (health.get('ok') is not True or health.get('currentForecasts') != 4
            or health.get('storage') != 'Cloudflare D1'
            or (expected_sha and health.get('release') != expected_sha)):
        raise RuntimeError(f'{origin} failed its forecast health check (release {health.get("release")}).')


def main():
    api = Deployments()
    command = sys.argv[1]
    if command == 'target':
        run_id = os.environ.get('TARGET_RUN', '').strip()
        if not run_id:
            match = NOTE.fullmatch(note(api.current()))
            if not match:
                sys.exit('No managed rollout is active. Use the release run ID to stop a staged build.')
            run_id = match[2]
        if not re.fullmatch(r'[1-9]\d{0,19}', run_id):
            sys.exit('Use the numeric GitHub release run ID.')
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
            print(f'run_id={run_id}', file=output)
        return
    if command == 'rollback':
        if rollback(api, os.environ['TARGET_RUN']):
            retry(lambda: check_health(PUBLIC))
        return
    if command != 'promote':
        sys.exit('Expected target, rollback, or promote.')
    sha, url = os.environ['RELEASE_SHA'], os.environ['VERSION_URL']

    def probe():
        retry(lambda: check_health(url, sha))
        retry(lambda: check_health(PUBLIC))

    def final_check():
        retry(lambda: check_health(PUBLIC, sha), attempts=8, delay=8)
        retry(lambda: subprocess.run([sys.executable, str(Path(__file__).with_name('verify-live.py')),
                                      PUBLIC, 'dist/cloudflare-production/manifest.json',
                                      str(Path(os.environ['RUNNER_TEMP']) / 'production.json'), sha], check=True))

    def interrupted(*_):
        raise KeyboardInterrupt('rollout canceled')
    signal.signal(signal.SIGTERM, interrupted)
    promote(api, os.environ['GITHUB_RUN_ID'], sha, str(UUID(os.environ['VERSION_ID'])),
            probe, final_check, automatic=os.environ.get('GITHUB_EVENT_NAME') == 'workflow_run')


if __name__ == '__main__':
    main()
