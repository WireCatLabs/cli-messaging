"""Explicit model preparation, kept separate from the offline benchmark."""
import hashlib
import json
import pathlib
import sys
import urllib.request

root = pathlib.Path(sys.argv[1])
manifest = json.loads(pathlib.Path(__file__).with_name('reranker.json').read_text())
root.mkdir(parents=True, exist_ok=True)
for file in manifest['files']:
    target = root / file['name']
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        staged = target.with_name(target.name + '.partial')
        print('Preparing pinned model file:', file['name'], flush=True)
        with urllib.request.urlopen(file['url']) as response, staged.open('wb') as output:
            while block := response.read(1024 * 1024):
                output.write(block)
        actual = hashlib.sha256(staged.read_bytes()).hexdigest()
        if actual != file['sha256']:
            raise ValueError(f"Hash mismatch for {file['name']}; partial file retained for inspection")
        staged.rename(target)
    assert hashlib.sha256(target.read_bytes()).hexdigest() == file['sha256'], file['name']
print('Verified local model directory:', root)
