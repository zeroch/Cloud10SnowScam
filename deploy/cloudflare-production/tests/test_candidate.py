import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from candidate import select_candidate
import rollout


class CandidateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name)

        def git(*args):
            return subprocess.check_output(
                ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', *args],
                cwd=self.repo, text=True, stderr=subprocess.DEVNULL).strip()

        git('init', '-b', 'main')
        git('commit', '--allow-empty', '-m', 'base')
        git('switch', '-c', 'feature')
        git('commit', '--allow-empty', '-m', 'feature')
        self.side = git('rev-parse', 'HEAD')
        git('switch', 'main')
        git('merge', '--no-ff', 'feature', '-m', 'Merge PR')
        self.sha = git('rev-parse', 'HEAD')
        git('update-ref', 'refs/remotes/origin/main', self.sha)
        git('tag', '-a', 'v1.2.3', '-m', 'release')
        self.pr = dict(base={'ref': 'main', 'repo': {'full_name': 'owner/project'}},
                       merged_at='2026-11-26T00:00:00Z', merge_commit_sha=self.sha)
        self.run = dict(id=123, run_attempt=2, event='push', head_sha=self.sha,
                        head_branch='main', head_repository={'full_name': 'owner/project'},
                        status='completed', conclusion='success')
        self.artifact = dict(id=456, expired=False, name=f'cloud10-{self.sha}-2',
                             digest='sha256:' + 'a' * 64)

    def api(self, path, **query):
        if path == 'pulls/42':
            return self.pr
        if path == 'actions/workflows/cloud10-ci.yml/runs':
            self.assertEqual(query['head_sha'], self.sha)
            return {'workflow_runs': [self.run]}
        if path == 'actions/runs/123/artifacts':
            return {'artifacts': [self.artifact]}
        raise AssertionError(path)

    def select(self, value):
        return select_candidate(value, 'owner/project', self.api, self.repo)

    def test_pr_tag_and_sha_select_same_immutable_main_build(self):
        for value in ['#42', '42', 'v1.2.3', self.sha]:
            with self.subTest(value=value):
                self.assertEqual(self.select(value), {
                    'sha': self.sha, 'run_id': 123, 'artifact_id': 456,
                    'digest': 'a' * 64})

    def test_closed_unmerged_or_other_base_pr_is_rejected(self):
        for key, value in [('merged_at', None), ('base', {'ref': 'dev', 'repo': {'full_name': 'owner/project'}})]:
            original = self.pr[key]
            self.pr[key] = value
            with self.assertRaises(ValueError):
                self.select('#42')
            self.pr[key] = original

    def test_side_parent_branch_and_revision_expressions_are_rejected(self):
        for value in [self.side, 'feature', 'main~1', 'HEAD', 'v1.2.3^{tree}']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.select(value)

    def test_wrong_run_identity_or_failed_run_cannot_supply_an_artifact(self):
        for key, value in [('event', 'pull_request'), ('head_branch', 'feature'),
                           ('conclusion', 'failure'), ('status', 'in_progress'),
                           ('head_sha', self.side), ('head_repository', {'full_name': 'other/project'})]:
            original = self.run[key]
            self.run[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.select(self.sha)
            self.run[key] = original

    def test_expired_wrong_attempt_or_missing_digest_is_rejected(self):
        for key, value in [('expired', True), ('name', f'cloud10-{self.sha}-1'), ('digest', None)]:
            original = self.artifact[key]
            self.artifact[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.select(self.sha)
            self.artifact[key] = original

    def test_automatic_release_can_only_use_the_triggering_ci_attempt(self):
        for run, attempt in [(999, 2), (123, 1)]:
            with self.subTest(run=run, attempt=attempt), self.assertRaises(ValueError):
                select_candidate(self.sha, 'owner/project', self.api, self.repo, run, attempt)
        candidate = select_candidate(self.sha, 'owner/project', self.api, self.repo, 123, 2)
        self.assertEqual(candidate['artifact_id'], 456)

    def test_only_an_already_handled_newer_commit_supersedes_an_automatic_candidate(self):
        older = subprocess.check_output(['git', 'rev-parse', self.sha + '^1'], cwd=self.repo, text=True).strip()
        self.assertTrue(rollout.older_commit(older, self.sha, self.repo))
        self.assertFalse(rollout.older_commit(self.sha, older, self.repo))
