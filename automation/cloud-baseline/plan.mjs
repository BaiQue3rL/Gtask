import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const nodes = ['version_end', 'first_half_end']
const statuses = ['pending', 'running', 'ready', 'published', 'verified_unchanged']
const terminal = new Set(['published', 'verified_unchanged'])
const timingModes = ['exact_schedule', 'condition_watch']
const hourMs = 60 * 60 * 1000
export const CLOUD_EXECUTION_PROFILE = Object.freeze({ model: 'gpt-6.2-sol', reasoningEffort: 'max' })
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
const executionTime = task => timestamp(task.reviewAt ?? task.boundaryAt)

/** Cloud-only scheduling metadata. This never reads a player's database or changes a catalog. */
export function validateState(state) {
  fields(state, ['schemaVersion', 'repository', 'timeZone', 'activatedAt', 'games', 'dateTriggers', 'periods', 'scheduleGaps', 'runs',
    ...(state.followUps === undefined ? [] : ['followUps'])])
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
    fields(trigger, ['gameId', 'periodKey', 'node', 'date', 'sources', 'checkedAt',
      ...(trigger.reviewAt === undefined ? [] : ['reviewAt', 'reviewReason'])])
    const period = periods.get(`${trigger.gameId}/${trigger.periodKey}`)
    assert(period && nodes.includes(trigger.node), 'Date trigger needs a recorded game/version and supported node')
    dateOnly(trigger.date); sources(trigger.sources); timestamp(trigger.checkedAt)
    const key = runKey(trigger.gameId, trigger.periodKey, trigger.node)
    assert(!dateKeys.has(key), 'Duplicate date trigger'); dateKeys.add(key)
    const exact = trigger.node === 'version_end' ? period.endsAt : period.firstHalfEndsAt
    if (exact !== null) assert.equal(localDate(timestamp(exact)), trigger.date, 'Conflicting trigger date and exact boundary')
    if (trigger.reviewAt !== undefined) {
      text(trigger.reviewReason)
      assert(timestamp(trigger.reviewAt) >= (exact === null ? dateOnly(trigger.date) : timestamp(exact)), 'Review cannot precede its node')
    }
  }
  for (const gap of state.scheduleGaps) {
    fields(gap, ['gameId', 'periodKey', 'reason', 'checkedSources', 'checkedAt'])
    assert(state.games.includes(gap.gameId))
    assert(gap.periodKey === null || (typeof gap.periodKey === 'string' && slug.test(gap.periodKey)))
    text(gap.reason); sources(gap.checkedSources); timestamp(gap.checkedAt)
  }
  const reviewKeys = new Set()
  assert(state.followUps === undefined || Array.isArray(state.followUps), 'Expected follow-ups')
  for (const review of state.followUps ?? []) {
    fields(review, ['gameId', 'key', 'targets', 'remoteKeys', 'reviewAt', 'checkedAt', 'reason', 'sources'])
    assert(state.games.includes(review.gameId), 'Unknown review game')
    assert(typeof review.key === 'string' && slug.test(review.key), 'Invalid follow-up key')
    assert(Array.isArray(review.targets) && review.targets.length > 0 && new Set(review.targets).size === review.targets.length)
    for (const target of review.targets) assert(['version', 'events', 'cycles', 'exploration'].includes(target), 'Unknown follow-up target')
    assert(Array.isArray(review.remoteKeys) && new Set(review.remoteKeys).size === review.remoteKeys.length)
    for (const key of review.remoteKeys) text(key)
    text(review.reason); sources(review.sources)
    assert(timestamp(review.reviewAt) > timestamp(review.checkedAt), 'Review must follow its last check')
    const id = `${review.gameId}/${review.key}`
    assert(!reviewKeys.has(id), 'Duplicate follow-up'); reviewKeys.add(id)
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
      // Date precision is distinct from the independently scheduled research time.
      const boundaryAt = exact ?? (calendar ? `${calendar.date}T11:00:00+08:00` : null)
      if (boundaryAt === null || timestamp(boundaryAt) < timestamp(state.activatedAt)) continue
      const nodeDate = localDate(timestamp(boundaryAt))
      const noon = timestamp(`${nodeDate}T12:00:00+08:00`)
      const reviewAt = calendar?.reviewAt ?? new Date(Math.max(noon,
        Math.ceil(timestamp(boundaryAt) / hourMs) * hourMs)).toISOString()
      tasks.push({ key, gameId: period.gameId, periodKey: period.periodKey, node, boundaryAt,
        reviewAt, maintenanceDate: localDate(timestamp(reviewAt)), timePrecision: exact === null ? 'date' : 'exact' })
    }
  }
  const nodeGames = [...new Set(tasks.filter(task => task.maintenanceDate === today && executionTime(task) <= now)
    .map(task => task.gameId))].sort()
  for (const task of tasks) {
      const run = runs.get(task.key), boundary = executionTime(task)
      if (run && terminal.has(run.status)) continue
      if (boundary > now) {
        upcoming.push(task)
        continue
      }
      const item = { ...task, action: run?.status === 'ready' ? 'confirm_publication' : run ? 'resume' : 'maintain' }
      if (!nodeGames.includes(task.gameId) || (run?.status === 'running' && timestamp(run.retryAt) > now)) {
        deferred.push(item)
        continue
      }
      due.push({ ...item, carriedOver: task.maintenanceDate !== today })
  }
  for (const review of state.followUps ?? []) {
    if (!games.includes(review.gameId)) continue
    const task = { key: `${review.gameId}/follow-up/${review.key}`, gameId: review.gameId,
      targets: review.targets, remoteKeys: review.remoteKeys, node: 'follow_up', action: 'follow_up',
      boundaryAt: review.reviewAt, reviewAt: review.reviewAt, maintenanceDate: localDate(timestamp(review.reviewAt)),
      timePrecision: 'estimate', reason: review.reason }
    if (timestamp(review.reviewAt) > now) upcoming.push(task)
    else due.push({ ...task, carriedOver: task.maintenanceDate !== today })
  }
  // A named event is a lead. Notices published in the same game can introduce
  // another event independently of both that lead and the phase overview.
  for (const task of due) {
    if (task.action === 'confirm_publication' || (task.targets && !task.targets.includes('events'))) continue
    const starts = state.periods.filter(period => period.gameId === task.gameId && period.startsAt &&
      timestamp(period.startsAt) <= now).map(period => timestamp(period.startsAt))
    const versionStart = starts.length ? Math.max(...starts) : timestamp(state.activatedAt)
    const review = task.node === 'follow_up' ? state.followUps.find(row =>
      task.key === `${row.gameId}/follow-up/${row.key}`) : null
    task.eventNoticesSince = new Date(review ? Math.min(versionStart, timestamp(review.checkedAt)) : versionStart).toISOString()
  }
  const eligibleGames = [...new Set([...nodeGames, ...due.map(task => task.gameId)])].sort()
  const byTime = (a, b) => executionTime(a) - executionTime(b) || a.key.localeCompare(b.key)
  upcoming.sort(byTime)
  // An unresolved scoped follow-up remains the next obligation after its timer
  // fires. Removing it or publishing a new estimate advances the schedule.
  const wakes = [...due.filter(task => task.node === 'follow_up'), ...upcoming].sort(byTime)
  const next = wakes[0], nextAt = next ? Math.ceil(executionTime(next) / 1000) * 1000 : null
  return { checkedAt: new Date(now).toISOString(), gameId, eligibleGames,
    maintenanceTargets: [...new Set(due.map(task => task.gameId))].sort(),
    unconfiguredGames: games.filter(game => !upcoming.some(task => task.gameId === game)),
    due: due.sort(byTime), upcoming, deferred: deferred.sort(byTime),
    nextWake: next ? { at: new Date(Math.max(now, nextAt)).toISOString(), reasons: wakes.filter(task =>
      Math.ceil(executionTime(task) / 1000) * 1000 === nextAt).map(task => ({ type: 'maintenance', key: task.key })) } : null }
}

