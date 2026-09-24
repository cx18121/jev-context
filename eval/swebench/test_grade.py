import copy
import unittest
from eval.swebench.grade import extract


class GradeTests(unittest.TestCase):
    def fixture(self):
        task = 'repo__repo-1'
        row = {'infra_failure': False, 'patch_exists': True, 'patch_successfully_applied': True, 'resolved': True,
               'tests_status': {group: {'success': ['test'], 'failure': []} for group in ('FAIL_TO_PASS', 'PASS_TO_PASS')}}
        summary = {key: [] for key in ('error_ids', 'empty_patch_ids', 'incomplete_ids', 'infra_failure_ids', 'ambiguous_failure_ids')}
        summary.update(completed_ids=[task], resolved_ids=[task])
        return task, {task: row}, summary

    def test_success_and_unresolved(self):
        task, report, summary = self.fixture()
        self.assertIs(extract(report, summary, task)['resolved'], True)
        report[task]['resolved'] = False
        report[task]['tests_status']['FAIL_TO_PASS'] = {'success': [], 'failure': ['test']}
        summary['resolved_ids'] = []
        self.assertIs(extract(report, summary, task)['resolved'], False)

    def test_inconsistent_or_missing_artifacts_are_unknown(self):
        task, report, summary = self.fixture()
        for key, value in [('resolved_ids', []), ('completed_ids', []), ('error_ids', [task])]:
            changed = {**summary, key: value}
            self.assertIsNone(extract(report, changed, task)['resolved'])
        for key, value in [('infra_failure', True), ('patch_successfully_applied', False), ('tests_status', {})]:
            changed = copy.deepcopy(report)
            changed[task][key] = value
            self.assertIsNone(extract(changed, summary, task)['resolved'])
        self.assertIsNone(extract(report, summary, 'another__task-2')['resolved'])


if __name__ == '__main__':
    unittest.main()
