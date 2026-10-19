import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const nodes = ['version_end', 'first_half_end']
const statuses = ['pending', 'running', 'ready', 'published', 'verified_unchanged']
const terminal = new Set(['published', 'verified_unchanged'])
const timingModes = ['exact_schedule', 'condition_watch']
const recoveryDelayMs = 60 * 60 * 1000
const dayMs = 24 * recoveryDelayMs
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
    const start = period.startsAt === null ? null : timestamp(period.startsAt)
    const end = period.endsAt === null ? null : timestamp(period.endsAt)
    assert(end !== null || period.firstHalfEndsAt !== null, 'At least one verified trigger boundary is required')
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
  const due = [], upcoming = [], wakeCandidates = []
  const wake = (at, reason) => wakeCandidates.push({ at: Math.ceil(at / 1000) * 1000, reason })
  for (const period of state.periods) {
    for (const node of nodes) {
      const boundaryAt = node === 'version_end' ? period.endsAt : period.firstHalfEndsAt
      if (boundaryAt === null || timestamp(boundaryAt) < timestamp(state.activatedAt)) continue
      const key = runKey(period.gameId, period.periodKey, node), run = runs.get(key)
      if (run && terminal.has(run.status)) continue
      const task = { key, gameId: period.gameId, periodKey: period.periodKey, node, boundaryAt }
      const boundary = timestamp(boundaryAt), retry = run?.retryAt ? timestamp(run.retryAt) : null
      if (boundary > now) {
        upcoming.push(task)
        wake(Math.max(boundary, retry ?? boundary), { type: retry !== null && retry > boundary ? 'retry' : 'maintenance', key })
        continue
      }
      if (retry !== null && retry > now) { wake(retry, { type: 'retry', key }); continue }
      due.push({ ...task, action: run?.status === 'ready' ? 'confirm_publication' : run ? 'resume' : 'maintain' })
      // A run must re-plan after delivery. Unfinished due work needs a recovery wake,
      // never a past one-shot date or a timer that keeps firing immediately.
      wake(now + recoveryDelayMs, { type: 'unfinished_work', key })
    }
  }
  const byTime = (a, b) => timestamp(a.boundaryAt) - timestamp(b.boundaryAt) || a.key.localeCompare(b.key)
  const scheduleReviewDue = state.nextScheduleReviewAt === null || timestamp(state.nextScheduleReviewAt) <= now
  wake(scheduleReviewDue ? now + recoveryDelayMs : timestamp(state.nextScheduleReviewAt), { type: 'schedule_review' })
  wakeCandidates.sort((a, b) => a.at - b.at || JSON.stringify(a.reason).localeCompare(JSON.stringify(b.reason)))
  const next = wakeCandidates[0]
  return { checkedAt: new Date(now).toISOString(), scheduleReviewDue,
    unconfiguredGames: state.games.filter(game => !state.periods.some(p => p.gameId === game && p.endsAt !== null && timestamp(p.endsAt) > now)),
    due: due.sort(byTime), upcoming: upcoming.sort(byTime),
    nextWake: { at: new Date(next.at).toISOString(), reasons: wakeCandidates.filter(x => x.at === next.at).map(x => x.reason) } }
}

/** Call after a real scheduling review, then persist this deadline with its evidence.
 * Merely reading a plan must never postpone an outstanding review. */