// A single-occurrence cloud run can start before its scheduled minute. Within
// the platform's minimum rearm interval, keep this run and read the clock and
// state again at the real boundary. A preview with --at never waits.
export async function planCloudRun(readState, gameId, now = Date.now, wait = sleep) {
  for (;;) {
    const plan = planMaintenance(readState(), new Date(now()), gameId)
    const delay = plan.nextWake && timestamp(plan.nextWake.at) - now()
    if (plan.due.length || delay === null || delay >= hourMs) return plan
    if (delay > 0) await wait(delay)
  }
}

/** Coverage is Agent-reported public research, never inferred from personal data or
 * the existence of a version boundary. Missing sources remain explicit gaps. */
export function verifyAnnouncementReview(input, receipt, gameId = null, { publishedState = input, requireEventNotices = false } = {}) {
  const state = validateState(input)
  fields(receipt, ['checkedAt', 'games'])
  assert(timestamp(receipt.checkedAt) >= timestamp(state.activatedAt), 'Review predates cloud activation')
  assert(Array.isArray(receipt.games), 'Per-game announcement coverage is required')
  const covered = new Set()
  const plan = planMaintenance(state, receipt.checkedAt, gameId)
  assert(Array.isArray(receipt.games) && receipt.games.length > 0, 'Maintenance coverage is required')
  let unresolvedCount = 0
  for (const game of receipt.games) {
    fields(game, ['gameId', 'coverage', 'checkedSources', 'evidencePath', 'pending',
      ...(game.eventNotices === undefined ? [] : ['eventNotices'])])
    assert(plan.eligibleGames.includes(game.gameId), 'Game is outside its scheduled research scope')
    assert(!covered.has(game.gameId), 'Duplicate review game'); covered.add(game.gameId)
    assert(['complete', 'partial'].includes(game.coverage), 'Unknown review coverage')
    sources(game.checkedSources)
    assert(/^catalog-research\/cloud\/[a-zA-Z0-9_-]+\.json$/.test(game.evidencePath), 'Public review evidence is required')
    assert(Array.isArray(game.pending), 'Pending gaps must be explicit')
    for (const gap of game.pending) text(gap)
    assert.equal(game.pending.length === 0, game.coverage === 'complete', 'Pending research is not verified unchanged')
    const intervals = plan.due.filter(task => task.gameId === game.gameId && task.eventNoticesSince)
    if (game.eventNotices !== undefined || (requireEventNotices && intervals.length)) {
      const notices = game.eventNotices
      assert(notices, 'Event research must cover newly published notices as well as named candidates')
      fields(notices, ['since', 'sources', 'status', 'reason', 'nextReviewKey'])
      const since = timestamp(notices.since)
      assert(since <= timestamp(receipt.checkedAt) && intervals.every(task => since <= timestamp(task.eventNoticesSince)),
        'Event notice coverage starts after the requested interval')
      sources(notices.sources); text(notices.reason)
      assert(['covered', 'follow_up'].includes(notices.status), 'Unknown event notice coverage')
      if (notices.status === 'covered') assert.equal(notices.nextReviewKey, null)
      else {
        assert(game.coverage === 'partial', 'Outstanding event notices need partial coverage')
        assert(publishedState.followUps?.some(row => row.gameId === game.gameId && row.key === notices.nextReviewKey &&
          row.targets.includes('events') && timestamp(row.reviewAt) > timestamp(receipt.checkedAt)),
          'Outstanding event research needs a future events follow-up for the same game')
      }
    }
    unresolvedCount += game.pending.length
  }
  return { ok: true, coveredGames: [...covered], auditComplete: unresolvedCount === 0, unresolvedCount }
}

