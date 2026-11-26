from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import json


root = Path(__file__).resolve().parent.parent
kit = root / 'integrations' / 'laravel-upload'
release = json.loads((root / 'integrations/releases.json').read_text(encoding='utf-8'))['laravel']
output = root / 'dist' / 'packages' / release['filename']
files = (
    'README.md', 'config/crm-ai.php', 'routes/crm-ai.php',
    'app/Providers/CrmAiServiceProvider.php', 'app/CrmAi/Bridge.php',
    'app/CrmAi/PrivateFiles.php', 'app/Http/Controllers/CrmAiController.php',
    'app/Http/Middleware/CrmAiPrivateResponse.php', 'resources/views/crm-ai/script.blade.php',
    'resources/views/crm-ai/settings.blade.php', 'resources/views/crm-ai/writer.blade.php',
    'resources/views/admin/layouts/js.blade.php',
)

if "    'connection' => ''," not in (kit / 'config/crm-ai.php').read_text(encoding='utf-8').splitlines():
    raise SystemExit('Use the empty connection template when building the public ZIP.')

output.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for filename in files:
        archive.write(kit / filename, filename)
print(output)
