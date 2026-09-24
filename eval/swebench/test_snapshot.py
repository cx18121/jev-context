import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('snapshot.py').resolve()


class SnapshotTests(unittest.TestCase):
    def test_batch_preserves_base_bytes_and_exclusions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, stderr=subprocess.DEVNULL).decode().strip()
            git('init', '-q')
            git('config', 'user.name', 'Local fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            expected = {'empty': '', 'one.py': 'alpha\nbeta\n', 'copy.py': 'alpha\nbeta\n', 'unicodé.txt': 'café\n'}
            for name, text in expected.items():
                (root / name).write_text(text, encoding='utf-8')
            (root / 'binary').write_bytes(b'a\0b')
            (root / 'encoding').write_bytes(b'\xff')
            (root / 'huge').write_bytes(b'x' * 1048577)
            (root / 'link').symlink_to('one.py')
            git('add', '--', '.')
            git('commit', '-qm', 'fixture')
            base = git('rev-parse', 'HEAD')
            (root / 'one.py').write_text('changed after base\n')
            (root / 'untracked').write_text('not in base\n')
            result = subprocess.check_output([sys.executable, '-I', str(SCRIPT), base], cwd=root, timeout=10)
            self.assertEqual(json.loads(result), {'files': expected, 'excluded': {
                'binary': 'binary', 'encoding': 'not-utf8', 'huge': 'file-size-limit', 'link': 'not-regular-file'}})


if __name__ == '__main__':
    unittest.main()
