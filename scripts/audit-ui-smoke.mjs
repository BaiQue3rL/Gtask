// Run after pnpm build. Supply --playwright-module when Playwright is bundled elsewhere.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const moduleIndex = process.argv.indexOf('--playwright-module')
const { _electron } = require(moduleIndex < 0 ? 'playwright' : process.argv[moduleIndex + 1])
const executableIndex = process.argv.indexOf('--executable')
const executablePath = resolve(executableIndex < 0 ? 'node_modules/electron/dist/electron.exe' : process.argv[executableIndex + 1])
const root = mkdtempSync(join(tmpdir(), 'gtask-ui-audit-'))
const userData = join(root, 'user-data')
const documents = join(root, 'documents')
mkdirSync(userData, { recursive: true })
mkdirSync(documents, { recursive: true })
writeFileSync(join(userData, 'software-update.json'), JSON.stringify({
  autoCheckEnabled: false, updateSource: 'gitee'
}))
const env = { ...process.env, USERPROFILE: root, HOME: root, GTASK_AUDIT_DOCUMENTS: documents, GTASK_AUDIT_USER_DATA: userData,
  GTASK_CATALOG_FEED_URL: 'https://127.0.0.1:9/catalog.json',
  GTASK_CATALOG_MIRROR_FEED_URL: 'https://127.0.0.1:9/catalog.json',
  GTASK_UPDATE_FEED_URL: 'https://127.0.0.1:9/latest.json',
  GTASK_UPDATE_MIRROR_FEED_URL: 'https://127.0.0.1:9/latest.json' }
