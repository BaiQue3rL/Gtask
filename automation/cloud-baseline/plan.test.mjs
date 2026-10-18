import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planMaintenance, validateState, runKey, assertCloudPublicationPaths } from './plan.mjs'

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