// The base state owns the obligation. Checking only the proposed state would
// lose the very follow-up whose removal is being verified.
export function verifyCloudResearchDelivery(gameId, before, after, research) {
  const priorEvents = (before.followUps ?? []).filter(row => row.gameId === gameId && row.targets.includes('events'))
  const changedEvents = priorEvents.filter(previous => !(after.followUps ?? []).some(row =>
    row.gameId === gameId && row.key === previous.key && row.targets.includes('events') &&
    row.checkedAt === previous.checkedAt && row.reviewAt === previous.reviewAt &&
    previous.remoteKeys.every(key => row.remoteKeys.includes(key))))
  const newNodeReports = after.runs.filter(run => run.gameId === gameId && run.evidencePath &&
    !before.runs.some(old => old.key === run.key && old.evidencePath === run.evidencePath))
  if (!changedEvents.length && !newNodeReports.length && !research.length) return
  const verified = []
  for (const { path, document } of research) {
    const review = document.announcementReview
    if (!review) continue
    verifyAnnouncementReview(before, review, gameId, { publishedState: after, requireEventNotices: true })
    const entry = review.games.find(game => game.gameId === gameId)
    assert.equal(entry.evidencePath, path, 'Coverage must reference the submitted research file')
    verified.push({ path, at: timestamp(review.checkedAt), notices: entry.eventNotices })
  }
  for (const run of newNodeReports) assert(verified.some(item => item.path === run.evidencePath),
    'A new node research record needs verified coverage')
  for (const review of changedEvents) assert(verified.some(item => item.notices &&
    item.at >= timestamp(review.checkedAt) && timestamp(item.notices.since) <= timestamp(review.checkedAt)),
    'An events follow-up cannot be closed or advanced without covering its notices')
}

/** Normalize these values from the saved cloud task or its actual run metadata.
 * The prompt's requested model is not a receipt for the selected model. */
export function verifyCloudExecutionProfile(automationId, receipt) {
  text(automationId)
  fields(receipt, ['id', 'model', 'reasoningEffort'])
  assert.equal(receipt.id, automationId, 'Read back the original cloud task profile')
  assert.equal(receipt.model, CLOUD_EXECUTION_PROFILE.model, 'Saved cloud model differs from the maintenance profile')
  assert.equal(receipt.reasoningEffort, CLOUD_EXECUTION_PROFILE.reasoningEffort, 'Cloud maintenance requires Max reasoning')
  return { ok: true, ...CLOUD_EXECUTION_PROFILE }
}

