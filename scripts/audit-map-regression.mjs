// Isolated packaged UI check for the 2026-09-15 map acceptance regression.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] }
const { _electron } = require(argument('--playwright-module', 'playwright'))
const executablePath = resolve(argument('--executable', 'tmp/map-fix-package-audit-20260915/Gtask.exe'))
const chunk = readdirSync(resolve('out/main/chunks')).find(file => /^database-.*\.js$/.test(file))
const { AppDatabase } = require(resolve('out/main/chunks', chunk))
const root = mkdtempSync(join(tmpdir(), 'gtask-ui-audit-'))
const userData = join(root, 'user-data')
const documents = join(root, 'documents')
mkdirSync(userData, { recursive: true })
mkdirSync(join(documents, 'Gtask/data'), { recursive: true })
const databasePath = join(documents, 'Gtask/data/gtask.sqlite')
writeFileSync(join(userData, 'software-update.json'), JSON.stringify({ autoCheckEnabled: false, updateSource: 'github' }))
function applyFixture(incomplete) {
  assert.ok(databasePath.startsWith(root))
  const db = new AppDatabase(databasePath)
  const map = (title, progressPercent, completed = progressPercent === 100) => ({
    title, category: 'exploration', remoteKey: `test:${title}`, progressPercent, completed,
    sourceIdentity: { provider: 'miyoushe', endpoint: 'map-ui-regression', externalId: title }
  })
  try {
    db.replacePersonalSnapshot('genshin', 'exploration', `miyoushe:${'a'.repeat(64)}`, [
      map('璃月', 100), map('沉玉谷', incomplete ? null : 100, !incomplete),
      map('来歆山', 100), map('沉玉谷·南陵', 100), map('沉玉谷·上谷', 100), map('至冬', 52),
      ...['古兽冰原', '白桦雪葬地', '永凝冻土', '焰羽谷', '霜殛寒峰'].map(title => map(title, 100))
    ], 'map-ui-regression')
  } finally { db.close() }
}
applyFixture(false)
const env = { ...process.env, GTASK_AUDIT_DOCUMENTS: documents, GTASK_AUDIT_USER_DATA: userData,
  GTASK_CATALOG_FEED_URL: 'https://127.0.0.1:9/catalog.json', GTASK_CATALOG_MIRROR_FEED_URL: 'https://127.0.0.1:9/catalog.json',
  GTASK_UPDATE_FEED_URL: 'https://127.0.0.1:9/latest.json', GTASK_UPDATE_MIRROR_FEED_URL: 'https://127.0.0.1:9/latest.json' }
delete env.ELECTRON_RUN_AS_NODE
let app
const errors = []
try {
  app = await _electron.launch({ executablePath, env })
  const paths = await app.evaluate(({ app, session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_, done) => done({ cancel: true }))
    return { userData: app.getPath('userData'), documents: app.getPath('documents') }
  })
  assert.deepEqual(paths, { userData, documents })
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.game-button').first().click()
  const panel = page.locator('[data-panel-section="exploration"]')
  const row = title => panel.locator('.checklist-row').filter({ has: page.locator('.item-title').filter({ hasText: new RegExp(`^${title}$`) }) })
  await row('至冬').waitFor()
  await row('至冬').getByRole('button', { name: '展开子区域', exact: true }).click()
  for (const title of ['古兽冰原', '白桦雪葬地', '永凝冻土', '焰羽谷', '霜殛寒峰']) await row(title).waitFor()
  await page.getByRole('checkbox', { name: '只看未完成' }).locator('..').click()
  await row('古兽冰原').waitFor({ state: 'hidden' })
  assert.equal(await row('沉玉谷').count(), 0)
  assert.match(await row('至冬').innerText(), /52%/)
  await page.getByRole('checkbox', { name: '只看未完成' }).locator('..').click()
  await row('古兽冰原').waitFor()
  applyFixture(true)
  await page.reload()
  await page.locator('.game-button').first().click()
  await page.getByRole('checkbox', { name: '只看未完成' }).locator('..').click()
  await row('沉玉谷').waitFor()
  assert.equal((await row('沉玉谷').locator('.item-parent-context').innerText()).trim(), '璃月 /')
  assert.doesNotMatch(await row('沉玉谷').innerText(), /100%|0%/)
  for (const [width, height] of [[540, 720], [750, 1000]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
    await row('沉玉谷').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(root, `map-${width}.png`) })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false)
  }
  assert.deepEqual(errors, [])
  const result = { root, checks: ['completed children remain accessible with filter off', 'country total remains 52%',
    'completed Chenyu is absent from unfinished list', 'unfinished orphan keeps Liyue context', 'unknown aggregate has no invented percentage',
    '540 and 750 pixel layouts'], pageErrors: errors }
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2))
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally { await app?.close() }
