import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const nodes = ['version_end', 'first_half_end']
const statuses = ['pending', 'running', 'ready', 'published', 'verified_unchanged']
const terminal = new Set(['published', 'verified_unchanged'])
const timingModes = ['exact_schedule', 'condition_watch']
const hourMs = 60 * 60 * 1000
export const CLOUD_EXECUTION_PROFILE = Object.freeze({ model: 'gpt-6.1-sol', reasoningEffort: 'max' })
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
function localDate(value) { return new Date(value + 8 * hourMs).toISOString().slice(0, 10) }
function dateOnly(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Expected a calendar date')
  const at = timestamp(`${value}T11:00:00+08:00`)
  assert.equal(localDate(at), value, 'Invalid calendar date')
  return at
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
  fields(state, ['schemaVersion', 'repository', 'timeZone', 'activatedAt', 'games', 'dateTriggers', 'periods', 'scheduleGaps', 'runs'])
  assert.equal(state.schemaVersion, 2)
  assert.equal(state.repository, 'BaiQue3rL/Gtask')
  assert.equal(state.timeZone, 'Asia/Shanghai')
  timestamp(state.activatedAt)
  assert(Array.isArray(state.games) && state.games.length > 0)
  assert.equal(new Set(state.games).size, state.games.length, 'Duplicate game')
  for (const game of state.games) assert(typeof game === 'string' && slug.test(game))
  assert(Array.isArray(state.periods) && Array.isArray(state.runs) && Array.isArray(state.scheduleGaps) && Array.isArray(state.dateTriggers))
  const periods = new Map()
  for (const period of state.periods) {
    fields(period, ['gameId', 'periodKey', 'startsAt', 'endsAt', 'firstHalfEndsAt', 'versionSources', 'firstHalfSources', 'checkedAt'])
    assert(state.games.includes(period.gameId), 'Unknown game')
    assert(typeof period.periodKey === 'string' && slug.test(period.periodKey))
    const start = period.startsAt === null ? null : timestamp(period.startsAt)
    const end = period.endsAt === null ? null : timestamp(period.endsAt)
    assert(end !== null || period.firstHalfEndsAt !== null || state.dateTriggers.some(trigger =>
      trigger.gameId === period.gameId && trigger.periodKey === period.periodKey), 'At least one verified trigger date is required')
    if (start !== null && end !== null) assert(start < end, 'Version window is reversed')
    if (period.firstHalfEndsAt !== null) {
      const half = timestamp(period.firstHalfEndsAt)
      if (start !== null) assert(start < half, 'First-half boundary must follow the version start')
      if (end !== null) assert(half < end, 'First-half boundary must precede the version end')
    }
    sources(period.versionSources, start === null && end === null)
    sources(period.firstHalfSources, period.firstHalfEndsAt === null)
    if (period.firstHalfEndsAt === null) assert.equal(period.firstHalfSources.length, 0)
    timestamp(period.checkedAt)
    const key = `${period.gameId}/${period.periodKey}`
    assert(!periods.has(key), 'Duplicate game/version')
    periods.set(key, period)
  }
  const dateKeys = new Set()
  for (const trigger of state.dateTriggers) {
    fields(trigger, ['gameId', 'periodKey', 'node', 'date', 'sources', 'checkedAt'])
    const period = periods.get(`${trigger.gameId}/${trigger.periodKey}`)
    assert(period && nodes.includes(trigger.node), 'Date trigger needs a recorded game/version and supported node')
    dateOnly(trigger.date); sources(trigger.sources); timestamp(trigger.checkedAt)
    const key = runKey(trigger.gameId, trigger.periodKey, trigger.node)
    assert(!dateKeys.has(key), 'Duplicate date trigger'); dateKeys.add(key)
    const exact = trigger.node === 'version_end' ? period.endsAt : period.firstHalfEndsAt
    if (exact !== null) assert.equal(localDate(timestamp(exact)), trigger.date, 'Conflicting trigger date and exact boundary')
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

export function planMaintenance(input, reference = new Date(), gameId = null) {
  const state = validateState(input), now = new Date(reference).getTime()
  assert(Number.isFinite(now), 'Invalid reference time')
  assert(gameId === null || state.games.includes(gameId), 'Unknown maintenance game')
  const games = gameId === null ? state.games : [gameId]
  const runs = new Map(state.runs.map(run => [run.key, run]))
  const today = localDate(now), tasks = [], due = [], upcoming = [], deferred = []
  const dateTriggers = new Map(state.dateTriggers.map(trigger => [runKey(trigger.gameId, trigger.periodKey, trigger.node), trigger]))
  for (const period of state.periods) {
    if (!games.includes(period.gameId)) continue
    for (const node of nodes) {
      const key = runKey(period.gameId, period.periodKey, node)
      const exact = node === 'version_end' ? period.endsAt : period.firstHalfEndsAt
      const calendar = dateTriggers.get(key)
      // 11:00 is a task execution time for an announced date, not an invented official boundary.
      const boundaryAt = exact ?? (calendar ? `${calendar.date}T11:00:00+08:00` : null)
      if (boundaryAt === null || timestamp(boundaryAt) < timestamp(state.activatedAt)) continue
      tasks.push({ key, gameId: period.gameId, periodKey: period.periodKey, node, boundaryAt,
        maintenanceDate: localDate(timestamp(boundaryAt)), timePrecision: exact === null ? 'date' : 'exact' })
    }
  }
  const eligibleGames = [...new Set(tasks.filter(task => task.maintenanceDate === today && timestamp(task.boundaryAt) <= now)
    .map(task => task.gameId))].sort()
  for (const task of tasks) {
      const run = runs.get(task.key), boundary = timestamp(task.boundaryAt)
      if (run && terminal.has(run.status)) continue
      if (boundary > now) {
        upcoming.push(task)
        continue
      }
      const item = { ...task, action: run?.status === 'ready' ? 'confirm_publication' : run ? 'resume' : 'maintain' }
      if (!eligibleGames.includes(task.gameId) || (run?.status === 'running' && timestamp(run.retryAt) > now)) {
        deferred.push(item)
        continue
      }
      due.push({ ...item, carriedOver: task.maintenanceDate !== today })
  }
  const byTime = (a, b) => timestamp(a.boundaryAt) - timestamp(b.boundaryAt) || a.key.localeCompare(b.key)
  upcoming.sort(byTime)
  const next = upcoming[0], nextAt = next ? Math.ceil(timestamp(next.boundaryAt) / 1000) * 1000 : null
  return { checkedAt: new Date(now).toISOString(), gameId, eligibleGames,
    maintenanceTargets: [...new Set(due.map(task => task.gameId))].sort(),
    unconfiguredGames: games.filter(game => !upcoming.some(task => task.gameId === game)),
    due: due.sort(byTime), upcoming, deferred: deferred.sort(byTime),
    nextWake: next ? { at: new Date(nextAt).toISOString(), reasons: upcoming.filter(task =>
      Math.ceil(timestamp(task.boundaryAt) / 1000) * 1000 === nextAt).map(task => ({ type: 'maintenance', key: task.key })) } : null }
}

/** Coverage is Agent-reported public research, never inferred from personal data or
 * the existence of a version boundary. Missing sources remain explicit gaps. */
export function verifyAnnouncementReview(input, receipt, gameId = null) {
  const state = validateState(input)
  fields(receipt, ['checkedAt', 'games'])
  assert(timestamp(receipt.checkedAt) >= timestamp(state.activatedAt), 'Review predates cloud activation')
  assert(Array.isArray(receipt.games), 'Per-game announcement coverage is required')
  const covered = new Set()
  const eligibleGames = planMaintenance(state, receipt.checkedAt, gameId).eligibleGames
  assert(Array.isArray(receipt.games) && receipt.games.length > 0, 'Maintenance coverage is required')
  let unresolvedCount = 0
  for (const game of receipt.games) {
    fields(game, ['gameId', 'coverage', 'checkedSources', 'evidencePath', 'pending'])
    assert(eligibleGames.includes(game.gameId), 'Game is outside its maintenance day')
    assert(!covered.has(game.gameId), 'Duplicate review game'); covered.add(game.gameId)
    assert(['complete', 'partial'].includes(game.coverage), 'Unknown review coverage')
    sources(game.checkedSources)
    assert(/^catalog-research\/cloud\/[a-zA-Z0-9_-]+\.json$/.test(game.evidencePath), 'Public review evidence is required')
    assert(Array.isArray(game.pending), 'Pending gaps must be explicit')
    for (const gap of game.pending) text(gap)
    assert.equal(game.pending.length === 0, game.coverage === 'complete', 'Pending research is not verified unchanged')
    unresolvedCount += game.pending.length
  }
  return { ok: true, coveredGames: [...covered], auditComplete: unresolvedCount === 0, unresolvedCount }
}

/** Normalize these values from the saved cloud task or its actual run metadata.
 * The prompt's requested model is not a receipt for the selected model. */
export function verifyCloudExecutionProfile(automationId, receipt) {
  text(automationId)
  fields(receipt, ['id', 'model', 'reasoningEffort'])
  assert.equal(receipt.id, automationId, 'Read back the original cloud task profile')
  assert.equal(receipt.model, CLOUD_EXECUTION_PROFILE.model, 'Cloud maintenance requires GPT-6.1 Sol')
  assert.equal(receipt.reasoningEffort, CLOUD_EXECUTION_PROFILE.reasoningEffort, 'Cloud maintenance requires Max reasoning')
  return { ok: true, ...CLOUD_EXECUTION_PROFILE }
}

/** Schedule one actual maintenance date. Missing facts and old retries never add another run. */
export function planCloudRearm(plan, lastRunAt = null, timingMode = 'exact_schedule') {
  assert(timingModes.includes(timingMode), 'Unsupported cloud task timing mode')
  const latestRun = Math.max(timestamp(plan.checkedAt), lastRunAt === null ? 0 : timestamp(lastRunAt))
  const target = plan.upcoming.find(task => localDate(Math.ceil(Math.max(timestamp(task.boundaryAt), latestRun + hourMs) / 1000) * 1000)
    === task.maintenanceDate)
  if (!target) return null
  const requested = timestamp(target.boundaryAt)
  const at = Math.ceil(Math.max(requested, latestRun + hourMs) / 1000) * 1000
  const iso = new Date(at).toISOString()
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23' }).formatToParts(new Date(at)).map(x => [x.type, x.value]))
  const start = `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`
  return { requestedAt: new Date(requested).toISOString(), at: iso, maintenanceDate: target.maintenanceDate,
    timeZone: 'Asia/Shanghai', timingMode,
    schedule: `BEGIN:VEVENT\nDTSTART;TZID=Asia/Shanghai:${start}\nRRULE:FREQ=DAILY;COUNT=1\nEND:VEVENT` }
}

/** receipt is normalized from a fresh automations_peek result, never from the
 * update request. A stale timer cannot masquerade as a successful schedule edit. */
export function verifyCloudRearm(automationId, expected, receipt) {
  text(automationId)
  fields(expected, ['requestedAt', 'at', 'maintenanceDate', 'timeZone', 'timingMode', 'schedule'])
  assert(timingModes.includes(expected.timingMode), 'Unsupported cloud task timing mode')
  timestamp(expected.requestedAt); timestamp(expected.at)
  dateOnly(expected.maintenanceDate)
  assert.equal(localDate(timestamp(expected.at)), expected.maintenanceDate, 'Do not schedule outside the maintenance day')
  fields(receipt, ['id', 'enabled', 'timingMode', 'timeZone', 'schedule'])
  assert.equal(receipt.id, automationId, 'Read back the original cloud task')
  assert.equal(receipt.enabled, true, 'The cloud task must remain enabled')
  assert.equal(receipt.timingMode, expected.timingMode, 'Do not silently replace the cloud task type')
  assert.equal(expected.timeZone, 'Asia/Shanghai')
  assert.equal(receipt.timeZone, expected.timeZone, 'Cloud task timezone changed')
  function event(value, timeZone) {
    assert(typeof value === 'string')
    const lines = value.replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean)
    assert(lines.length === 3 || lines.length === 4, 'Unexpected cloud schedule fields')
    assert(lines.includes('BEGIN:VEVENT') && lines.includes('END:VEVENT'))
    const start = lines.find(x => x.startsWith('DTSTART'))?.match(
      /^DTSTART(?:;TZID=(Asia\/Shanghai))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/)
    assert(start, 'Cloud schedule needs UTC or an explicit supported task timezone')
    assert(!start[1] || !start[8], 'Do not mix a local timezone with UTC')
    assert(start[8] || start[1] === 'Asia/Shanghai' || timeZone === 'Asia/Shanghai', 'Ambiguous floating schedule time')
    const when = `${start[2]}-${start[3]}-${start[4]}T${start[5]}:${start[6]}:${start[7]}${start[8] ? 'Z' : '+08:00'}`
    const rule = lines.find(x => x.startsWith('RRULE:'))
    const pairs = rule ? rule.slice(6).split(';').map(x => x.split('=')) : []
    assert(pairs.every(x => x.length === 2) && new Set(pairs.map(x => x[0])).size === pairs.length)
    const parts = Object.fromEntries(pairs)
    assert(Object.keys(parts).every(x => ['FREQ', 'COUNT', 'INTERVAL'].includes(x)))
    if (rule) {
      assert.equal(parts.FREQ, 'DAILY', 'Expected one maintenance occurrence')
      assert.equal(parts.COUNT, '1', 'Periodic recovery and polling must not remain')
      assert.equal(parts.INTERVAL ?? '1', '1')
    }
    return timestamp(when)
  }
  assert.equal(event(expected.schedule, expected.timeZone), timestamp(expected.at))
  assert.equal(event(receipt.schedule, receipt.timeZone), timestamp(expected.at), 'Cloud timer still has an old or shifted wake time')
  assert(timestamp(expected.at) >= timestamp(expected.requestedAt), 'Do not run before the planned obligation')
  return { ok: true, at: expected.at }
}

export function assertCloudPublicationPaths(changes) {
  assert(Array.isArray(changes) && changes.length > 0, 'Empty publication')
  for (const { status, path } of changes) {
    assert(['A', 'M'].includes(status), 'Cloud maintenance cannot delete or rename files')
    assert(path === 'updates/catalog.json' || path === 'automation/cloud-baseline/state.json' ||
      /^catalog-research\/cloud\/[a-zA-Z0-9_-]+\.json$/.test(path), `Outside cloud publication scope: ${path}`)
  }
}

/** A game's worker may publish shared revision metadata, but owns only its own rows. */
export function assertCloudGamePublication(gameId, beforeState, afterState, beforeCatalog, afterCatalog) {
  validateState(beforeState); validateState(afterState)
  assert(beforeState.games.includes(gameId), 'Unknown maintenance game')
  const withoutGame = state => Object.fromEntries(Object.entries(state).map(([key, value]) =>
    [key, ['periods', 'dateTriggers', 'scheduleGaps', 'runs'].includes(key) ? value.filter(row => row.gameId !== gameId) : value]))
  assert.deepEqual(withoutGame(afterState), withoutGame(beforeState), 'Another game or shared scheduling configuration changed')
  const catalogScope = catalog => {
    const { revision, publishedAt, games, ...shared } = catalog
    assert(Array.isArray(games), 'Expected catalog games')
    return { ...shared, games: games.filter(game => game.gameId !== gameId) }
  }
  assert.deepEqual(catalogScope(afterCatalog), catalogScope(beforeCatalog), 'Another game or shared catalog configuration changed')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const state = JSON.parse(readFileSync(new URL('./state.json', import.meta.url), 'utf8'))
    const action = ['--guard', '--verify-review', '--verify-rearm', '--verify-profile'].includes(args[0]) ? args.splice(0, 2) : null
    assert(args.length % 2 === 0 && args.every((arg, i) => i % 2 !== 0 || ['--game', '--at', '--last-run', '--timing-mode'].includes(arg)), 'Invalid CLI options')
    assert.equal(new Set(args.filter((_, i) => i % 2 === 0)).size, args.length / 2, 'Duplicate CLI option')
    const options = Object.fromEntries(args.reduce((all, value, i) => i % 2 === 0 ? [...all, [value, args[i + 1]]] : all, []))
    const gameId = options['--game'] ?? null
    assert(gameId === null || state.games.includes(gameId), 'Unknown maintenance game')
    if (action?.[0] === '--guard') {
      assert(/^[a-f0-9]{40}$/.test(action[1]), 'Expected an exact base commit')
      const output = execFileSync('git', ['diff', '--name-status', '--no-renames', action[1], 'HEAD', '--'], { encoding: 'utf8' })
      assertCloudPublicationPaths(output.trim().split('\n').filter(Boolean).map(line => {
        const [status, path] = line.split('\t'); return { status, path }
      }))
      const branch = process.env.GITHUB_HEAD_REF ?? execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
      const scopedGame = gameId ?? state.games.find(game => branch.startsWith(`codex/cloud-baseline/${game}-`))
      assert(scopedGame, 'Automated publication requires a game-scoped branch or --game')
      const before = path => JSON.parse(execFileSync('git', ['show', `${action[1]}:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
      assertCloudGamePublication(scopedGame, before('automation/cloud-baseline/state.json'), state,
        before('updates/catalog.json'), JSON.parse(readFileSync(new URL('../../updates/catalog.json', import.meta.url), 'utf8')))
      process.stdout.write(`${JSON.stringify({ ok: true, gameId: scopedGame })}\n`)
      process.exit(0)
    } else if (action?.[0] === '--verify-review') {
      assert(gameId, 'Cloud research validation requires --game')
      const document = JSON.parse(readFileSync(action[1], 'utf8'))
      process.stdout.write(`${JSON.stringify(verifyAnnouncementReview(state, document.announcementReview ?? document, gameId))}\n`)
      process.exit(0)
    } else if (action?.[0] === '--verify-rearm' || action?.[0] === '--verify-profile') {
      const { automationId, expected, receipt } = JSON.parse(readFileSync(action[1], 'utf8'))
      const result = action[0] === '--verify-profile' ? verifyCloudExecutionProfile(automationId, receipt)
        : verifyCloudRearm(automationId, expected, receipt)
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.exit(0)
    }
    const reference = options['--at'] ?? new Date()
    const plan = planMaintenance(state, reference, gameId)
    process.stdout.write(`${JSON.stringify({ ...plan, executionProfile: CLOUD_EXECUTION_PROFILE,
      rearm: planCloudRearm(plan, options['--last-run'] ?? null, options['--timing-mode'] ?? 'exact_schedule') }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