delete env.ELECTRON_RUN_AS_NODE
let app
const pageErrors = []
const checks = []
async function launch() {
  app = await _electron.launch({ executablePath,
    args: [resolve('.'), `--user-data-dir=${userData}`, `--gtask-development-documents-path=${documents}`], env })
  const paths = await app.evaluate(({ app, session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] },
      (_details, callback) => callback({ cancel: true }))
    return { userData: app.getPath('userData'), documents: app.getPath('documents') }
  })
  assert.equal(paths.userData, userData)
  assert.equal(paths.documents, documents)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.locator('.game-button').nth(3).waitFor()
  return page
}
try {
  let page = await launch()
  const games = await page.evaluate(() => window.gtask.listGames())
  assert.equal(games.length, 4)
  for (const game of games) {
    await page.locator('.game-button').filter({ hasText: game.name }).click()
    const titles = await page.evaluate(async (gameId) =>
      (await window.gtask.listChecklistItems(gameId)).map((item) => item.title), game.id)
    await page.waitForFunction((allowed) => {
      const titles = [...document.querySelectorAll('.checklist-row .item-title')].map((item) => item.textContent)
      return titles.length > 0 && titles.every((title) => allowed.includes(title))
    }, titles)
    await page.locator('.page-version-remaining').waitFor({ state: 'visible' })
  }
  checks.push('four-game navigation, catalog rendering and visible version countdown at narrow width')
  await page.locator('.game-button').first().click()
  await page.getByRole('button', { name: /新增自定义/ }).click()
  const title = '审计自定义事项'
  await page.getByLabel('事项名称').fill(title)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const row = page.locator('.checklist-row').filter({ hasText: title })
  await row.waitFor()
  await row.getByRole('button', { name: '标为完成', exact: true }).click()
  await row.getByRole('button', { name: '标为未完成', exact: true }).waitFor()
  await page.getByRole('checkbox', { name: '只看未完成' }).locator('..').click()
  await row.waitFor({ state: 'hidden' })
  await page.getByRole('checkbox', { name: '只看未完成' }).locator('..').click()
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  await row.waitFor({ state: 'hidden' })
  await page.getByTitle('回收站', { exact: true }).click()
  await page.locator('.recycle-row').filter({ hasText: title }).getByRole('button', { name: '恢复', exact: true }).click()
  await page.getByRole('button', { name: '关闭回收站' }).click()
  await row.getByRole('button', { name: '标为未完成', exact: true }).waitFor()
  checks.push('create, completion, filter, archive, recycle restore')
  const mapPanel = page.locator('[data-panel-section="exploration"]')
  const beforeExpand = await mapPanel.locator('.checklist-row').count()
  await mapPanel.getByRole('button', { name: '展开子区域', exact: true }).first().click()
  assert.ok(await mapPanel.locator('.checklist-row').count() > beforeExpand)
  await mapPanel.getByRole('button', { name: '收起子区域', exact: true }).first().click()
  await page.waitForFunction((count) => document.querySelectorAll('[data-panel-section="exploration"] .checklist-row').length === count, beforeExpand)
  checks.push('map hierarchy collapse and expand')
  await page.getByTitle('设置', { exact: true }).click()
  await page.getByRole('checkbox', { name: '显示还没开始的活动', exact: true }).locator('..').click()
  assert.equal(await page.getByRole('checkbox', { name: '显示还没开始的活动', exact: true }).isChecked(), true)
  assert.equal(await page.evaluate(() => localStorage.getItem('gtask.show-upcoming-baseline-items.v1')), 'true')
  for (const name of ['外观', '账号与数据', '软件更新', '游戏与同步']) {
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name, exact: true }).click()
    await page.locator('.settings-page').waitFor()
  }
  await page.getByRole('button', { name: '账号与数据', exact: true }).click()
  const before = await page.evaluate(async () => (await window.gtask.listBackups()).length)
  await page.getByRole('button', { name: '立即备份', exact: true }).click()
  await page.waitForFunction(async (count) => (await window.gtask.listBackups()).length > count, before)
  await page.getByRole('button', { name: '关闭设置' }).click()
  checks.push('settings tabs, visibility preference, real backup creation')
  await page.screenshot({ path: join(root, 'main.png'), fullPage: true })
  await app.close()
  app = undefined
  page = await launch()
  await page.locator('.game-button').first().click()
  await page.locator('.checklist-row').filter({ hasText: title }).getByRole('button', { name: '标为未完成', exact: true }).waitFor()
  await page.getByTitle('设置', { exact: true }).click()
  assert.equal(await page.getByRole('checkbox', { name: '显示还没开始的活动', exact: true }).isChecked(), true)
  checks.push('restart retains completion and preferences')
  await page.getByRole('button', { name: '关闭设置' }).click()
  // Publish a synthetic public exception only into this script's own database.
  const chunk = readdirSync(resolve('out/main/chunks')).find((file) => file.startsWith('database-') && file.endsWith('.js'))
  assert.ok(chunk)
  const { AppDatabase } = require(resolve('out/main/chunks', chunk))
  const testDatabasePath = join(documents, 'Gtask/data/gtask.sqlite')
  assert.ok(testDatabasePath.startsWith(root))
  const database = new AppDatabase(testDatabasePath, { seedBundledBaselines: false })
  try {
    const now = new Date().toISOString()
    const sourceUrl = 'https://example.com/ui-audit-only'
    database.applyRemoteCatalogFeed({ schemaVersion: 2, revision: 'ui-audit.deadline', publishedAt: now,
      games: [{ gameId: 'genshin', archives: [], upserts: [{ category: 'limited_event', remoteKey: 'event:ui-audit-deadline',
        title: '审计限时例外', activityTags: ['combat'], sourceUrl,
        deadlineReview: { eligibility: 'confirmed_limited', openState: 'confirmed_open', limitedSourceUrl: sourceUrl,
          openSourceUrl: sourceUrl, checkedSources: [sourceUrl], checkedAt: now,
          reviewAt: new Date(Date.now() + 86400000).toISOString(), missingReason: '隔离测试的缺时间样本' } }] }] })
  } finally { database.close() }
  await page.reload()
  await page.locator('.checklist-row').filter({ hasText: '审计限时例外' }).getByText('截止时间待确认', { exact: true }).waitFor()
  checks.push('published v2 missing deadline renders without a fabricated countdown')
  await page.screenshot({ path: join(root, 'deadline-exception.png'), fullPage: true })
  assert.deepEqual(pageErrors, [])
  const result = { ok: true, root, checks, pageErrors }
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  try { await (await app?.firstWindow())?.screenshot({ path: join(root, 'failure.png'), fullPage: true }) } catch {}
  process.stderr.write(`${JSON.stringify({ ok: false, root, checks, pageErrors, error: String(error) }, null, 2)}\n`)
  process.exitCode = 1
} finally { await app?.close() }
