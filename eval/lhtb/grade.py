"""Run an LHTB verifier on each arm's committed final container. Evaluator inputs never enter the agent run."""
import argparse, json, math, subprocess, uuid
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('task', type=Path, help='Prepared task directory with evaluator-tests and evaluator-verifier.json')
parser.add_argument('runs', type=Path, nargs='+', help='Runner output directories, one arm each')
parser.add_argument('--remove-images', action='store_true', help='Delete graded final images; kept by default as evidence')
args = parser.parse_args()
verifier = json.loads((args.task / 'evaluator-verifier.json').read_text())

def docker(*argv, timeout=600, check=True):
    result = subprocess.run(['docker', *argv], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode: raise RuntimeError(f'docker {argv[0]} failed: {result.stderr[-500:]}')
    return result

results = []
for run in args.runs:
    report = json.loads((run / 'report.json').read_text())
    for arm in report['arms']:
        out = run / 'grading'; out.mkdir(exist_ok=False)
        entry = {'arm': arm['phase'], 'trajectoryCompleted': arm.get('completed', False), 'failure': arm.get('failure')}
        image = arm.get('finalImage')
        if not image:
            results.append({**entry, 'reward': None, 'status': 'no-final-image'}); continue
        name = f'jev-lhtb-grade-{uuid.uuid4()}'
        try:
            docker('create', '--name', name, '--platform=linux/amd64', '--network=none', '--label=jev.eval=lhtb-grade',
                   '--entrypoint=/bin/sleep', *[f'--env={k}={v}' for k, v in verifier['env'].items()], image, 'infinity')
            docker('start', name)
            docker('cp', str(args.task / 'evaluator-tests') + '/.', f'{name}:/tests')
            # The agent's image may already hold verifier output; only a reward written by this run counts.
            docker('exec', name, 'bash', '-c', 'rm -rf /logs/verifier && mkdir -p /logs/verifier')
            seconds = verifier['timeoutSec']
            ran = docker('exec', name, '/usr/bin/timeout', '--signal=KILL', f'{seconds}s', 'bash', '/tests/test.sh', timeout=seconds + 120, check=False)
            (out / 'test.stdout').write_text(ran.stdout); (out / 'test.stderr').write_text(ran.stderr)
            docker('cp', f'{name}:/logs/verifier/.', str(out / 'verifier'), check=False)
            reward_file = out / 'verifier' / 'reward.txt'
            reward = None
            if reward_file.is_file():
                try: reward = float(reward_file.read_text().strip())
                except ValueError: pass
            if reward is not None and not (math.isfinite(reward) and 0 <= reward <= 1): reward = None
            results.append({**entry, 'reward': reward, 'exitCode': ran.returncode, 'status': 'graded' if reward is not None else 'no-reward'})
        finally:
            docker('rm', '-f', name, check=False)
            if args.remove_images and results and results[-1].get('status') == 'graded': docker('image', 'rm', image, check=False)
        (out / 'report.json').write_text(json.dumps(results[-1], indent=2) + '\n')
print(json.dumps(results))
if any(r['reward'] is None for r in results): raise SystemExit(1)