export function planNextScheduleReview(input, reference = new Date()) {
  const state = validateState(input), now = new Date(reference).getTime()
  assert(Number.isFinite(now), 'Invalid reference time')
  const completed = new Set(state.runs.filter(run => terminal.has(run.status)).map(run => run.key))
  const boundaries = state.periods.flatMap(period => nodes.map(node => ({
    key: runKey(period.gameId, period.periodKey, node),
    at: node === 'version_end' ? period.endsAt : period.firstHalfEndsAt
  }))).filter(node => node.at !== null && timestamp(node.at) > now &&
    timestamp(node.at) >= timestamp(state.activatedAt) && !completed.has(node.key))
  const nearest = Math.min(...boundaries.map(node => timestamp(node.at)))
  const missing = state.scheduleGaps.length > 0 || state.games.some(game =>
    !state.periods.some(period => period.gameId === game && period.endsAt !== null && timestamp(period.endsAt) > now))
  const near = nearest <= now + 3 * dayMs
  const interval = missing || near ? dayMs : 7 * dayMs
  // Enter daily review three days before a known node, including when it lies
  // inside a normal weekly sleep. Unknown schedules still get a daily lookup.
  const approach = nearest > now + 3 * dayMs ? nearest - 3 * dayMs : Infinity
  return { at: new Date(Math.min(now + interval, nearest, approach)).toISOString(),
    reason: missing ? 'missing_schedule' : near ? 'near_node' : 'periodic' }
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

/** Preserve the configured cloud task type. Its daily recurrence is a crash-recovery
 * guard; a successful run re-anchors DTSTART to the next actual obligation. */
export function planCloudRearm(plan, lastRunAt = null, timingMode = 'exact_schedule') {
  assert(timingModes.includes(timingMode), 'Unsupported cloud task timing mode')
  const requested = timestamp(plan.nextWake.at)
  // Scheduled runs can start early, while last_run_time still names the previous
  // run. Re-arming the same imminent boundary could lose it to the daily guard.
  const latestRun = Math.max(timestamp(plan.checkedAt), lastRunAt === null ? 0 : timestamp(lastRunAt))
  const at = Math.ceil(Math.max(requested, latestRun + recoveryDelayMs) / 1000) * 1000
  const iso = new Date(at).toISOString()
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23' }).formatToParts(new Date(at)).map(x => [x.type, x.value]))
  const start = `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`
  return { requestedAt: plan.nextWake.at, at: iso, timeZone: 'Asia/Shanghai', timingMode,
    schedule: `BEGIN:VEVENT\nDTSTART;TZID=Asia/Shanghai:${start}\nRRULE:FREQ=DAILY;INTERVAL=1\nEND:VEVENT` }
}

/** receipt is normalized from a fresh automations_peek result, never from the
 * update request. A stale timer cannot masquerade as a successful schedule edit. */
export function verifyCloudRearm(automationId, expected, receipt) {
  text(automationId)
  fields(expected, ['requestedAt', 'at', 'timeZone', 'timingMode', 'schedule'])
  assert(timingModes.includes(expected.timingMode), 'Unsupported cloud task timing mode')
  timestamp(expected.requestedAt); timestamp(expected.at)
  fields(receipt, ['id', 'enabled', 'timingMode', 'timeZone', 'schedule'])
  assert.equal(receipt.id, automationId, 'Read back the original cloud task')
  assert.equal(receipt.enabled, true, 'The cloud task must remain enabled')
  assert.equal(receipt.timingMode, expected.timingMode, 'Do not silently replace the cloud task type')
  assert.equal(expected.timeZone, 'Asia/Shanghai')
  assert.equal(receipt.timeZone, expected.timeZone, 'Cloud task timezone changed')
  function event(value, timeZone) {
    assert(typeof value === 'string')
    const lines = value.replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean)
    assert.equal(lines.length, 4, 'Unexpected cloud schedule fields')
    assert(lines.includes('BEGIN:VEVENT') && lines.includes('END:VEVENT'))
    const start = lines.find(x => x.startsWith('DTSTART'))?.match(
      /^DTSTART(?:;TZID=(Asia\/Shanghai))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/)
    assert(start, 'Cloud schedule needs UTC or an explicit supported task timezone')
    assert(!start[1] || !start[8], 'Do not mix a local timezone with UTC')
    assert(start[8] || start[1] === 'Asia/Shanghai' || timeZone === 'Asia/Shanghai', 'Ambiguous floating schedule time')
    const when = `${start[2]}-${start[3]}-${start[4]}T${start[5]}:${start[6]}:${start[7]}${start[8] ? 'Z' : '+08:00'}`
    const rule = lines.find(x => x.startsWith('RRULE:'))
    assert(rule, 'Condition watches require a periodic recovery guard')
    const pairs = rule.slice(6).split(';').map(x => x.split('='))
    assert(pairs.every(x => x.length === 2) && new Set(pairs.map(x => x[0])).size === pairs.length)
    const parts = Object.fromEntries(pairs)
    assert(Object.keys(parts).every(x => ['FREQ', 'INTERVAL'].includes(x)))
    assert.equal(parts.FREQ, 'DAILY', 'Hourly polling must not remain')
    assert.equal(parts.INTERVAL ?? '1', '1')
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
    } else if (args[0] === '--verify-rearm' || args[0] === '--verify-profile') {
      assert.equal(args.length, 2, 'Expected a receipt JSON path')
      const { automationId, expected, receipt } = JSON.parse(readFileSync(args[1], 'utf8'))
      const result = args[0] === '--verify-profile' ? verifyCloudExecutionProfile(automationId, receipt)
        : verifyCloudRearm(automationId, expected, receipt)
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.exit(0)
    } else {
      assert(args.length % 2 === 0 && args.every((arg, i) => i % 2 !== 0 || ['--at', '--last-run', '--timing-mode'].includes(arg)),
        'Usage: plan.mjs [--at timestamp] [--last-run timestamp] [--timing-mode mode] | --guard base-sha | --verify-rearm receipt.json | --verify-profile receipt.json')
      assert.equal(new Set(args.filter((_, i) => i % 2 === 0)).size, args.length / 2, 'Duplicate CLI option')
    }
    const options = Object.fromEntries(args[0] === '--guard' ? [] : args.reduce((all, value, i) => i % 2 === 0 ? [...all, [value, args[i + 1]]] : all, []))
    const reference = options['--at'] ?? new Date()
    const plan = planMaintenance(state, reference)
    process.stdout.write(`${JSON.stringify({ ...plan, executionProfile: CLOUD_EXECUTION_PROFILE,
      nextReviewAfterVerification: planNextScheduleReview(state, reference),
      rearm: planCloudRearm(plan, options['--last-run'] ?? null, options['--timing-mode'] ?? 'exact_schedule') }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
