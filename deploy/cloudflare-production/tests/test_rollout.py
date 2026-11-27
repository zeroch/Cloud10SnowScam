import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rollout


OLD = '11111111-1111-4111-8111-111111111111'
NEW = '22222222-2222-4222-8222-222222222222'
OTHER = '33333333-3333-4333-8333-333333333333'
SHA = 'a' * 40


class Deployments:
    """An in-memory Cloudflare control plane. Time advances only when the runner waits."""
    def __init__(self):
        self.now = 0
        self.writes = []
        self.records = []
        self.set({OLD: 100}, 'Git ' + 'b' * 40)
        self.writes.clear()

    def set(self, weights, message):
        self.active = {
            'id': str(len(self.records)) + '-' + message,
            'versions': [{'version_id': v, 'percentage': p} for v, p in weights.items()],
            'annotations': {'workers/message': message},
        }
        self.records.insert(0, self.active)
        self.writes.append((self.now, dict(weights)))

    def current(self):
        return self.active

    def history(self):
        return self.records

    def sleep(self, seconds):
        self.now += seconds


class RolloutTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, GITHUB_STEP_SUMMARY=''))
        self.enterContext(redirect_stdout(io.StringIO()))
        self.api = Deployments()
        self.probes = []

    def run_release(self, probe=None, final=None, **kwargs):
        return rollout.promote(self.api, '123', SHA, NEW,
                               probe or (lambda: self.probes.append(self.api.now)),
                               final or (lambda: None), clock=lambda: self.api.now,
                               sleep=self.api.sleep, **kwargs)

    def test_healthy_candidate_serves_ten_then_fifty_then_all_over_thirty_minutes(self):
        final = []
        self.run_release(final=lambda: final.append(self.api.now))
        self.assertEqual(self.api.writes, [
            (0, {OLD: 90, NEW: 10}), (900, {OLD: 50, NEW: 50}), (1800, {NEW: 100})])
        self.assertEqual(final, [1800])
        self.assertTrue(set(range(0, 1801, 60)).issubset(self.probes))

    def test_unhealthy_candidate_before_the_first_split_receives_zero_traffic(self):
        with self.assertRaisesRegex(RuntimeError, 'unhealthy'):
            self.run_release(probe=lambda: self.fail_probe())
        self.assertEqual(self.api.writes, [])

    def test_public_health_request_identifies_cloud10_to_the_worker(self):
        origin = 'https://preview.example'
        payload = {'ok': True, 'storage': 'Cloudflare D1', 'currentForecasts': 4, 'release': SHA}
        with patch.object(rollout, 'urlopen', return_value=io.BytesIO(json.dumps(payload).encode())) as fetch:
            rollout.check_health(origin + '/', SHA)

        target = fetch.call_args.args[0]
        request = Request(target) if isinstance(target, str) else target
        self.assertEqual(request.full_url, origin + '/api/health')
        self.assertIn('cloud10', request.get_header('User-agent', '').lower())

    def test_refused_health_request_reports_the_endpoint_and_http_status(self):
        url = 'https://preview.example/api/health'
        with patch.object(rollout, 'urlopen', side_effect=HTTPError(url, 403, 'Forbidden', {}, None)):
            with self.assertRaises((HTTPError, RuntimeError)) as failure:
                rollout.check_health('https://preview.example', SHA)
        self.assertIn(url, str(failure.exception))
        self.assertIn('403', str(failure.exception))

    @staticmethod
    def fail_probe():
        raise RuntimeError('unhealthy')

    def test_failure_in_either_soak_or_after_full_cutover_restores_previous_version(self):
        for second in [60, 960, 1800]:
            with self.subTest(second=second):
                self.api = Deployments()
                def check():
                    if second < 1800 and self.api.now >= second:
                        self.fail_probe()
                with self.assertRaisesRegex(RuntimeError, 'unhealthy'):
                    self.run_release(probe=check, final=self.fail_probe if second == 1800 else None)
                self.assertEqual(self.api.writes[-1], (second, {OLD: 100}))
                self.assertFalse(rollout.rollback(self.api, '123', sleep=self.api.sleep))

    def test_manual_rollback_is_targeted_and_idempotent_after_cutover(self):
        self.run_release()
        self.assertFalse(rollout.rollback(self.api, '321', sleep=self.api.sleep))
        self.assertTrue(rollout.rollback(self.api, '123', sleep=self.api.sleep))
        self.assertEqual(self.api.writes[-1], (1800, {OLD: 100}))
        self.assertFalse(rollout.rollback(self.api, '123', sleep=self.api.sleep))
        self.assertEqual(len(self.api.writes), 4)

    def test_rerunning_a_successful_manual_release_keeps_its_original_baseline(self):
        self.run_release()
        rollout.promote(self.api, '123', SHA, OTHER, lambda: None, lambda: None,
                        clock=lambda: self.api.now, sleep=self.api.sleep)
        self.assertEqual(len(self.api.writes), 3)
        self.assertTrue(rollout.rollback(self.api, '123', sleep=self.api.sleep))
        self.assertEqual(self.api.writes[-1][1], {OLD: 100})

    def test_operator_switch_between_read_and_write_recovers_the_intervening_allocation(self):
        store = self.api.set
        def racing_write(weights, message):
            if not self.api.writes:
                store({OLD: 25, OTHER: 75}, 'Operator split')
            store(weights, message)
        self.api.set = racing_write
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.run_release()
        self.assertEqual(self.api.writes[-1], (0, {OLD: 25, OTHER: 75}))
        self.assertEqual(len(self.api.writes), 3)

    def test_dashboard_override_during_soak_is_respected(self):
        def override():
            if self.api.now == 120:
                self.api.set({OTHER: 100}, 'Manual dashboard deployment')
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.run_release(probe=override)
        self.assertEqual(len(self.api.writes), 2)
        self.assertEqual(self.api.writes[-1][1], {OTHER: 100})

    def test_manual_rollback_stops_an_active_rollout(self):
        def stop():
            if self.api.now == 120:
                self.assertTrue(rollout.rollback(self.api, '123', sleep=self.api.sleep))
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.run_release(probe=stop)
        self.assertEqual(self.api.writes[-1], (120, {OLD: 100}))
        self.assertEqual(len(self.api.writes), 2)

    def test_refuses_unowned_split_when_capturing_the_previous_version(self):
        self.api.set({OLD: 60, OTHER: 40}, 'external split')
        with self.assertRaisesRegex(RuntimeError, 'split'):
            self.run_release()
        self.assertEqual(len(self.api.writes), 1)

    def test_lost_write_response_reconciles_actual_deployment(self):
        store = self.api.set
        def write_then_disconnect(weights, message):
            store(weights, message)
            raise OSError('response lost')
        self.api.set = write_then_disconnect
        self.run_release()
        self.assertEqual(self.api.writes[-1][1], {NEW: 100})

    def test_unaccepted_first_write_never_claims_a_release_or_moves_traffic(self):
        self.api.set = lambda *_: None
        with self.assertRaisesRegex(RuntimeError, 'did not confirm'):
            self.run_release()
        self.assertEqual(self.api.writes, [])

    def test_an_operator_reusing_a_deployment_note_still_owns_their_override(self):
        def override():
            if self.api.now == 120:
                message = self.api.active['annotations']['workers/message']
                self.api.set({OLD: 99, NEW: 1}, message)
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.run_release(probe=override)
        self.assertEqual(self.api.writes[-1][1], {OLD: 99, NEW: 1})

    def test_refused_write_on_a_rerun_does_not_undo_the_prior_completed_attempt(self):
        self.run_release()
        attempted = []
        self.api.set = lambda weights, _: attempted.append(weights)
        with self.assertRaisesRegex(RuntimeError, 'did not confirm'):
            rollout.promote(self.api, '123', 'c' * 40, OTHER, lambda: None, lambda: None,
                            clock=lambda: self.api.now, sleep=self.api.sleep)
        self.assertEqual(self.api.writes[-1][1], {NEW: 100})
        self.assertEqual(attempted, [{NEW: 90, OTHER: 10}])

    def test_control_plane_reads_active_and_posts_only_version_weights_and_message(self):
        requests = []
        def respond(request, timeout):
            requests.append(request)
            result = {'deployments': [self.api.current()]} if request.data is None else {'id': 'new'}
            return io.BytesIO(json.dumps({'success': True, 'result': result}).encode())
        with patch.dict(os.environ, CLOUDFLARE_ACCOUNT_ID='account', CLOUDFLARE_API_TOKEN='test'), \
                patch.object(rollout, 'urlopen', respond):
            api = rollout.Deployments()
            self.assertEqual(api.current(), self.api.active)
            api.set({OLD: 90, NEW: 10}, 'test deployment')
        self.assertEqual([r.get_method() for r in requests], ['GET', 'POST'])
        self.assertEqual(requests[1].full_url,
                         'https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/cloud10-forecast/deployments')
        self.assertEqual(json.loads(requests[1].data), {
            'strategy': 'percentage', 'annotations': {'workers/message': 'test deployment'},
            'versions': [{'version_id': OLD, 'percentage': 90}, {'version_id': NEW, 'percentage': 10}]})

    def test_automatic_retry_leaves_a_rolled_back_commit_off_production(self):
        self.run_release()
        rollout.rollback(self.api, '123', sleep=self.api.sleep)
        self.run_release(automatic=True)
        self.assertEqual(len(self.api.writes), 4)

    def test_an_out_of_order_ci_completion_cannot_replace_a_newer_release(self):
        self.run_release()
        with patch.object(rollout, 'older_commit', return_value=True) as compare:
            rollout.promote(self.api, '124', 'c' * 40, OTHER, lambda: None, lambda: None,
                            automatic=True, clock=lambda: self.api.now, sleep=self.api.sleep)
        compare.assert_called_once_with('c' * 40, SHA)
        self.assertEqual(len(self.api.writes), 3)
