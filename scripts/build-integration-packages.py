"""Build the public integration bundles and their download catalog from clean sources."""
import hashlib
import json
import runpy
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
releases = json.loads((root / 'integrations/releases.json').read_text(encoding='utf-8'))
output = root / 'dist/packages'
output.mkdir(parents=True, exist_ok=True)

runpy.run_path(str(root / 'scripts/build-laravel-upload.py'))

php = root / 'packages/php-crm-ai'
composer = json.loads((php / 'composer.json').read_text(encoding='utf-8'))
if composer['version'] != releases['php']['version']:
    raise SystemExit('PHP package version must match integrations/releases.json')
files = [php / name for name in ('README.md', 'composer.json', 'autoload.php', 'config.example.json', 'bin/crm-ai')]
for directory in ('src', 'docs', 'examples'):
    files.extend(sorted(path for path in (php / directory).rglob('*') if path.is_file()))
with ZipFile(output / releases['php']['filename'], 'w', ZIP_DEFLATED) as archive:
    for path in files:
        archive.write(path, path.relative_to(php).as_posix())

catalog = []
for platform, release in releases.items():
    contents = (output / release['filename']).read_bytes()
    catalog.append(dict(platform=platform, **release, bytes=len(contents), sha256=hashlib.sha256(contents).hexdigest()))
target = output / 'releases.json'
temporary = output / 'releases.json.tmp'
temporary.write_text(json.dumps(dict(data=catalog), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
temporary.replace(target)
print('Built Laravel and PHP integration downloads.')
