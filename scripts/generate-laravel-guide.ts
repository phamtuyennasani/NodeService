import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('integrations/laravel-upload');
const snippets = {
  files: [
    'app/CrmAi/Bridge.php',
    'app/CrmAi/PrivateFiles.php',
    'app/Http/Controllers/CrmAiController.php',
    'app/Http/Middleware/CrmAiPrivateResponse.php',
    'app/Providers/CrmAiServiceProvider.php',
    'config/crm-ai.php',
    'routes/crm-ai.php',
    'resources/views/crm-ai/*.blade.php',
    'resources/views/admin/layouts/js.blade.php',
  ].join('\n'),
  provider: '$this->app->register(\\App\\Providers\\CrmAiServiceProvider::class);',
  form: "@include('crm-ai.writer')",
  widget: await readFile(resolve(root, 'resources/views/admin/layouts/js.blade.php'), 'utf8'),
};
const target = resolve('web/src/laravel-guide.json');
const content = JSON.stringify(snippets, null, 2) + '\n';
const previous = await readFile(target, 'utf8').catch(() => '');
if (previous !== content) await writeFile(target, content);

const phpRoot = resolve('packages/php-crm-ai');
const phpSnippets = Object.fromEntries(await Promise.all(['bootstrap', 'editor', 'authorize'].map(async name => [
  name, await readFile(resolve(phpRoot, `examples/${name}.php`), 'utf8'),
])));
const phpTarget = resolve('web/src/php-guide.json');
const phpContent = JSON.stringify(phpSnippets, null, 2) + '\n';
if (await readFile(phpTarget, 'utf8').catch(() => '') !== phpContent) await writeFile(phpTarget, phpContent);
