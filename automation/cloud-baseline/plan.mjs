import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const nodes = ['version_end', 'first_half_end']
const statuses = ['pending', 'running', 'ready', 'published', 'verified_unchanged']
const terminal = new Set(['published', 'verified_unchanged'])
const slug = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/
const digest = /^[a-f0-9]{64}$/
function fields(value, names) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object')
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Unexpected or missing fields')
}
function timestamp(value) {
  assert(typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), 'Timestamp must include a timezone')
  return Date.parse(value)
}
function text(value) {
  assert(typeof value === 'string' && value.trim().length > 0, 'Expected nonempty text')
}
function sources(value, allowEmpty = false) {
  assert(Array.isArray(value) && (allowEmpty || value.length > 0), 'Source URLs are required')
  for (const url of value) assert(typeof url === 'string' && new URL(url).protocol === 'https:', 'Source must be HTTPS')
}
export function runKey(gameId, periodKey, node) { return `${gameId}/${periodKey}/${node}` }

/** Cloud-only scheduling metadata. This never reads a player's database or changes a catalog. */
export function validateState(state) {
  fields(state, ['schemaVersion', 'repository', 'timeZone', 'activatedAt', 'games', 'nextScheduleReviewAt', 'periods', 'scheduleGaps', 'runs'])
  assert.equal(state.schemaVersion, 1)
  assert.equal(state.repository, 'BaiQue3rL/Gtask')
  assert.equal(state.timeZone, 'Asia/Shanghai')
  timestamp(state.activatedAt)
  assert(Array.isArray(state.games) && state.games.length > 0)
  assert.equal(new Set(state.games).size, state.games.length, 'Duplicate game')
  for (const game of state.games) assert(typeof game === 'string' && slug.test(game))
  if (state.nextScheduleReviewAt !== null) timestamp(state.nextScheduleReviewAt)
  assert(Array.isArray(state.periods) && Array.isArray(state.runs) && Array.isArray(state.scheduleGaps))
  const periods = new Map()
  for (const period of state.periods) {
    fields(period, ['gameId', 'periodKey', 'startsAt', 'endsAt', 'firstHalfEndsAt', 'versionSources', 'firstHalfSources', 'checkedAt'])
    assert(state.games.includes(period.gameId), 'Unknown game')
    assert(typeof period.periodKey === 'string' && slug.test(period.periodKey))
    const start = timestamp(period.startsAt), end = timestamp(period.endsAt)
    assert(start < end, 'Version window is reversed')
    if (period.firstHalfEndsAt !== null) {
      const half = timestamp(period.firstHalfEndsAt)
      assert(start < half && half < end, 'First-half boundary must be inside its version')
    }
    sources(period.versionSources)
    sources(period.firstHalfSources, period.firstHalfEndsAt === null)
    if (period.firstHalfEndsAt === null) assert.equal(period.firstHalfSources.length, 0)
    timestamp(period.checkedAt)
    const key = `${period.gameId}/${period.periodKey}`
    assert(!periods.has(key), 'Duplicate game/version')
    periods.set(key, period)
  }
  for (const gap of state.scheduleGaps) {
    fields(gap, ['gameId', 'periodKey', 'reason', 'checkedSources', 'checkedAt'])
    assert(state.games.includes(gap.gameId))
    assert(gap.periodKey === null || (typeof gap.periodKey === 'string' && slug.test(gap.periodKey)))
    text(gap.reason); sources(gap.checkedSources); timestamp(gap.checkedAt)
  }
  const seen = new Set()
  for (const run of state.runs) {
    fields(run, ['key', 'gameId', 'periodKey', 'node', 'boundaryAt', 'status', 'attempts', 'updatedAt', 'retryAt', 'branch', 'pullRequestUrl', 'catalogRevision', 'catalogSha256', 'evidencePath', 'completedAt', 'notes'])
    assert(periods.has(`${run.gameId}/${run.periodKey}`), 'Run has no recorded version')
    assert(nodes.includes(run.node) && statuses.includes(run.status), 'Unknown node or status')
    assert.equal(run.key, runKey(run.gameId, run.periodKey, run.node))
    assert(!seen.has(run.key), 'Duplicate maintenance node'); seen.add(run.key)
    assert(timestamp(run.boundaryAt) >= timestamp(state.activatedAt), 'Do not backfill old nodes')
    timestamp(run.updatedAt)
    assert(Number.isInteger(run.attempts) && run.attempts >= 1)
    if (run.retryAt !== null) timestamp(run.retryAt)
    if (run.status === 'running') assert(run.retryAt !== null, 'Running work needs a lease expiry')
    if (run.branch !== null) assert(/^codex\/cloud-baseline\/[a-zA-Z0-9_-]+$/.test(run.branch), 'Invalid cloud branch')
    if (run.pullRequestUrl !== null) assert(/^https:\/\/github\.com\/BaiQue3rL\/Gtask\/pull\/\d+$/.test(run.pullRequestUrl))
    if (run.catalogRevision !== null) text(run.catalogRevision)
    if (run.catalogSha256 !== null) assert(digest.test(run.catalogSha256))
    if (run.evidencePath !== null) assert(/^catalog-research\/cloud\/[a-zA-Z0-9_-]+\.json$/.test(run.evidencePath))
    if (run.completedAt !== null) timestamp(run.completedAt)
    assert(typeof run.notes === 'string')
    if (terminal.has(run.status) || run.status === 'ready') {
      assert(run.evidencePath && run.catalogRevision && run.catalogSha256, 'Verified work needs evidence and an exact catalog digest')
    }
    if (terminal.has(run.status)) assert(run.completedAt !== null, 'Completed work needs a receipt time')
    else assert.equal(run.completedAt, null, 'Unfinished work cannot claim completion')
  }
  return state
}

