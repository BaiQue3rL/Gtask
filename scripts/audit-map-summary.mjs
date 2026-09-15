// Test the unmodified packaged application using isolated synthetic player data.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] }
const { _electron } = require(argument('--playwright-module', 'playwright'))
const executablePath = resolve(argument('--executable', 'tmp/map-summary-audit/Gtask.exe'))
const chunk = readdirSync(resolve('out/main/chunks')).find(file => /^database-.*\.js$/.test(file))
const { AppDatabase } = require(resolve('out/main/chunks', chunk))
const root = mkdtempSync(join(tmpdir(), 'gtask-ui-audit-'))
const userData = join(root, 'user-data')
const documents = join(root, 'documents')
mkdirSync(userData, { recursive: true })
mkdirSync(join(documents, 'Gtask/data'), { recursive: true })
const databasePath = join(documents, 'Gtask/data/gtask.sqlite')
writeFileSync(join(userData, 'software-update.json'), JSON.stringify({ autoCheckEnabled: false, updateSource: 'github' }))
let childTitles
const otherGames = [
  { id: 'star-rail', name: '崩坏：星穹铁道', title: '空间站「黑塔」' },
  { id: 'wuthering-waves', name: '鸣潮', title: '瑝珑' }
]
function fixture(allDone = false, addChild = false) {
  assert.ok(databasePath.startsWith(root))
  const db = new AppDatabase(databasePath)
  const map = (title, progressPercent, completed = progressPercent === 100) => ({
    title, category: 'exploration', remoteKey: `test:${title}`, progressPercent, completed,
    sourceIdentity: { provider: 'miyoushe', endpoint: 'map-ui-regression', externalId: title }
  })
  try {
    db.replacePersonalSnapshot('genshin', 'exploration', `test:${'a'.repeat(64)}`, [
      map('璃月', 100), map('沉玉谷', null, false), map('至冬', 52), map('空之神殿', 60),
      ...['古兽冰原', '白桦雪葬地', '永凝冻土', '焰羽谷', '霜殛寒峰'].map(title => map(title, 100))
    ], 'map-ui-regression')
    const maps = db.listChecklistItems('zenless', { category: 'exploration' })
    const parent = maps.find(item => item.title === '莱姆尼安空洞')
    childTitles ??= maps.filter(item => item.parentRemoteKey === parent.remoteKey).map(item => item.title)
    assert.equal(childTitles.length, 13)
    db.replacePersonalSnapshot('zenless', 'exploration', `test:${'b'.repeat(64)}`, [
      map(parent.title, allDone ? 52 : 100),
      ...childTitles.map((title, i) => map(title, allDone || i < 7 ? 100 : [15, 22, 32, 62, 48, 77][i - 7]))
    ], 'map-ui-regression')
    if (addChild) db.mergeSyncedItems('zenless', 'public_schedule', [{
      remoteKey: 'test:new-map', title: '测试新增子区域', category: 'exploration',
      mapNodeKind: 'subregion', parentRemoteKey: parent.remoteKey, parentTitle: parent.title
    }], new Date().toISOString())
    for (const game of otherGames) {
      const rows = db.listChecklistItems(game.id, { category: 'exploration' })
      const parent = rows.find(item => item.title === game.title)
      game.children = rows.filter(item => item.parentRemoteKey === parent.remoteKey).map(item => item.title)
      // Star Rail has no personal exploration adapter: exercise actual manual
      // progress through the same public checklist API instead of inventing one.
      for (const child of rows.filter(item => item.parentRemoteKey === parent.remoteKey)) {
        db.setChecklistCompletion(child.id, child.title !== game.children.at(-1))
      }
    }
  } finally { db.close() }
}
fixture()
const env = { ...process.env, GTASK_AUDIT_DOCUMENTS: documents, GTASK_AUDIT_USER_DATA: userData,
  GTASK_CATALOG_FEED_URL: 'https://127.0.0.1:9/catalog.json', GTASK_CATALOG_MIRROR_FEED_URL: 'https://127.0.0.1:9/catalog.json',
  GTASK_UPDATE_FEED_URL: 'https://127.0.0.1:9/latest.json', GTASK_UPDATE_MIRROR_FEED_URL: 'https://127.0.0.1:9/latest.json' }