/** Rearm the next research window or justified follow-up, including next-day catch-up. */
export function planCloudRearm(plan, lastRunAt = null, timingMode = 'exact_schedule') {
  assert(timingModes.includes(timingMode), 'Unsupported cloud task timing mode')
  const latestRun = Math.max(timestamp(plan.checkedAt), lastRunAt === null ? 0 : timestamp(lastRunAt))
  if (!plan.nextWake) return null
  const requested = timestamp(plan.nextWake.at)
  const at = Math.ceil(Math.max(requested, latestRun + hourMs) / 1000) * 1000
  const iso = new Date(at).toISOString()
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23' }).formatToParts(new Date(at)).map(x => [x.type, x.value]))
  const start = `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`
  return { requestedAt: new Date(requested).toISOString(), at: iso,
    maintenanceDate: localDate(at),
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
  assert.equal(localDate(timestamp(expected.at)), expected.maintenanceDate, 'Review date and scheduled time differ')
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
    [key, ['periods', 'dateTriggers', 'scheduleGaps', 'runs', 'followUps'].includes(key) ? value.filter(row => row.gameId !== gameId) : value]))
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
    const readState = () => JSON.parse(readFileSync(new URL('./state.json', import.meta.url), 'utf8'))
    const state = readState()
    validateState(state)
    const action = ['--guard', '--verify-review', '--verify-rearm', '--verify-profile'].includes(args[0]) ? args.splice(0, 2) : null
    assert(args.length % 2 === 0 && args.every((arg, i) => i % 2 !== 0 || ['--game', '--at', '--last-run', '--timing-mode', '--base-ref'].includes(arg)), 'Invalid CLI options')
    assert.equal(new Set(args.filter((_, i) => i % 2 === 0)).size, args.length / 2, 'Duplicate CLI option')
    const options = Object.fromEntries(args.reduce((all, value, i) => i % 2 === 0 ? [...all, [value, args[i + 1]]] : all, []))
    const gameId = options['--game'] ?? null
    assert(gameId === null || state.games.includes(gameId), 'Unknown maintenance game')
    const atRef = (ref, path) => {
      assert(/^[a-f0-9]{40}$/.test(ref), 'Expected an exact base commit')
      return JSON.parse(execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
    }
    if (action?.[0] === '--guard') {
      assert(/^[a-f0-9]{40}$/.test(action[1]), 'Expected an exact base commit')
      const output = execFileSync('git', ['diff', '--name-status', '--no-renames', action[1], 'HEAD', '--'], { encoding: 'utf8' })
      const changes = output.trim().split('\n').filter(Boolean).map(line => {
        const [status, path] = line.split('\t'); return { status, path }
      })
      assertCloudPublicationPaths(changes)
      const branch = process.env.GITHUB_HEAD_REF ?? execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
      const scopedGame = gameId ?? state.games.find(game => branch.startsWith(`codex/cloud-baseline/${game}-`))
      assert(scopedGame, 'Automated publication requires a game-scoped branch or --game')
      const prior = atRef(action[1], 'automation/cloud-baseline/state.json')
      assertCloudGamePublication(scopedGame, prior, state,
        atRef(action[1], 'updates/catalog.json'), JSON.parse(readFileSync(new URL('../../updates/catalog.json', import.meta.url), 'utf8')))
      verifyCloudResearchDelivery(scopedGame, prior, state, changes.filter(change => change.path.startsWith('catalog-research/cloud/'))
        .map(({ path }) => ({ path, document: JSON.parse(readFileSync(path, 'utf8')) })))
      process.stdout.write(`${JSON.stringify({ ok: true, gameId: scopedGame })}\n`)
      process.exit(0)
    } else if (action?.[0] === '--verify-review') {
      assert(gameId, 'Cloud research validation requires --game')
      const document = JSON.parse(readFileSync(action[1], 'utf8'))
      const prior = options['--base-ref'] ? atRef(options['--base-ref'], 'automation/cloud-baseline/state.json') : state
      process.stdout.write(`${JSON.stringify(verifyAnnouncementReview(prior, document.announcementReview ?? document, gameId,
        { publishedState: state, requireEventNotices: true }))}\n`)
      process.exit(0)
    } else if (action?.[0] === '--verify-rearm' || action?.[0] === '--verify-profile') {
      const { automationId, expected, receipt } = JSON.parse(readFileSync(action[1], 'utf8'))
      const result = action[0] === '--verify-profile' ? verifyCloudExecutionProfile(automationId, receipt)
        : verifyCloudRearm(automationId, expected, receipt)
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.exit(0)
    }
    const plan = gameId && !options['--at'] ? await planCloudRun(readState, gameId) :
      planMaintenance(state, options['--at'] ?? new Date(), gameId)
    process.stdout.write(`${JSON.stringify({ ...plan, executionProfile: CLOUD_EXECUTION_PROFILE,
      rearm: planCloudRearm(plan, options['--last-run'] ?? null, options['--timing-mode'] ?? 'exact_schedule') }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
