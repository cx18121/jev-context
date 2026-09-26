"""Freeze LHTB tasks for the Pi runner: agent-facing task JSON plus evaluator-only verifier inputs."""
import argparse, hashlib, json, os, shutil, subprocess, tomllib
from pathlib import Path

os.umask(0o077)
parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path, help='LHTB checkout at a pinned commit')
parser.add_argument('output', type=Path, help='New round directory')
parser.add_argument('tasks', nargs='+')
parser.add_argument('--arm-minutes', type=float, default=95, help='Arm deadline; tasks paced longer than this are rejected')
args = parser.parse_args()
commit = subprocess.check_output(['git', '-C', str(args.source), 'rev-parse', 'HEAD'], text=True).strip()
items = []
for name in args.tasks:
    task_dir = args.source / 'tasks' / name
    config = tomllib.loads((task_dir / 'task.toml').read_text())
    env = config['environment']
    # The runner has no network and no GPU. Reject tasks that need them, and tasks whose own pacing
    # estimate exceeds the arm deadline. The runner's continue reminder stands in for LHTB's loop.
    assert not env.get('allow_internet') and not env.get('gpus'), f'{name} needs network or GPU'
    paced = config.get('metadata', {}).get('estimated_duration_sec')
    assert paced is None or paced <= args.arm_minutes * 60, f'{name} is paced to {paced}s, longer than the arm'
    tag = env['docker_image']
    subprocess.run(['docker', 'pull', '--platform=linux/amd64', tag], check=True, stdout=subprocess.DEVNULL)
    digest = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{index .RepoDigests 0}}', tag], text=True).strip()
    image = tag.rsplit(':', 1)[0] + '@' + digest.split('@')[1]
    # Tasks differ (/app, /workspace); the agent must start where the image and instructions expect.
    workdir = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Config.WorkingDir}}', tag], text=True).strip()
    assert workdir.startswith('/') and workdir != '/', f'{name} has no usable WORKDIR'
    d = args.output / name; d.mkdir(parents=True)
    agent = {'kind': 'lhtb', 'instanceId': f'lhtb__{name}', 'image': image, 'instruction': (task_dir / 'instruction.md').read_text(),
             'workdir': workdir, 'cpus': int(env.get('cpus', 2)), 'memoryMb': int(env.get('memory_mb', 4096))}
    (d / 'agent.json').open('x').write(json.dumps(agent, indent=2) + '\n')
    shutil.copytree(task_dir / 'tests', d / 'evaluator-tests')
    if (task_dir / 'solution').is_dir(): shutil.copytree(task_dir / 'solution', d / 'evaluator-solution')
    verifier = {'timeoutSec': int(config.get('verifier', {}).get('timeout_sec', 900)), 'env': config.get('verifier', {}).get('env', {})}
    (d / 'evaluator-verifier.json').open('x').write(json.dumps(verifier, indent=2) + '\n')
    items.append({'task': name, 'image': image, 'agentTimeoutSec': config.get('agent', {}).get('timeout_sec'),
                  'continueUntilTimeout': config.get('agent', {}).get('continue_until_timeout', False)})
(args.output / 'tasks.json').open('x').write(json.dumps({'lhtbCommit': commit, 'prepareSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'tasks': items}, indent=2) + '\n')
print('Prepared', ', '.join(i['task'] for i in items), 'from', commit)