delete env.ELECTRON_RUN_AS_NODE
let app
let page
const errors = []
async function launch() {
  app = await _electron.launch({ executablePath, env })
  const paths = await app.evaluate(({ app, session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_, done) => done({ cancel: true }))
    return { userData: app.getPath('userData'), documents: app.getPath('documents') }
  })
  assert.deepEqual(paths, { userData, documents })
  page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', error => errors.push(error.message))
}
const row = title => page.locator('[data-panel-section="exploration"] .checklist-row')
  .filter({ has: page.locator('.item-title').filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
const groupRow = title => row(title).filter({ has: page.locator('.item-map-summary') })
const game = name => page.locator('.game-button').filter({ has: page.getByText(name, { exact: true }) }).click()
async function filter(value) {
  const checkbox = page.getByRole('checkbox', { name: '只看未完成' })
  if (await checkbox.isChecked() !== value) await checkbox.locator('..').click()
}
async function expand(title) {
  const button = groupRow(title).getByRole('button', { name: '展开子区域', exact: true })
  if (await button.count()) await button.click()
}
async function summary(title, text) {
  await groupRow(title).waitFor()
  await page.waitForFunction(({ title, text }) => [...document.querySelectorAll('.checklist-row')].some(row =>
    row.querySelector('.item-title')?.textContent === title && row.querySelector('.item-map-summary')?.textContent.includes(text)), { title, text })
}
async function captureMap(title, filename) {
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' && !animation.pending))
  await groupRow(title).evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: join(root, filename), animations: 'disabled' })
  const overlap = await page.locator('[data-panel-section="exploration"] .checklist-row').evaluateAll(elements => {
    const rectangles = elements.map(element => element.getBoundingClientRect()).filter(rectangle => rectangle.height > 0)
    return rectangles.some((rectangle, i) => i > 0 && rectangle.top < rectangles[i - 1].bottom - 1)
  })
  assert.equal(overlap, false, 'Settled map rows must not overlap')
}
try {
  await launch()
  await game('原神')
  await summary('至冬', '5/5')
  assert.equal((await row('至冬').locator('.item-map-summary').innerText()).trim(), '5/5')
  assert.match(await row('至冬').locator('.item-map-summary').getAttribute('title'), /官方总探索度 52%/)
  assert.doesNotMatch(await row('至冬').innerText(), /官方总探索度|已完成/)
  assert.equal(await row('至冬').locator('.check-button').count(), 0)
  await expand('至冬')
  await row('古兽冰原').waitFor()
  await filter(true)
  await row('至冬').waitFor({ state: 'hidden' })
  await expand('璃月')
  await row('沉玉谷').waitFor()
  assert.match(await row('沉玉谷').getAttribute('style'), /--tree-depth: 1/)
  assert.match(await row('沉玉谷').innerText(), /进度待确认/)
  assert.doesNotMatch(await row('沉玉谷').innerText(), /100%|0%/)
  await filter(false)
  await row('至冬').waitFor()
  await summary('空之神殿', '0/1')
  await expand('空之神殿')
  let selfLeaf = row('空之神殿').filter({ has: page.locator('.check-button') })
  await selfLeaf.waitFor()
  assert.equal(await row('空之神殿').count(), 2)
  assert.match(await selfLeaf.getAttribute('style'), /--tree-depth: 1/)
  assert.equal((await selfLeaf.locator('.item-progress').innerText()).trim(), '60%')
  assert.equal(await groupRow('空之神殿').locator('.check-button').count(), 0)
  const selfKeys = await row('空之神殿').evaluateAll(elements => elements.map(element => element.closest('.checklist-row-shell').dataset.rowId))
  assert.equal(new Set(selfKeys).size, 2)
  await captureMap('空之神殿', 'map-summary-self.png')
  await selfLeaf.getByRole('button', { name: '标为完成', exact: true }).click()
  await summary('空之神殿', '1/1')
  await filter(true)
  await groupRow('空之神殿').waitFor({ state: 'hidden' })
  await selfLeaf.waitFor({ state: 'hidden' })
  await filter(false)
  await selfLeaf.getByRole('button', { name: '标为未完成', exact: true }).click()
  await summary('空之神殿', '0/1')
  const selfRecords = await page.evaluate(async () => (await window.gtask.listChecklistItems('genshin')).filter(item => item.title === '空之神殿'))
  assert.equal(selfRecords.length, 1)
  assert.equal(selfRecords[0].completed, false)
  await game('绝区零')
  await summary('莱姆尼安空洞', '7/13')
  assert.equal((await row('莱姆尼安空洞').locator('.item-map-summary').innerText()).trim(), '7/13')
  assert.match(await row('莱姆尼安空洞').locator('.item-map-summary').getAttribute('title'), /官方总探索度 100%/)
  assert.equal(await row('莱姆尼安空洞').locator('.check-button').count(), 0)
  assert.doesNotMatch(await row('莱姆尼安空洞').getAttribute('class'), /\bcompleted\b/)
  await expand('莱姆尼安空洞')
  await filter(true)
  await row(childTitles[0]).waitFor({ state: 'hidden' })
  for (const title of childTitles.slice(7)) {
    await row(title).waitFor()
    assert.match(await row(title).getAttribute('style'), /--tree-depth: 1/)
  }
  await row(childTitles[7]).getByRole('button', { name: '标为完成', exact: true }).click()
  await summary('莱姆尼安空洞', '8/13')
  await row(childTitles[7]).waitFor({ state: 'hidden' })
  await filter(false)
  await row(childTitles[7]).getByRole('button', { name: '标为未完成', exact: true }).click()
  await summary('莱姆尼安空洞', '7/13')
  await filter(true)
  for (const [width, height] of [[540, 720], [750, 1000]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
    await captureMap('莱姆尼安空洞', `map-summary-${width}.png`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false)
  }
  for (const entry of otherGames) {
    await filter(false)
    await game(entry.name)
    await summary(entry.title, `${entry.children.length - 1}/${entry.children.length}`)
    assert.equal(await row(entry.title).locator('.check-button').count(), 0)
    await expand(entry.title)
    await filter(true)
    await row(entry.children[0]).waitFor({ state: 'hidden' })
    const pending = row(entry.children.at(-1))
    await pending.waitFor()
    assert.match(await pending.getAttribute('style'), /--tree-depth: 1/)
    await captureMap(entry.title, `map-summary-${entry.id}.png`)
    await pending.getByRole('button', { name: '标为完成', exact: true }).click()
    await row(entry.title).waitFor({ state: 'hidden' })
    await filter(false)
    await summary(entry.title, `${entry.children.length}/${entry.children.length}`)
  }
  await app.close()
  fixture(true)
  await launch()
  await game('原神')
  await filter(false)
  await summary('空之神殿', '0/1')
  await expand('空之神殿')
  selfLeaf = row('空之神殿').filter({ has: page.locator('.check-button') })
  assert.equal((await selfLeaf.locator('.item-progress').innerText()).trim(), '60%')
  await game('绝区零')
  await summary('莱姆尼安空洞', '13/13')
  assert.match(await row('莱姆尼安空洞').locator('.item-map-summary').getAttribute('title'), /官方总探索度 52%/)
  await filter(true)
  await row('莱姆尼安空洞').waitFor({ state: 'hidden' })
  fixture(true, true)
  await page.reload()
  await game('绝区零')
  await filter(true)
  await summary('莱姆尼安空洞', '13/14')
  await expand('莱姆尼安空洞')
  await row('测试新增子区域').waitFor()
  assert.match(await row('测试新增子区域').innerText(), /进度待确认/)
  assert.match(await row('测试新增子区域').getAttribute('style'), /--tree-depth: 1/)
  const largeDb = new AppDatabase(databasePath)
  try {
    largeDb.mergeSyncedItems('genshin', 'public_schedule', Array.from({ length: 240 }, (_, index) => ({
      remoteKey: `test:virtual-single:${index}`, category: 'exploration', mapNodeKind: 'region',
      title: `虚拟列表 ${String(index).padStart(3, '0')}`
    })), new Date().toISOString())
  } finally { largeDb.close() }
  await page.reload()
  await game('原神')
  await filter(true)
  await page.locator('.workspace').evaluate(element => { element.scrollTop = element.scrollHeight })
  const title = '虚拟列表 239'
  await groupRow(title).waitFor()
  await expand(title)
  const virtualLeaf = row(title).filter({ has: page.locator('.check-button') })
  await virtualLeaf.waitFor()
  assert.equal(await row(title).count(), 2)
  const visibleKeys = await page.locator('[data-panel-section="exploration"] .checklist-row-shell').evaluateAll(elements => elements.map(element => element.dataset.rowId))
  assert.ok(visibleKeys.length < 240, 'Large map catalog must remain virtualized')
  assert.equal(new Set(visibleKeys).size, visibleKeys.length)
  await virtualLeaf.getByRole('button', { name: '标为完成', exact: true }).click()
  await groupRow(title).waitFor({ state: 'hidden' })
  const virtualRecords = await page.evaluate(async title => (await window.gtask.listChecklistItems('genshin')).filter(item => item.title === title), title)
  assert.equal(virtualRecords.length, 1)
  assert.equal(virtualRecords[0].completed, true)
  assert.deepEqual(errors, [])
  const result = { root, checks: ['official 52% with 5/5 children hides whole group',
    'official 100% with 7/13 children retains parent and six nested unfinished children',
    'parent has no bulk completion button', 'leaf manual actions update counts and filter',
    'unknown child stays visible without an invented percentage', 'restart retains counts and reference total',
    'new catalog child reopens group without changing completed children', 'all four games use the same grouped completion UI',
    '540 and 750 pixel layouts', 'standalone map has same-name leaf with distinct view identity and shared original progress',
    'self leaf manual completion, filtering and restart preserve a single database record',
    'virtualized same-name rows have unique keys and complete the original single record'], pageErrors: errors }
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2))
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
    console.error(JSON.stringify({ root, errors, selected: await page.locator('.game-button.selected').innerText().catch(() => ''),
      visibleMaps: await page.locator('[data-panel-section="exploration"] .item-title').allTextContents().catch(() => []) }))
  }
  throw error
} finally { await app?.close() }
