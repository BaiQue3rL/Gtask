import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planMaintenance, validateState, runKey, assertCloudPublicationPaths, planCloudRearm, verifyCloudRearm } from './plan.mjs'

const at = day => `2026-11-${String(day).padStart(2, '0')}T11:00:00+08:00`
const source = 'https://example.com/official-fixture'
function fixture() {
  return { schemaVersion: 1, repository: 'BaiQue3rL/Gtask', timeZone: 'Asia/Shanghai', activatedAt: at(1), games: ['genshin'],
    nextScheduleReviewAt: at(30), scheduleGaps: [], runs: [], periods: [{ gameId: 'genshin', periodKey: 'fixture',
      startsAt: at(1), endsAt: at(29), firstHalfEndsAt: at(12), versionSources: [source], firstHalfSources: [source], checkedAt: at(1) }] }
}
function receipt(status, overrides = {}) {
  return { key: runKey('genshin', 'fixture', 'first_half_end'), gameId: 'genshin', periodKey: 'fixture', node: 'first_half_end',
    boundaryAt: at(12), status, attempts: 1, updatedAt: at(12), retryAt: null, branch: 'codex/cloud-baseline/fixture',
    pullRequestUrl: 'https://github.com/BaiQue3rL/Gtask/pull/999', catalogRevision: 'fixture', catalogSha256: 'a'.repeat(64),
    evidencePath: 'catalog-research/cloud/fixture.json', completedAt: ['published', 'verified_unchanged'].includes(status) ? at(12) : null,
    notes: '', ...overrides }
}
test('only the two recorded boundaries trigger, including a delayed poll', () => {
  const state = fixture()
  assert.equal(planMaintenance(state, at(11)).due.length, 0)
  assert.deepEqual(planMaintenance(state, at(15)).due.map(x => x.node), ['first_half_end'])
  assert.deepEqual(planMaintenance(state, at(30)).due.map(x => x.node), ['first_half_end', 'version_end'])
})
test('does not assume a 21-day half or invent a missing phase', () => {
  const state = fixture(); state.periods[0].firstHalfEndsAt = null; state.periods[0].firstHalfSources = []
  assert.equal(planMaintenance(state, at(24)).due.length, 0)
})
test('a verified first-half boundary still triggers when the version end is unknown', () => {
  const state = fixture(); state.periods[0].endsAt = null
  assert.deepEqual(planMaintenance(state, at(15)).due.map(x => x.node), ['first_half_end'])
  state.periods[0].startsAt = null; state.periods[0].versionSources = []
  assert.deepEqual(planMaintenance(state, at(15)).due.map(x => x.node), ['first_half_end'])
  state.periods[0].firstHalfEndsAt = null; state.periods[0].firstHalfSources = []
  assert.throws(() => validateState(state))
})
test('a recorded scheduling gap waits until its review time without inventing missing nodes', () => {
  const state = fixture(); state.games.push('pending-game')
  state.scheduleGaps = [{ gameId: 'pending-game', periodKey: null, reason: 'Missing official timing', checkedSources: [source], checkedAt: at(1) }]
  const result = planMaintenance(state, at(11))
  assert.equal(result.scheduleReviewDue, false)
  assert.deepEqual(result.unconfiguredGames, ['pending-game'])
  assert.equal(result.due.length, 0)
})
test('ignores boundaries before activation rather than replaying historical versions', () => {
  const state = fixture(); state.activatedAt = at(13)
  assert.deepEqual(planMaintenance(state, at(30)).due.map(x => x.node), ['version_end'])
})
test('a published or verified unchanged node is not repeated after schedule correction', () => {
  for (const status of ['published', 'verified_unchanged']) {
    const state = fixture(); state.runs = [receipt(status)]; state.periods[0].firstHalfEndsAt = at(14)
    assert.equal(planMaintenance(state, at(15)).due.length, 0)
  }
})
test('retries pending work and resumes expired leases without duplicating a node', () => {
  for (const status of ['pending', 'running']) {
    const state = fixture(); state.runs = [receipt(status, { retryAt: at(14) })]
    assert.equal(planMaintenance(state, at(13)).due.length, 0)
    assert.equal(planMaintenance(state, at(15)).due[0].action, 'resume')
  }
})
test('ready means confirm publication, not audit success', () => {
  const state = fixture(); state.runs = [receipt('ready')]
  assert.equal(planMaintenance(state, at(15)).due[0].action, 'confirm_publication')
  assert.throws(() => validateState({ ...state, runs: [receipt('ready', { completedAt: at(13) })] }))
})
test('completion requires evidence, catalog identity and receipt time', () => {
  for (const field of ['evidencePath', 'catalogRevision', 'catalogSha256', 'completedAt']) {
    const state = fixture(); state.runs = [receipt('published', { [field]: null })]
    assert.throws(() => validateState(state))
  }
})
test('rejects duplicate nodes, time without timezone, reversed windows and unsupported metadata', () => {
  const state = fixture(); state.runs = [receipt('published'), receipt('published')]
  assert.throws(() => validateState(state))
  for (const change of [{ startsAt: '2026-11-01T11:00:00' }, { firstHalfEndsAt: at(30) }, { endsAt: at(1) }, { completed: true }]) {
    const altered = fixture(); Object.assign(altered.periods[0], change)
    assert.throws(() => validateState(altered))
  }
})
test('preserves each game and identifies missing scheduling evidence', () => {
  const state = fixture(); state.games.push('future-game'); state.nextScheduleReviewAt = null
  const result = planMaintenance(state, at(15))
  assert.equal(result.scheduleReviewDue, true)
  assert.deepEqual(result.unconfiguredGames, ['future-game'])
})
test('a seven-day shorter version moves the next wake without changing other periods', () => {
  const state = fixture(); state.runs = [receipt('published')]
  state.periods.push({ ...state.periods[0], periodKey: 'later', startsAt: null,
    firstHalfEndsAt: null, firstHalfSources: [], endsAt: '2026-12-31T11:00:00+08:00' })
  assert.equal(planMaintenance(state, at(15)).nextWake.at, new Date(at(29)).toISOString())
  state.periods[0].endsAt = at(22)
  const before = structuredClone(state)
  assert.deepEqual(planMaintenance(state, at(15)).nextWake, {
    at: new Date(at(22)).toISOString(), reasons: [{ type: 'maintenance', key: 'genshin/fixture/version_end' }] })
  assert.deepEqual(state, before)
})
test('an extended first half postpones its wake instead of retaining the old date', () => {
  const state = fixture()
  assert.equal(planMaintenance(state, at(11)).nextWake.at, new Date(at(12)).toISOString())
  state.periods[0].firstHalfEndsAt = at(19)
  assert.equal(planMaintenance(state, at(11)).nextWake.at, new Date(at(19)).toISOString())
  assert.equal(state.periods[0].endsAt, at(29))
})
test('one wake covers the earliest verified nodes across games, including simultaneous nodes', () => {
  const state = fixture(); state.games.push('another-game')
  state.periods.push({ ...state.periods[0], gameId: 'another-game', firstHalfEndsAt: at(10) })
  assert.equal(planMaintenance(state, at(5)).nextWake.at, new Date(at(10)).toISOString())
  state.periods[1].firstHalfEndsAt = at(12)
  const next = planMaintenance(state, at(5)).nextWake
  assert.equal(next.at, new Date(at(12)).toISOString())
  assert.deepEqual(next.reasons.map(x => x.key).sort(), ['another-game/fixture/first_half_end', 'genshin/fixture/first_half_end'])
})
test('a recorded review wakes before a later business node without hourly polling', () => {
  const state = fixture(); state.nextScheduleReviewAt = at(8)
  assert.deepEqual(planMaintenance(state, at(5)).nextWake, {
    at: new Date(at(8)).toISOString(), reasons: [{ type: 'schedule_review' }] })
})
test('pending retries and running leases schedule their next actual opportunity', () => {
  for (const status of ['pending', 'running']) {
    const state = fixture(); state.runs = [receipt(status, { retryAt: at(14) })]
    assert.deepEqual(planMaintenance(state, at(13)).nextWake, {
      at: new Date(at(14)).toISOString(), reasons: [{ type: 'retry', key: 'genshin/fixture/first_half_end' }] })
    state.periods[0].firstHalfEndsAt = at(16)
    assert.equal(planMaintenance(state, at(13)).nextWake.at, new Date(at(16)).toISOString())
    state.runs[0].retryAt = at(18)
    assert.equal(planMaintenance(state, at(13)).nextWake.at, new Date(at(18)).toISOString())
  }
})
test('unfinished work schedules a bounded recovery, then successful delivery advances the wake', () => {
  const state = fixture(), now = new Date(at(15))
  assert.deepEqual(planMaintenance(state, now).nextWake, {
    at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    reasons: [{ type: 'unfinished_work', key: 'genshin/fixture/first_half_end' }] })
  state.runs = [receipt('verified_unchanged')]
  assert.equal(planMaintenance(state, now).nextWake.at, new Date(at(29)).toISOString())
})
test('overdue or missing reviews get a future recovery wake, never an expired one-shot', () => {
  for (const review of [null, at(1)]) {
    const state = fixture(); state.nextScheduleReviewAt = review
    const now = new Date(at(5)), result = planMaintenance(state, now)
    assert.equal(result.scheduleReviewDue, true)
    assert.deepEqual(result.nextWake, { at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      reasons: [{ type: 'schedule_review' }] })
  }
})
test('scheduler precision rounds forward without waking before the verified time', () => {
  const state = fixture(); state.nextScheduleReviewAt = '2026-11-08T03:00:00.285Z'
  assert.equal(planMaintenance(state, at(5)).nextWake.at, '2026-11-08T03:00:01.000Z')
})
function cloudReceipt(expected, overrides = {}) {
  return { id: 'fixture-automation', enabled: true, timingMode: expected.timingMode,
    timeZone: 'Asia/Shanghai', schedule: expected.schedule, ...overrides }
}
test('direct scheduling keeps a daily recovery guard anchored to the next node', () => {
  const expected = planCloudRearm(planMaintenance(fixture(), at(5)))
  assert.equal(expected.timingMode, 'exact_schedule')
  assert.equal(expected.at, new Date(at(12)).toISOString())
  assert.match(expected.schedule, /DTSTART;TZID=Asia\/Shanghai:20261112T110000/)
  assert.match(expected.schedule, /RRULE:FREQ=DAILY;INTERVAL=1/)
  assert.deepEqual(verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected)), { ok: true, at: expected.at })
})
test('self-rearming cannot bypass the cloud task hourly rate limit', () => {
  const plan = planMaintenance(fixture(), at(5))
  const lastRun = '2026-11-12T02:45:00.001Z', expected = planCloudRearm(plan, lastRun)
  assert.equal(expected.requestedAt, '2026-11-12T03:00:00.000Z')
  assert.equal(expected.at, '2026-11-12T03:45:01.000Z')
})
test('a seven-day correction fails readback verification until the real timer is moved', () => {
  const state = fixture(), old = planCloudRearm(planMaintenance(state, at(5)))
  state.periods[0].firstHalfEndsAt = at(19)
  const expected = planCloudRearm(planMaintenance(state, at(5)))
  assert.throws(() => verifyCloudRearm('fixture-automation', expected, cloudReceipt(old)), /old or shifted wake time/)
  assert.equal(verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected)).ok, true)
})
test('schedule readback rejects another task, disabled state, wrong timezone, wrong type and hourly polling', () => {
  const expected = planCloudRearm(planMaintenance(fixture(), at(5)))
  for (const change of [{ id: 'other' }, { enabled: false }, { timingMode: 'condition_watch' },
    { timeZone: 'UTC' }, { schedule: expected.schedule.replace('FREQ=DAILY', 'FREQ=HOURLY') },
    { schedule: expected.schedule.replace('RRULE:FREQ=DAILY;INTERVAL=1\n', '') }]) {
    assert.throws(() => verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected, change)))
  }
})
test('cloud schedule normalization accepts CRLF and an omitted default interval only', () => {
  const expected = planCloudRearm(planMaintenance(fixture(), at(5)))
  assert.equal(verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected,
    { schedule: expected.schedule.replace(';INTERVAL=1', '').replace(/\n/g, '\r\n') })).ok, true)
  for (const suffix of [';BYHOUR=8', ';COUNT=1', ';INTERVAL=2']) {
    assert.throws(() => verifyCloudRearm('fixture-automation', expected,
      cloudReceipt(expected, { schedule: expected.schedule.replace(';INTERVAL=1', suffix) })))
  }
})
test('readback compares actual instants across IANA, UTC and task-timezone representations', () => {
  const expected = planCloudRearm(planMaintenance(fixture(), at(5)))
  for (const start of ['DTSTART;TZID=Asia/Shanghai:20261112T110000',
    'DTSTART:20261112T030000Z', 'DTSTART:20261112T110000']) {
    const schedule = expected.schedule.replace(/^DTSTART[^\n]+/m, start)
    assert.equal(verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected, { schedule })).ok, true)
  }
  for (const start of ['DTSTART:20261112T030000', 'DTSTART;TZID=UTC:20261112T030000',
    'DTSTART;TZID=Asia/Shanghai:20261112T110000Z']) {
    const schedule = expected.schedule.replace(/^DTSTART[^\n]+/m, start)
    assert.throws(() => verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected, { schedule })))
  }
})
test('legacy watches retain their actual type until an explicit replacement is verified', () => {
  const expected = planCloudRearm(planMaintenance(fixture(), at(5)), null, 'condition_watch')
  assert.equal(verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected)).ok, true)
  assert.throws(() => verifyCloudRearm('fixture-automation', expected, cloudReceipt(expected, { timingMode: 'exact_schedule' })))
  assert.throws(() => planCloudRearm(planMaintenance(fixture(), at(5)), null, 'invented'))
})
test('cloud publication cannot alter local maintenance rules, runtime, workflows or versions', () => {
  for (const path of ['AGENTS.md', 'package.json', 'src/main/ai/baseline-maintenance-policy.ts',
    'integrations/gtask/skills/sync-gtask-schedules/SKILL.md', 'docs/catalog-maintenance.md',
    '.github/workflows/verify.yml', 'automation/cloud-baseline/plan.mjs', 'catalog-research/cloud/../outside.json']) {
    assert.throws(() => assertCloudPublicationPaths([{ status: 'M', path }]))
  }
  assertCloudPublicationPaths([{ status: 'M', path: 'updates/catalog.json' },
    { status: 'M', path: 'automation/cloud-baseline/state.json' }, { status: 'A', path: 'catalog-research/cloud/fixture.json' }])
  assert.throws(() => assertCloudPublicationPaths([{ status: 'D', path: 'updates/catalog.json' }]))
})
