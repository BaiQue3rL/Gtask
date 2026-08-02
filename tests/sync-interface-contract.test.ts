import { describe, expect, it } from 'vitest'
import {
  getPublicSyncContract,
  getPersonalMetadataContract,
  getPersonalReviewContract
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
      'cycles'
    ])
  })

  it('活动契约只接受具有完整时间窗的限时活动', () => {
    const [events] = getPublicSyncContract('events').sections
    const limited = events.itemShapes.find((shape) =>
      shape.categories.includes('limited_event')
    )!

    expect(events.itemShapes).toHaveLength(1)
    expect(limited.requiredFields).toEqual(expect.arrayContaining(['startsAt', 'endsAt']))
    expect(limited.requiredFields).not.toContain('activityTags')
    const criteria = events.completionCriteria.join('；')
    expect(criteria).toContain('限时签到')
    expect(criteria).toContain('活动商店')
    expect(criteria).toContain('角色或武器卡池')
    expect(criteria).toContain('交叉核验')
    expect(criteria).toContain('不得猜测')
    expect(getPublicSyncContract('events').fieldSemantics.activityTags)
      .toContain('不得写入“活动”“限时活动”“常驻活动”等版块分类')
    expect(getPublicSyncContract('events').fieldSemantics.activityTags)
      .toContain('词汇表，不是待分配清单')
    expect(getPublicSyncContract('events').fieldSemantics.activityTags)
      .toContain('留空优于猜测')
    expect(getPublicSyncContract('events').activityTagCatalog)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'combat', qualityRole: 'primary' }),
        expect.objectContaining({ id: 'challenge', qualityRole: 'supporting' })
      ]))
  })

  it('个人活动审核明确在快照激活后运行且不阻塞首次建表', () => {
    const contract = getPersonalReviewContract('events')
    expect(contract.allowedMutations).toEqual(['refine_active_personal_snapshot'])
    expect(contract.workflow).toContain('refine_active_snapshot')
    expect(contract.fieldSemantics.reviewTargets).toContain('已经先行写入')
    expect(contract.completionCriteria.join('；')).toContain('不得阻塞')
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
    expect(exploration.inventoryScope).toContain('matchCandidates')
    expect(exploration.inventoryScope).toContain('不要重新提交')
    expect(exploration.completionCriteria.join('；')).toContain('允许提交空 items')
    expect(exploration.inventoryScope).toContain('一级主地区')
    expect(exploration.completionCriteria.join('；')).toContain('璃月')
    expect(exploration.completionCriteria.join('；')).toContain('匹诺康尼')
    expect(exploration.completionCriteria.join('；')).toContain('云陵谷')
    expect(exploration.completionCriteria.join('；')).toContain('层岩巨渊·地下矿区')
    expect(exploration.completionCriteria.join('；')).toContain('交叉核验')
    expect(exploration.completionCriteria.join('；')).toContain('不得猜测')
    expect(getPublicSyncContract('exploration').fieldSemantics.mapNodeKind)
      .toContain('不得提交第三种节点')
  })

  it('版更校时明确排除卡池、活动和维护期限', () => {
    const [tasks] = getPublicSyncContract('tasks').sections
    const criteria = tasks.completionCriteria.join('；')

    expect(tasks.inventoryScope).toContain('版本阶段')
    expect(criteria).toContain('下半卡池')
    expect(criteria).toContain('维护补偿')
    expect(criteria).toContain('不得猜测')
  })

  it('个人元数据契约只允许补标签和缺失时间', () => {
    const events = getPersonalMetadataContract('events')
    expect(events).toMatchObject({
      jobKind: 'personal_metadata',
      allowedMutations: ['update_metadata'],
      executorPolicy: 'mechanical_validation_only'
    })
    expect(events.fieldSemantics.activityTags).toContain('zh-CN')
    expect(events.fieldSemantics.activityTags).toContain('不得提交活动版块分类')
    expect(events.fieldSemantics.activityTags).toContain('词汇表，不是待分配清单')
    expect(events.fieldSemantics.unresolvedFields).toContain('活动标签')
    expect(events.fieldSemantics.activityTagEvidence).toContain('可选')
    expect(events.completionCriteria.join('；')).toContain('不得修改 completed')
    const cycles = getPersonalMetadataContract('cycles')
    expect(cycles.completionCriteria.join('；'))
      .toContain('周期事项只补齐缺失起止时间')
    expect(cycles.fieldSemantics.endsAt).toContain('timeWindowPolicy')
    expect(cycles.completionCriteria.join('；')).toContain('metadataTargets.timeWindowPolicy')
  })

  it('个人异常契约明确隔离公开清单并只处理最小异常集合', () => {
    for (const target of ['events', 'cycles', 'exploration'] as const) {
      const contract = getPersonalReviewContract(target)
      expect(contract).toMatchObject({
        jobKind: 'personal_review',
        target,
        allowedMutations: ['refine_active_personal_snapshot'],
        executorPolicy: 'mechanical_validation_only'
      })
      expect(contract.fieldSemantics.sourceIsolation).toContain('不得读取')
      expect(contract.completionCriteria.join('；')).toContain('逐项处理全部')
    }
    expect(getPersonalReviewContract('events').fieldSemantics.completionRule)
      .toContain('observedStatus')
    expect(getPersonalReviewContract('events').fieldSemantics.activityTags)
      .toContain('不得提交活动版块分类')
    expect(getPersonalReviewContract('exploration').fieldSemantics.parentExternalId)
      .toContain('官方个人响应')
  })

})
