"""Evaluator-only base snapshot, executed inside the owned task container before inference."""
import json
import subprocess
import sys

base = sys.argv[1]
files, excluded = {}, {}
used = 0
listing = subprocess.check_output(['git', 'ls-tree', '-rlz', base])
for entry in listing.split(b'\0'):
    if not entry:
        continue
    metadata, raw_path = entry.split(b'\t', 1)
    path = raw_path.decode('utf-8', errors='strict')
    mode, kind, oid, size = metadata.split()
    if mode not in (b'100644', b'100755') or kind != b'blob':
        excluded[path] = 'not-regular-file'
        continue
    size = int(size)
    if size > 1048576:
        excluded[path] = 'file-size-limit'
        continue
    if used + size > 33554432:
        excluded[path] = 'snapshot-size-limit'
        continue
    data = subprocess.check_output(['git', 'cat-file', 'blob', oid])
    if b'\0' in data:
        excluded[path] = 'binary'
        continue
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        excluded[path] = 'not-utf8'
        continue
    files[path] = text
    used += size
print(json.dumps({'files': files, 'excluded': excluded}, ensure_ascii=True))
