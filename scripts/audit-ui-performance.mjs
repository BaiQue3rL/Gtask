import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] }
const { _electron } = require(argument('--playwright-module', 'playwright'))
const root = mkdtempSync(join(tmpdir(), 'gtask-ui-performance-'))
const userData = join(root, 'user-data')
const documents = join(root, 'documents')
mkdirSync(userData, { recursive: true })
mkdirSync(documents, { recursive: true })
writeFileSync(join(userData, 'software-update.json'), JSON.stringify({ autoCheckEnabled: false, updateSource: 'gitee' }))
const env = { ...process.env, USERPROFILE: root, HOME: root,
  GTASK_CATALOG_FEED_URL: 'https://127.0.0.1:9/catalog.json', GTASK_CATALOG_MIRROR_FEED_URL: 'https://127.0.0.1:9/catalog.json',
  GTASK_UPDATE_FEED_URL: 'https://127.0.0.1:9/latest.json', GTASK_UPDATE_MIRROR_FEED_URL: 'https://127.0.0.1:9/latest.json' }
delete env.ELECTRON_RUN_AS_NODE
let app
const metrics = { root, label: argument('--label', 'current') }
const watchdog = setTimeout(() => {
  metrics.watchdogExpired = true
  void app?.evaluate(({ app }) => app.exit(2)).catch(() => {})
}, 120_000)
try {
  const start = performance.now()
  app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'),
    args: [resolve('.'), `--user-data-dir=${userData}`, `--gtask-development-documents-path=${documents}`], env })
  const paths = await app.evaluate(({ app, session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
    return { userData: app.getPath('userData'), documents: app.getPath('documents') }
  })
  assert.deepEqual(paths, { userData, documents })
  const page = await app.firstWindow()
  await page.locator('.checklist-row').first().waitFor()
  metrics.normalStartupMs = performance.now() - start
  metrics.normal = await page.evaluate(async () => {
    const times = []
    for (let index = 0; index < 20; index++) {
      const start = performance.now()
      await window.gtask.listChecklistItems('genshin')
      times.push(performance.now() - start)
    }
    return times.sort((a, b) => a - b)
  })
  const count = Number(argument('--count', '5000'))
  metrics.customCount = count
  await page.evaluate(async (count) => {
    for (let index = 0; index < count; index++) await window.gtask.createChecklistItem({
      gameId: 'genshin', category: 'custom', title: `性能事项 ${String(index).padStart(5, '0')}` })
  }, count)
  await page.addInitScript(() => {
    window.auditLongTasks = []
    new PerformanceObserver((list) => window.auditLongTasks.push(...list.getEntries().map((entry) => entry.duration)))
      .observe({ type: 'longtask', buffered: true })
  })
  const largeStart = performance.now()
  await page.reload()
  await page.locator('.checklist-row').filter({ hasText: '性能事项 00000' }).waitFor()
  metrics.largeLoadMs = performance.now() - largeStart
  metrics.largeRead = await page.evaluate(async () => {
    const times = []
    for (let index = 0; index < 20; index++) {
      const start = performance.now()
      await window.gtask.listChecklistItems('genshin')
      times.push(performance.now() - start)
    }
    return times.sort((a, b) => a - b)
  })
  metrics.renderedRows = await page.locator('.checklist-row').count()
  const row = page.locator('.checklist-row').filter({ hasText: '性能事项 00000' })
  await row.scrollIntoViewIfNeeded()
  metrics.completion = await page.evaluate(async () => {
    const times = []
    for (let index = 0; index < 10; index++) {
      const title = `性能事项 ${String(index).padStart(5, '0')}`
      const row = [...document.querySelectorAll('.checklist-row')].find((row) => row.textContent.includes(title))
      const button = row.querySelector('.check-button')
      const oldLabel = button.getAttribute('aria-label')
      const start = performance.now()
      button.click()
      await new Promise((resolve, reject) => {
        const inspect = () => {
          const current = [...document.querySelectorAll('.checklist-row')].find((row) => row.textContent.includes(title))?.querySelector('.check-button')
          if (performance.now() - start > 5_000) return reject(new Error('Completion did not render within 5 seconds'))
          if (current?.getAttribute('aria-label') !== oldLabel) requestAnimationFrame(resolve)
          else requestAnimationFrame(inspect)
        }
        requestAnimationFrame(inspect)
      })
      times.push(performance.now() - start)
    }
    return times.sort((a, b) => a - b)
  })
  const completed = await page.evaluate(async () => (await window.gtask.listChecklistItems('genshin')).filter((item) => item.title.startsWith('性能事项 ') && item.completed).length)
  assert.equal(completed, 10)
  // The last item remains reachable after virtualization and completion sorting.
  await page.locator('.workspace').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.locator('.checklist-row').filter({ hasText: '性能事项 00009' }).waitFor()
  assert.ok(await page.locator('.checklist-row').count() < 200)
  await page.screenshot({ path: join(root, 'large-bottom.png') })
  // Verify keyboard traversal at the edge of a rendered window.
  await page.locator('.workspace').evaluate((element) => { element.scrollTop = 30000 })
  await page.waitForTimeout(100)
  const lastShell = page.locator('[data-panel-section="custom"] .checklist-row-shell').last()
  const lastIndex = Number(await lastShell.getAttribute('data-row-index'))
  await lastShell.locator('button').last().focus()
  await page.keyboard.press('Tab')
  await page.waitForFunction((index) => document.activeElement?.closest('.checklist-row-shell')?.getAttribute('data-row-index') === String(index + 1), lastIndex)
  metrics.keyboardBoundaryPassed = true
  const longTitle = `性能事项 00010 ${'用于验证多行标题的完整显示与实际行高测量'.repeat(4)}`.slice(0, 100)
  await page.evaluate(async (title) => {
    const item = (await window.gtask.listChecklistItems('genshin')).find((item) => item.title === '性能事项 00010')
    await window.gtask.updateChecklistItem({ id: item.id, title })
  }, longTitle)
  await page.reload()
  const longRow = page.locator('.checklist-row').filter({ hasText: longTitle })
  await longRow.scrollIntoViewIfNeeded()
  await page.waitForTimeout(100)
  const geometry = await longRow.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const next = element.parentElement.nextElementSibling?.getBoundingClientRect()
    return { height: bounds.height, bottom: bounds.bottom, nextTop: next?.top }
  })
  assert.ok(geometry.height > 49)
  assert.ok(geometry.nextTop >= geometry.bottom - 1)
  metrics.variableHeightPassed = true
  await page.screenshot({ path: join(root, 'large-variable-height.png') })
  const beforeIdle = await page.evaluate(() => window.auditLongTasks.length)
  await page.waitForTimeout(5_200)
  metrics.idleLongTasks = await page.evaluate((start) => window.auditLongTasks.slice(start), beforeIdle)
  metrics.longTasks = await page.evaluate(() => window.auditLongTasks)
  metrics.memory = await app.evaluate(({ app }) => app.getAppMetrics().map(({ type, memory, cpu }) => ({ type, memory, cpu })))
  assert.ok(metrics.normalStartupMs < 3000)
  assert.ok(metrics.normal.at(-1) < 100)
  assert.ok(metrics.largeRead.at(-1) < 100)
  assert.ok(metrics.completion.at(-1) < 100)
  assert.equal(metrics.idleLongTasks.length, 0)
  mkdirSync('tmp/performance', { recursive: true })
  writeFileSync(join('tmp/performance', `ui-${metrics.label}.json`), JSON.stringify(metrics, null, 2))
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`)
} catch (error) {
  mkdirSync('tmp/performance', { recursive: true })
  writeFileSync(join('tmp/performance', `ui-${metrics.label}.json`), JSON.stringify({ ...metrics, error: String(error) }, null, 2))
  process.stderr.write(`${JSON.stringify({ ...metrics, error: String(error) }, null, 2)}\n`)
  process.exitCode = 1
} finally { clearTimeout(watchdog); await app?.close().catch(() => {}) }