export function planMaintenance(input, reference = new Date()) {
  const state = validateState(input), now = new Date(reference).getTime()
  assert(Number.isFinite(now), 'Invalid reference time')
  const runs = new Map(state.runs.map(run => [run.key, run]))
  const due = [], upcoming = []
  for (const period of state.periods) {
    for (const node of nodes) {
      const boundaryAt = node === 'version_end' ? period.endsAt : period.firstHalfEndsAt
      if (boundaryAt === null || timestamp(boundaryAt) < timestamp(state.activatedAt)) continue
      const key = runKey(period.gameId, period.periodKey, node), run = runs.get(key)
      if (run && terminal.has(run.status)) continue
      const task = { key, gameId: period.gameId, periodKey: period.periodKey, node, boundaryAt }
      if (timestamp(boundaryAt) > now) { upcoming.push(task); continue }
      if (run?.retryAt && timestamp(run.retryAt) > now) continue
      due.push({ ...task, action: run?.status === 'ready' ? 'confirm_publication' : run ? 'resume' : 'maintain' })
    }
  }
  const byTime = (a, b) => timestamp(a.boundaryAt) - timestamp(b.boundaryAt) || a.key.localeCompare(b.key)
  return { checkedAt: new Date(now).toISOString(),
    scheduleReviewDue: state.nextScheduleReviewAt === null || timestamp(state.nextScheduleReviewAt) <= now,
    unconfiguredGames: state.games.filter(game => !state.periods.some(p => p.gameId === game && timestamp(p.endsAt) > now)),
    due: due.sort(byTime), upcoming: upcoming.sort(byTime) }
}

export function assertCloudPublicationPaths(changes) {
  assert(Array.isArray(changes) && changes.length > 0, 'Empty publication')
  for (const { status, path } of changes) {
    assert(['A', 'M'].includes(status), 'Cloud maintenance cannot delete or rename files')
    assert(path === 'updates/catalog.json' || path === 'automation/cloud-baseline/state.json' ||
      /^catalog-research\/cloud\/[a-zA-Z0-9_-]+\.json$/.test(path), `Outside cloud publication scope: ${path}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const state = JSON.parse(readFileSync(new URL('./state.json', import.meta.url), 'utf8'))
    if (args[0] === '--guard') {
      assert(args.length === 2 && /^[a-f0-9]{40}$/.test(args[1]), 'Expected an exact base commit')
      const output = execFileSync('git', ['diff', '--name-status', '--no-renames', args[1], 'HEAD', '--'], { encoding: 'utf8' })
      assertCloudPublicationPaths(output.trim().split('\n').filter(Boolean).map(line => {
        const [status, path] = line.split('\t'); return { status, path }
      }))
    } else assert(args.length === 0 || (args.length === 2 && args[0] === '--at'), 'Usage: plan.mjs [--at timestamp | --guard base-sha]')
    process.stdout.write(`${JSON.stringify(planMaintenance(state, args[0] === '--at' ? args[1] : new Date()), null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
