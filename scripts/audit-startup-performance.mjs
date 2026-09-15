import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const index = process.argv.indexOf('--playwright-module')
const { _electron } = require(index < 0 ? 'playwright' : process.argv[index + 1])
const root = mkdtempSync(join(tmpdir(), 'gtask-startup-performance-'))
const values = []
for (let trial = 0; trial < 20; trial++) {
  const userData = join(root, String(trial), 'user-data')
  const documents = join(root, String(trial), 'documents')
  mkdirSync(userData, { recursive: true }); mkdirSync(documents, { recursive: true })
  writeFileSync(join(userData, 'software-update.json'), JSON.stringify({ autoCheckEnabled: false, updateSource: 'gitee' }))
  const env = { ...process.env, USERPROFILE: join(root, String(trial)), HOME: join(root, String(trial)),
    GTASK_CATALOG_FEED_URL: 'https://127.0.0.1:9/catalog', GTASK_CATALOG_MIRROR_FEED_URL: 'https://127.0.0.1:9/catalog' }
  delete env.ELECTRON_RUN_AS_NODE
  const start = performance.now()
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'),
    args: [resolve('.'), `--user-data-dir=${userData}`, `--gtask-development-documents-path=${documents}`], env })
  try {
    const paths = await app.evaluate(({ app, session }) => {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
      return { userData: app.getPath('userData'), documents: app.getPath('documents') }
    })
    assert.deepEqual(paths, { userData, documents })
    const page = await app.firstWindow()
    await page.locator('.checklist-row').first().waitFor()
    values.push(performance.now() - start)
  } finally { await app.close() }
}
const sorted = [...values].sort((a, b) => a - b)
const result = { root, freshDataDirectories: 20, values, p95Ms: sorted[Math.ceil(values.length * 0.95) - 1], maxMs: sorted.at(-1) }
mkdirSync('tmp/performance', { recursive: true })
writeFileSync('tmp/performance/startup-final.json', JSON.stringify(result, null, 2))
assert.ok(result.p95Ms <= 3000)
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
