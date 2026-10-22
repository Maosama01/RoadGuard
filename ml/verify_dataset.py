"""Check every dataset file against the git SHA-1 recorded from the GitHub mirror.

    python verify_dataset.py <folder containing India/> MANIFEST_git_sha1.txt
"""
import hashlib
import os
import sys

root, manifest = sys.argv[1], sys.argv[2]
bad = missing = n = 0
for line in open(manifest):
    path, size, sha = line.rstrip("\n").split("\t")
    full = os.path.join(root, path)
    n += 1
    if not os.path.exists(full):
        missing += 1
        continue
    data = open(full, "rb").read()
    if hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest() != sha:
        bad += 1
print(f"checked {n} files: {missing} missing, {bad} altered")
sys.exit(1 if (bad or missing) else 0)
