import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const target = process.argv[2]
if (!['crm', 'widget'].includes(target)) throw new Error('Deploy target must be crm or widget')
const scope = process.env.NODE_SERVICE_VERCEL_SCOPE || 'tuyens-projects-42731ba6'
const project = `node-service-${target}`
const prefix = ['exec', '--yes', '--package=vercel', '--', 'vercel']
const source = process.cwd()
const config = `vercel.${target}.json`
const manifest = JSON.parse(execFileSync('npm', [
  ...prefix, 'deploy', '--dry', '--json', '--project', project, '--scope', scope, '--local-config', config,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
const stage = await mkdtemp(join(tmpdir(), `node-service-vercel-${target}-`))
try {
  for (const { path } of manifest.files) {
    if (path.startsWith('/') || path.split('/').includes('..') || /(^|\/)\.env(?:\.|$)|(^|\/)(?:\.git|\.vercel|node_modules)(?:\/|$)/.test(path)) {
      throw new Error('Deployment manifest contains an excluded file')
    }
    await mkdir(dirname(join(stage, path)), { recursive: true })
    await cp(resolve(source, path), join(stage, path), { dereference: true })
  }
  // The remote builder must read the selected config as vercel.json, including daemons.
  await writeFile(join(stage, 'vercel.json'), await readFile(config))
  console.log(`Deploying ${project}: ${manifest.fileCount} source files; no environment files.`)
  const child = spawn('npm', [...prefix, 'deploy', stage, '--prod', '--yes', '--project', project, '--scope', scope], { stdio: 'inherit' })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
  if (code !== 0) process.exitCode = code || 1
} finally {
  await rm(stage, { recursive: true, force: true })
}
