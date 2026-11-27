import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { nodeFileTrace } from '@vercel/nft'
import { build } from 'esbuild'

const target = process.argv[2]
if (!['crm', 'widget'].includes(target)) throw new Error('Build target must be crm or widget')
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
if (target === 'crm') {
  run('python3', ['scripts/build-integration-packages.py'])
  run('npm', ['run', 'build:laravel-guide'])
  run('npm', ['exec', '--', 'vite', 'build'])
  run('npm', ['run', 'build:seo'])
} else {
  run('npm', ['run', 'build:widget-preview'])
}
run('npm', ['run', 'build:widget'])
run('npm', ['exec', '--', 'tsc', '-p', 'tsconfig.server.json'])

await mkdir('dist/vercel', { recursive: true })
await mkdir('dist/vercel-static', { recursive: true })
await writeFile('dist/vercel-static/robots.txt', 'User-agent: *\nDisallow: /\n')
await build({
  entryPoints: [target === 'crm' ? 'src/vercel.ts' : 'src/vercel-widget.ts'],
  outfile: 'dist/vercel/index.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24',
  external: ['playwright', 'playwright-core', '@sparticuz/chromium'],
  banner: { js: "import { createRequire as nodeCreateRequire } from 'node:module'; const require = nodeCreateRequire(import.meta.url);" },
  logLevel: 'info',
})
console.log(`Vercel ${target} bundle ready: dist/vercel/index.mjs`)
// Vercel's own Node builder packages the Function and Daemon together.
// A custom .vercel/output would replace the deployment's daemon declarations.
if (!process.argv.includes('--standalone')) process.exit(0)
const output = `.vercel/standalone-${target}`
const fn = `${output}/functions/index.func`
await rm(output, { recursive: true, force: true })
await mkdir(fn, { recursive: true })
const entry = 'dist/vercel/index.mjs'
const { fileList } = await nodeFileTrace([entry], {
  base: process.cwd(), processCwd: process.cwd(),
  ignore: ['.git/**', '.vercel/**', '.env', '.env.*'],
})
for (const file of fileList) {
  if (/(^|\/)\.env(?:\.|$)|(^|\/)\.git\//.test(file)) throw new Error('Secrets must not be included in the function')
  await mkdir(dirname(`${fn}/${file}`), { recursive: true })
  await cp(file, `${fn}/${file}`, { dereference: true })
}
for (const dir of target === 'crm' ? ['web', 'widget', 'packages'] : ['widget', 'widget-preview']) {
  await cp(`dist/${dir}`, `${fn}/dist/${dir}`, { recursive: true })
}
if (target === 'crm') await cp('node_modules/@fontsource/inter', `${fn}/node_modules/@fontsource/inter`, { recursive: true })
await writeFile(`${fn}/.vc-config.json`, JSON.stringify({
  runtime: 'nodejs24.x', handler: entry, launcherType: 'Nodejs',
  maxDuration: 300, supportsResponseStreaming: true,
}, null, 2))
await writeFile(`${output}/config.json`, JSON.stringify({
  version: 3, routes: [{ src: '/(.*)', dest: '/index' }],
}, null, 2))
console.log(`Vercel ${target} output ready: ${output}`)
