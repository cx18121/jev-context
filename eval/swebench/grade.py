"""Native patch grading after a paired run. Evaluator data never enters the agent runner."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from eval.swebench.smoke import Commands, SWE_VERSION, save


def extract(report, summary, instance):
    row = report.get(instance, {})
    flags = {key: summary.get(key) for key in (
        'error_ids', 'empty_patch_ids', 'incomplete_ids', 'infra_failure_ids', 'ambiguous_failure_ids')}
    tests = row.get('tests_status')
    complete = (summary.get('completed_ids') == [instance]
                and all(value == [] for value in flags.values())
                and row.get('infra_failure') is False
                and row.get('patch_exists') is True
                and row.get('patch_successfully_applied') is True
                and isinstance(row.get('resolved'), bool)
                and isinstance(tests, dict))
    if complete:
        complete = all(isinstance(tests.get(group), dict)
                       and isinstance(tests[group].get('success'), list)
                       and isinstance(tests[group].get('failure'), list)
                       and bool(tests[group]['success'] or tests[group]['failure'])
                       for group in ('FAIL_TO_PASS', 'PASS_TO_PASS'))
    if complete:
        observed_resolved = all(not tests[group]['failure'] for group in ('FAIL_TO_PASS', 'PASS_TO_PASS'))
        complete = (row['resolved'] == observed_resolved
                    and summary.get('resolved_ids') == ([instance] if row['resolved'] else []))
    return {'resolved': row['resolved'] if complete else None,
            'status': 'graded' if complete else 'grading-incomplete-or-ambiguous',
            'reportedResolved': row.get('resolved'), 'infraFailure': row.get('infra_failure'),
            'patchExists': row.get('patch_exists'), 'patchApplied': row.get('patch_successfully_applied'),
            'tests': tests, 'summaryFlags': flags}


def main(run, dataset):
    os.umask(0o077)
    if os.environ.get('PYTHON_DOTENV_DISABLED') != '1':
        raise ValueError('Set PYTHON_DOTENV_DISABLED=1 before invocation')
    if importlib.metadata.version('swebench') != SWE_VERSION:
        raise ValueError('Wrong SWE-bench version')
    run = run.resolve()
    manifest = json.loads((run / 'manifest.json').read_text())
    trajectory = json.loads((run / 'report.json').read_text())
    instance = manifest['instanceId']
    dataset = dataset.resolve()
    rows = json.loads(dataset.read_text())
    agent = json.loads((run / 'agent-task.json').read_text())
    if len(rows) != 1 or rows[0]['instance_id'] != instance or rows[0]['repo'] != agent['repo'] or rows[0]['base_commit'] != manifest['base'] or rows[0]['problem_statement'] != agent['problemStatement'] or rows[0]['image'] != manifest['image']:
        raise ValueError('Evaluator task does not match the executed task and pinned image')
    dataset_sha = hashlib.sha256(dataset.read_bytes()).hexdigest()
    output = run / 'grading'
    output.mkdir(exist_ok=False)
    commands = Commands(output)
    save(output / 'manifest.json', {'graderSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
         'swebenchVersion': SWE_VERSION, 'datasetSha256': dataset_sha,
         'trajectoryReportSha256': hashlib.sha256((run / 'report.json').read_bytes()).hexdigest()})
    known = ['default', 'clearing', 'control', 'selector']
    phases = [arm['phase'] for arm in trajectory['arms']]
    if not phases or phases != [phase for phase in known if phase in phases]:
        raise ValueError('Arms must be known, distinct and in canonical order')
    outcomes = []
    try:
        for arm in trajectory['arms']:
            name = arm['phase']
            if name not in known:
                raise ValueError('Unknown arm')
            if not arm.get('patch'):
                outcomes.append({'arm': name, 'resolved': None, 'status': 'no-captured-patch'})
                continue
            patch = (run / f'{name}.patch').read_text()
            if not patch.strip():
                outcomes.append({'arm': name, 'resolved': False, 'status': 'empty-patch-not-executed',
                                 'tests': None, 'basis': 'SWE-bench FAIL_TO_PASS defines the unmodified base as unresolved; this empty patch was not executed.',
                                 'trajectoryCompleted': arm.get('completed', False), 'patchSha256': hashlib.sha256(patch.encode()).hexdigest()})
                continue
            model = f'jev-native-{name}'
            run_id = f'jev-native-{uuid.uuid4().hex[:12]}'
            prediction = output / f'{name}-prediction.jsonl'
            with prediction.open('x') as file:
                file.write(json.dumps({'instance_id': instance, 'model_name_or_path': model, 'model_patch': patch}) + '\n')
            try:
                command = commands.run([sys.executable, '-I', '-m', 'swebench.harness.run_evaluation',
                    '--dataset_name', str(dataset), '--predictions_path', str(prediction),
                    '--instance_ids', instance, '--run_id', run_id, '--max_workers', '1',
                    '--timeout', '1800', '--report_dir', str(output)], timeout=2100, check=False)
                logs = output / 'logs/run_evaluation' / run_id / model / instance
                required = ['report.json', 'test_output.txt', 'run_instance.log', 'patch.diff', 'eval.sh']
                missing = [file for file in required if not (logs / file).is_file()]
                summary = output / f'{model}.{run_id}.json'
                if command.returncode or missing or not summary.is_file():
                    result = {'resolved': None, 'status': 'grading-artifact-or-command-failure',
                              'missing': missing, 'exitCode': command.returncode}
                else:
                    result = extract(json.loads((logs / 'report.json').read_text()), json.loads(summary.read_text()), instance)
                outcomes.append({'arm': name, 'trajectoryCompleted': arm.get('completed', False),
                                 'runId': run_id, 'patchSha256': hashlib.sha256(patch.encode()).hexdigest(), **result})
            finally:
                commands.run(['docker', 'rm', '-f', f'sweb.eval.{instance}.{run_id}'], check=False)
    finally:
        save(output / 'report.json', {'instance': instance, 'arms': outcomes,
             'allArmsAccounted': len(outcomes) == 2, 'costClaim': 'No model inference. Grader resource use not priced.'})
    if len(outcomes) != 2 or any(item['resolved'] is None for item in outcomes):
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('run', type=Path)
    parser.add_argument('dataset', type=Path, help='Evaluator-only single-row native dataset with the pinned image')
    args = parser.parse_args()
    main(args.run, args.dataset)
