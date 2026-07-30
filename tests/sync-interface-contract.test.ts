import { describe, expect, it } from 'vitest'
import {
  getPublicSyncContract,
  getSemanticReviewContract
} from '../src/main/sync/interface-contract'

describe('同步接口契约', () => {
  it('全局任务明确覆盖四个可独立恢复的版块', () => {
    const contract = getPublicSyncContract('all')
    expect(contract.authority).toBe('interface_contract')
    expect(contract).toMatchObject({
      decisionAuthority: 'codex',
      executorPolicy: 'mechanical_validation_only',
      allowedMutations: ['create', 'update', 'archive']
    })
    expect(contract.workflow).toEqual([
      'inventory',
      'research_required_fields',
      'verify',
      'match_existing',
      'submit'
    ])
    expect(contract.sections.map((section) => section.target)).toEqual([
      'tasks',
      'events',
      'cycles',
      'exploration'
    ])
  })

  it('所有游戏和版块共用语言与时区请求上下文', () => {
    const requestContext = {
      outputLocale: 'en-US',
      userTimeZone: 'America/Los_Angeles'
    }
    for (const target of ['all', 'tasks', 'events', 'cycles', 'exploration'] as const) {
      const contract = getPublicSyncContract(target, requestContext)
      expect(contract.requestContext).toEqual(requestContext)
      expect(contract.fieldSemantics.title).toContain('en-US')
      expect(contract.submissionRequiredFields).toContain('contentLocale')
    }
    expect(getSemanticReviewContract('events', requestContext)).toMatchObject({
      requestContext,
      decisionAuthority: 'codex',
      executorPolicy: 'mechanical_validation_only'
    })
  })

  it('活动契约只接受具有完整时间窗的限时活动', () => {
    const [events] = getPublicSyncContract('events').sections
    const limited = events.itemShapes.find((shape) =>
      shape.categories.includes('limited_event')
    )!

    expect(events.itemShapes).toHaveLength(1)
    expect(limited.requiredFields).toEqual(expect.arrayContaining([
      'activityTags',
      'startsAt',
      'endsAt'
    ]))
    const criteria = events.completionCriteria.join('；')
    expect(criteria).toContain('限时签到')
    expect(criteria).toContain('活动商店')
    expect(criteria).toContain('角色或武器卡池')
    expect(criteria).toContain('交叉核验')
    expect(criteria).toContain('不得猜测')
  })

  it('周期与地图契约只向 Codex 请求应用不能机械补齐的数据', () => {
    const [cycles] = getPublicSyncContract('cycles').sections
    expect(cycles.itemShapes).toHaveLength(1)
    expect(cycles.itemShapes[0]).toMatchObject({
      categories: ['endgame'],
      requiredFields: expect.arrayContaining([
        'modeKey',
        'periodKey',
        'startsAt',
        'endsAt'
      ])
    })
    const cycleCriteria = cycles.completionCriteria.join('；')
    expect(cycleCriteria).toContain('深境螺旋')
    expect(cycleCriteria).toContain('混沌回忆')
    expect(cycleCriteria).toContain('式舆防卫战')
    expect(cycleCriteria).toContain('某一层')
    expect(cycleCriteria).toContain('不得猜测')

    const [exploration] = getPublicSyncContract('exploration').sections
    expect(exploration.itemShapes[0].requiredFields).toContain('mapNodeKind')
    expect(exploration.itemShapes[0].forbiddenFields).toEqual(
      expect.arrayContaining(['progressPercent', 'completed'])
    )
    expect(exploration.inventoryScope).toContain('顶层')
    expect(exploration.completionCriteria.join('；')).toContain('璃月')
    expect(exploration.completionCriteria.join('；')).toContain('匹诺康尼')
    expect(exploration.completionCriteria.join('；')).toContain('云陵谷')
    expect(exploration.completionCriteria.join('；')).toContain('层岩巨渊·地下矿区')
    expect(exploration.completionCriteria.join('；')).toContain('交叉核验')
    expect(exploration.completionCriteria.join('；')).toContain('不得猜测')
    expect(getPublicSyncContract('exploration').fieldSemantics.mapNodeKind)
      .toContain('单独 Wiki 页面')
  })

  it('版更校时明确排除卡池、活动和维护期限', () => {
    const [tasks] = getPublicSyncContract('tasks').sections
    const criteria = tasks.completionCriteria.join('；')

    expect(tasks.inventoryScope).toContain('版本阶段')
    expect(criteria).toContain('下半卡池')
    expect(criteria).toContain('维护补偿')
    expect(criteria).toContain('不得猜测')
  })

  it('个人进度契约按版块声明最终决策字段', () => {
    expect(getSemanticReviewContract('events').requiredDecisionFields)
      .toEqual(expect.arrayContaining(['remoteKey', 'category', 'title']))
    expect(getSemanticReviewContract('events').requiredDecisionFields)
      .not.toContain('completed')
    expect(getSemanticReviewContract('cycles').requiredDecisionFields)
      .toEqual(expect.arrayContaining(['category', 'completed']))
    expect(getSemanticReviewContract('exploration').requiredDecisionFields)
      .toEqual(expect.arrayContaining(['mapNodeKind', 'progressPercent']))
    expect(getSemanticReviewContract('exploration').fieldSemantics.mapNodeKind)
      .toContain('禁止猜测')
    expect(getSemanticReviewContract('events').fieldSemantics.itemIdentity)
      .toContain('活动商店')
    expect(getSemanticReviewContract('cycles').fieldSemantics.itemIdentity)
      .toContain('periodKey')
    expect(getSemanticReviewContract('exploration').fieldSemantics.itemIdentity)
      .toContain('层岩巨渊·地下矿区')
  })

  it('个人同步把同名且倒计时重叠的周期项视为强重复信号', () => {
    const contract = getSemanticReviewContract('cycles')

    expect(contract.fieldSemantics.matchCandidates).toContain('倒计时')
    expect(contract.fieldSemantics.duplicateDetection).toContain('标题核心名称相同')
    expect(contract.fieldSemantics.duplicateDetection).toContain('时间窗重叠')
    expect(contract.fieldSemantics.matchItemId).toContain('public_schedule')
    expect(contract.fieldSemantics.archiveItems).toContain('personal_sync')
    expect(contract.fieldSemantics.archiveItems).toContain('归档')
  })
})
