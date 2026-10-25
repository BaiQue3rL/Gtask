import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planMaintenance, validateState, runKey, assertCloudPublicationPaths, planCloudRearm, verifyCloudRearm,
  CLOUD_EXECUTION_PROFILE, verifyCloudExecutionProfile, verifyAnnouncementReview, assertCloudGamePublication } from './plan.mjs'

const at = day => `2026-11-${String(day).padStart(2, '0')}T11:00:00+08:00`
const source = 'https://example.com/official-fixture'
function fixture() {
  return { schemaVersion: 2, repository: 'BaiQue3rL/Gtask', timeZone: 'Asia/Shanghai', activatedAt: at(1), games: ['genshin'],
    dateTriggers: [], scheduleGaps: [], runs: [], periods: [{ gameId: 'genshin', periodKey: 'fixture',
      startsAt: at(1), endsAt: at(29), firstHalfEndsAt: at(12), versionSources: [source], firstHalfSources: [source], checkedAt: at(1) }] }
}
function receipt(status, overrides = {}) {
  return { key: runKey('genshin', 'fixture', 'first_half_end'), gameId: 'genshin', periodKey: 'fixture', node: 'first_half_end',
    boundaryAt: at(12), status, attempts: 1, updatedAt: at(12), retryAt: null, branch: 'codex/cloud-baseline/fixture',
    pullRequestUrl: 'https://github.com/BaiQue3rL/Gtask/pull/999', catalogRevision: 'fixture', catalogSha256: 'a'.repeat(64),
    evidencePath: 'catalog-research/cloud/fixture.json', completedAt: ['published', 'verified_unchanged'].includes(status) ? at(12) : null,
    notes: '', ...overrides }
}
function dateTrigger(overrides = {}) {
  return { gameId: 'genshin', periodKey: 'fixture', node: 'version_end', date: '2026-11-22', sources: [source], checkedAt: at(5), ...overrides }
}
function reviewReceipt(gameIds = ['genshin']) {
  return { checkedAt: at(12), games: gameIds.map(gameId => ({ gameId, coverage: 'complete',
    checkedSources: [source], evidencePath: 'catalog-research/cloud/review-fixture.json', pending: [] })) }
}
function cloudReceipt(expected, overrides = {}) {
  return { id: 'fixture-automation', enabled: true, timingMode: expected.timingMode,
    timeZone: 'Asia/Shanghai', schedule: expected.schedule, ...overrides }
}

test('each game has its own plan and next timer even on simultaneous node days', () => {
  const state = fixture(); state.games.push('star-rail')
  state.periods.push({ ...state.periods[0], gameId: 'star-rail', endsAt: at(25) })
  for (const game of state.games) {
    const plan = planMaintenance(state, at(12), game)
    assert.equal(plan.gameId, game)
    assert.deepEqual(plan.maintenanceTargets, [game])
    assert(plan.due.concat(plan.upcoming, plan.deferred).every(task => task.gameId === game))
    assert.equal(plan.nextWake.at, new Date(at(game === 'genshin' ? 29 : 25)).toISOString())
    assert.deepEqual(verifyAnnouncementReview(state, reviewReceipt([game]), game).coveredGames, [game])
    assert.throws(() => verifyAnnouncementReview(state, reviewReceipt(state.games), game), /outside/)
  }
  assert.throws(() => planMaintenance(state, at(12), 'unknown'), /Unknown/)
})

