"""Check the grading pipeline: apply a task's reference solution, commit the container, and grade it like an arm."""
import argparse, json, subprocess, uuid
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('task', type=Path)
parser.add_argument('output', type=Path, help='New directory for the oracle run')
args = parser.parse_args()
agent = json.loads((args.task / 'agent.json').read_text())
name = f'jev-lhtb-oracle-{uuid.uuid4()}'
tag = f'jev-lhtb-final:oracle-{uuid.uuid4().hex[:12]}'
run = lambda *a, **k: subprocess.run(['docker', *a], check=True, capture_output=True, text=True, **k)
args.output.mkdir(parents=True, exist_ok=False)
try:
    run('create', '--name', name, '--platform=linux/amd64', '--network=none', '--label=jev.eval=lhtb-oracle',
        f"--workdir={agent['workdir']}", '--entrypoint=/bin/sleep', agent['image'], 'infinity')
    run('start', name)
    run('cp', str(args.task / 'evaluator-solution') + '/.', f'{name}:/solution')
    solved = subprocess.run(['docker', 'exec', name, 'bash', '/solution/solve.sh'], capture_output=True, text=True, timeout=3600)
    (args.output / 'solve.log').write_text(solved.stdout + solved.stderr)
    run('exec', name, 'rm', '-rf', '/solution')
    run('commit', name, tag, timeout=600)
finally:
    subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
(args.output / 'report.json').write_text(json.dumps({'arms': [{'phase': 'oracle', 'completed': solved.returncode == 0, 'finalImage': tag}]}) + '\n')
print('solve exit', solved.returncode)