test('a game publication preserves other games and shared scheduling configuration', () => {
  const before = fixture(); before.games.push('star-rail')
  before.periods.push({ ...before.periods[0], gameId: 'star-rail' })
  const catalog = { schemaVersion: 2, revision: 'old', publishedAt: at(1), games: [
    { gameId: 'genshin', upserts: [{ title: 'old' }] }, { gameId: 'star-rail', upserts: [] }] }
  const after = structuredClone(before), nextCatalog = structuredClone(catalog)
  after.periods[0].endsAt = at(28); nextCatalog.games[0].upserts[0].title = 'new'; nextCatalog.revision = 'new'
  assert.doesNotThrow(() => assertCloudGamePublication('genshin', before, after, catalog, nextCatalog))
  for (const mutate of [s => { s.activatedAt = at(2) }, s => { s.periods[1].endsAt = at(28) },
    s => { s.dateTriggers.push(dateTrigger({ gameId: 'star-rail', date: '2026-11-29' })) },
    s => { s.scheduleGaps.push({ gameId: 'star-rail', periodKey: null, reason: 'gap', checkedSources: [source], checkedAt: at(1) }) }]) {
    const invalid = structuredClone(after); mutate(invalid)
    assert.throws(() => assertCloudGamePublication('genshin', before, invalid, catalog, nextCatalog), /Another game/)
  }
  nextCatalog.games[1].upserts.push({ title: 'wrong game' })
  assert.throws(() => assertCloudGamePublication('genshin', before, after, catalog, nextCatalog), /Another game/)
})

test('only version-change and second-half days permit maintenance', () => {
  for (const day of [5, 11, 13, 15, 28, 30]) assert.deepEqual(planMaintenance(fixture(), at(day)).due, [])
  assert.deepEqual(planMaintenance(fixture(), at(12)).due.map(task => task.node), ['first_half_end'])
  const next = planMaintenance(fixture(), at(29))
  assert.deepEqual(next.due.map(task => task.node), ['first_half_end', 'version_end'])
  assert.equal(next.due[0].carriedOver, true)
})
test('maintenance days use Asia Shanghai and never execute before the boundary', () => {
  assert.equal(planMaintenance(fixture(), '2026-11-12T15:59:59.999Z').due.length, 1)
  assert.equal(planMaintenance(fixture(), '2026-11-12T16:00:00Z').due.length, 0)
  assert.equal(planMaintenance(fixture(), '2026-11-12T02:56:00Z').due.length, 0)
  assert.deepEqual(planMaintenance(fixture(), '2026-11-12T03:04:00Z').maintenanceTargets, ['genshin'])
})
test('a missing phase is not invented and a verified half day works without a version end', () => {
  const state = fixture(); state.periods[0].firstHalfEndsAt = null; state.periods[0].firstHalfSources = []
  assert.equal(planMaintenance(state, at(24)).nextWake.at, new Date(at(29)).toISOString())
  const half = fixture(); half.periods[0].endsAt = null; half.periods[0].startsAt = null; half.periods[0].versionSources = []
  assert.deepEqual(planMaintenance(half, at(12)).maintenanceTargets, ['genshin'])
  half.periods[0].firstHalfEndsAt = null; half.periods[0].firstHalfSources = []
  assert.throws(() => validateState(half), /verified trigger date/)
})
test('an announced date schedules that day without inventing an official timestamp', () => {
  const state = fixture(); state.periods[0].endsAt = null; state.dateTriggers = [dateTrigger()]
  const before = structuredClone(state), plan = planMaintenance(state, at(15))
  assert.equal(plan.nextWake.at, new Date(at(22)).toISOString())
  assert.equal(plan.upcoming[0].timePrecision, 'date')
  assert.deepEqual(planMaintenance(state, at(22)).maintenanceTargets, ['genshin'])
  assert.deepEqual(state, before)
  state.periods[0].firstHalfEndsAt = null; state.periods[0].firstHalfSources = []
  assert.equal(planMaintenance(state, at(5)).nextWake.at, new Date(at(22)).toISOString())
})
test('date records reject unsupported nodes, missing sources, duplicates and invalid dates', () => {
  for (const change of [{ node: 'weekly_review' }, { gameId: 'unknown' }, { sources: [] },
    { date: '2026-11-31' }, { date: '2026-11-22T11:00:00+08:00' }]) {
    const state = fixture(); state.periods[0].endsAt = null; state.dateTriggers = [dateTrigger(change)]
    assert.throws(() => validateState(state))
  }
  const state = fixture(); state.periods[0].endsAt = null; state.dateTriggers = [dateTrigger(), dateTrigger()]
  assert.throws(() => validateState(state), /Duplicate date trigger/)
})
test('precise times and date-only records must agree; source precedence remains Agent owned', () => {
  const state = fixture(); state.dateTriggers = [dateTrigger()]
  assert.throws(() => validateState(state), /Conflicting trigger date/)
  state.dateTriggers[0].date = '2026-11-29'
  assert.equal(planMaintenance(state, at(15)).upcoming[0].timePrecision, 'exact')
})
test('unknown schedules and an empty inventory never create daily or weekly polls', () => {
  const state = fixture(); state.games.push('pending-game')
  state.scheduleGaps = [{ gameId: 'pending-game', periodKey: null, reason: 'Missing timing', checkedSources: [source], checkedAt: at(1) }]
  const plan = planMaintenance(state, at(5))
  assert.deepEqual(plan.unconfiguredGames, ['pending-game'])
  assert.equal(plan.nextWake.at, new Date(at(12)).toISOString())
  assert.equal('nextReviewAfterVerification' in plan || 'scheduleReviewDue' in plan, false)
  state.periods = []
  assert.equal(planMaintenance(state, at(5)).nextWake, null)
  assert.equal(planCloudRearm(planMaintenance(state, at(5))), null)
})
test('old pending, running and ready deadlines do not schedule off-day maintenance', () => {
  for (const status of ['pending', 'running', 'ready']) {
    const state = fixture(); state.runs = [receipt(status, { retryAt: at(14) })]
    const plan = planMaintenance(state, at(15))
    assert.deepEqual(plan.due, []); assert.equal(plan.deferred.length, 1)
    assert.equal(plan.nextWake.at, new Date(at(29)).toISOString())
  }
})
test('carry-over work waits for a maintenance day of its own game', () => {
  const state = fixture(); state.runs = [receipt('pending', { retryAt: at(14) })]
  state.games.push('another-game'); state.periods.push({ ...state.periods[0], gameId: 'another-game', firstHalfEndsAt: at(15) })
  const plan = planMaintenance(state, at(15))
  assert.deepEqual(plan.maintenanceTargets, ['another-game'])
  assert.equal(plan.deferred[0].gameId, 'genshin')
  assert.deepEqual(planMaintenance(state, at(29)).due.filter(task => task.gameId === 'genshin').map(task => task.action), ['resume', 'maintain'])
})
test('an active owner is not stolen and unfinished work does not add a recovery wake', () => {
  const state = fixture(); state.runs = [receipt('running', { retryAt: '2026-11-12T13:00:00+08:00' })]
  assert.deepEqual(planMaintenance(state, at(12)).due, [])
  assert.equal(planMaintenance(state, '2026-11-12T14:00:00+08:00').due[0].action, 'resume')
  assert.equal(planMaintenance(fixture(), at(12)).nextWake.at, new Date(at(29)).toISOString())
  assert.equal(planMaintenance(fixture(), at(29)).nextWake, null)
})
test('successful work is not repeated after correction and activation skips historical nodes', () => {
  for (const status of ['published', 'verified_unchanged']) {
    const state = fixture(); state.runs = [receipt(status)]; state.periods[0].firstHalfEndsAt = at(14)
    assert.deepEqual(planMaintenance(state, at(14)).due, [])
  }
  const state = fixture(); state.activatedAt = at(13)
  assert.deepEqual(planMaintenance(state, at(29)).due.map(task => task.node), ['version_end'])
})
test('publication confirmation and evidence validation preserve existing semantics', () => {
  const state = fixture(); state.runs = [receipt('ready')]
  assert.equal(planMaintenance(state, at(12)).due[0].action, 'confirm_publication')
  for (const field of ['evidencePath', 'catalogRevision', 'catalogSha256', 'completedAt']) {
    assert.throws(() => validateState({ ...state, runs: [receipt('published', { [field]: null })] }))
  }
  assert.throws(() => validateState({ ...state, runs: [receipt('ready', { completedAt: at(13) })] }))
})
test('state rejects stale polling fields and malformed records', () => {
  assert.throws(() => validateState({ ...fixture(), nextScheduleReviewAt: at(5) }))
  const state = fixture(); state.runs = [receipt('published'), receipt('published')]
  assert.throws(() => validateState(state))
  for (const change of [{ startsAt: '2026-11-01T11:00:00' }, { firstHalfEndsAt: at(30) }, { endsAt: at(1) }, { completed: true }]) {
    const altered = fixture(); Object.assign(altered.periods[0], change); assert.throws(() => validateState(altered))
  }
})
test('Agent date corrections dynamically move the next wake without changing other nodes', () => {
  const state = fixture(); state.runs = [receipt('published')]
  assert.equal(planMaintenance(state, at(15)).nextWake.at, new Date(at(29)).toISOString())
  state.periods[0].endsAt = at(22)
  assert.equal(planMaintenance(state, at(15)).nextWake.at, new Date(at(22)).toISOString())
  state.periods[0].endsAt = null; state.dateTriggers = [dateTrigger({ date: '2026-11-24' })]
  assert.equal(planMaintenance(state, at(15)).nextWake.at, new Date(at(24)).toISOString())
  assert.equal(state.periods[0].firstHalfEndsAt, at(12))
})
test('second-half corrections move the next wake and simultaneous games share a target', () => {
  const state = fixture(); state.periods[0].firstHalfEndsAt = at(19)
  assert.equal(planMaintenance(state, at(11)).nextWake.at, new Date(at(19)).toISOString())
  state.games.push('another-game'); state.periods.push({ ...state.periods[0], gameId: 'another-game' })
  assert.equal(planMaintenance(state, at(11)).nextWake.reasons.length, 2)
})
test('cloud scheduling has exactly one occurrence and no daily fallback', () => {
  const expected = planCloudRearm(planMaintenance(fixture(), at(5)))
  assert.equal(expected.at, new Date(at(12)).toISOString())
  assert.equal(expected.maintenanceDate, '2026-11-12')
  assert.match(expected.schedule, /RRULE:FREQ=DAILY;COUNT=1/)
  assert.deepEqual(verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected)), { ok: true, at: expected.at })
})
test('precision rounds forward and an early run remains on the approved day', () => {
  const state = fixture(); state.periods[0].firstHalfEndsAt = '2026-11-12T11:00:00.285+08:00'
  assert.equal(planMaintenance(state, at(5)).nextWake.at, '2026-11-12T03:00:01.000Z')
  const expected = planCloudRearm(planMaintenance(fixture(), at(5)), '2026-11-12T02:45:00.001Z')
  assert.equal(expected.at, '2026-11-12T03:45:01.000Z')
  const early = planCloudRearm(planMaintenance(fixture(), '2026-11-12T02:56:00.285Z'))
  assert.equal(early.at, '2026-11-12T03:56:01.000Z')
  assert.equal(planMaintenance(fixture(), early.at).due[0].key, 'genshin/fixture/first_half_end')
})
test('rate limits never push a late-night node into an ordinary day', () => {
  const state = fixture(); state.periods[0].firstHalfEndsAt = '2026-11-12T23:59:00+08:00'
  const plan = planMaintenance(state, '2026-11-12T23:30:00+08:00')
  assert.equal(planCloudRearm(plan).maintenanceDate, '2026-11-29')
  state.periods[0].endsAt = null
  assert.equal(planCloudRearm(planMaintenance(state, plan.checkedAt)), null)
})
test('readback rejects stale dates, wrong tasks, disabled state, timezone drift and repetition', () => {
  const expected = planCloudRearm(planMaintenance(fixture(), at(5)))
  for (const change of [{ id: 'other' }, { enabled: false }, { timingMode: 'condition_watch' }, { timeZone: 'UTC' },
    { schedule: expected.schedule.replace('COUNT=1', 'INTERVAL=1') }, { schedule: expected.schedule.replace('COUNT=1', 'COUNT=2') },
    { schedule: expected.schedule.replace('DAILY', 'HOURLY') }, { schedule: expected.schedule.replace('20261112', '20261113') }]) {
    assert.throws(() => verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected, change)))
  }
  assert.throws(() => verifyCloudRearm('fixture-automation', { ...expected, maintenanceDate: '2026-11-13' }, cloudReceipt(expected)))
})
test('readback accepts equivalent single dates in UTC, Shanghai or the task timezone', () => {
  const expected = planCloudRearm(planMaintenance(fixture(), at(5)))
  for (const start of ['DTSTART;TZID=Asia/Shanghai:20261112T110000', 'DTSTART:20261112T030000Z', 'DTSTART:20261112T110000']) {
    const schedule = expected.schedule.replace(/^DTSTART[^\n]+/m, start).replace(/\n/g, '\r\n')
    assert.equal(verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected, { schedule })).ok, true)
  }
  for (const schedule of [expected.schedule.replace('RRULE:FREQ=DAILY;COUNT=1\n', ''), expected.schedule.replace('COUNT=1', 'COUNT=1;INTERVAL=1')]) {
    assert.equal(verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected, { schedule })).ok, true)
  }
})
test('task types are preserved until explicitly replaced', () => {
  const expected = planCloudRearm(planMaintenance(fixture(), at(5)), null, 'condition_watch')
  assert.equal(verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected)).ok, true)
  assert.throws(() => verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected, { timingMode: 'exact_schedule' })))
  assert.throws(() => planCloudRearm(planMaintenance(fixture(), at(5)), null, 'invented'))
})
test('coverage belongs to affected games and keeps partial facts distinct', () => {
  const state = fixture(); state.games.push('star-rail'); const review = reviewReceipt()
  assert.deepEqual(verifyAnnouncementReview(state, review), { ok: true, coveredGames: ['genshin'], auditComplete: true, unresolvedCount: 0 })
  review.games[0].coverage = 'partial'; review.games[0].pending = ['Missing official timing']
  assert.equal(verifyAnnouncementReview(state, review).unresolvedCount, 1)
  review.games[0].coverage = 'complete'; assert.throws(() => verifyAnnouncementReview(state, review), /Pending research/)
})
test('coverage rejects off-day games, duplicates, missing evidence and empty receipts', () => {
  for (const change of [review => review.games = [], review => review.games.push({ ...review.games[0] }),
    review => review.games[0].checkedSources = [], review => review.games[0].evidencePath = '',
    review => review.checkedAt = at(15), review => review.games[0].gameId = 'star-rail']) {
    const review = reviewReceipt(); change(review); assert.throws(() => verifyAnnouncementReview(fixture(), review))
  }
})
test('cloud publication cannot change software, permissions, workflows or product versions', () => {
  for (const path of ['AGENTS.md', 'package.json', 'src/main/ai/baseline-maintenance-policy.ts',
    'integrations/gtask/skills/sync-gtask-schedules/SKILL.md', 'docs/catalog-maintenance.md',
    '.github/workflows/verify.yml', 'automation/cloud-baseline/plan.mjs', 'catalog-research/cloud/../outside.json']) {
    assert.throws(() => assertCloudPublicationPaths([{ status: 'M', path }]))
  }
  assertCloudPublicationPaths([{ status: 'M', path: 'updates/catalog.json' }, { status: 'M', path: 'automation/cloud-baseline/state.json' },
    { status: 'A', path: 'catalog-research/cloud/fixture.json' }])
  assert.throws(() => assertCloudPublicationPaths([{ status: 'D', path: 'updates/catalog.json' }]))
})
test('saved model settings belong to the same GPT-6.1 Sol Max cloud task', () => {
  const actual = { id: 'fixture-automation', ...CLOUD_EXECUTION_PROFILE }
  assert.deepEqual(verifyCloudExecutionProfile(actual.id, actual), { ok: true, model: 'gpt-6.1-sol', reasoningEffort: 'max' })
  for (const change of [{ id: 'other' }, { model: 'gpt-6-sol' }, { model: null }, { reasoningEffort: 'high' }, { reasoningEffort: null }]) {
    assert.throws(() => verifyCloudExecutionProfile(actual.id, { ...actual, ...change }))
  }
})
