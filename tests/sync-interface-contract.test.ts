import { describe, expect, it } from 'vitest'
import { getPublicSyncContract } from '../src/main/sync/interface-contract'

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
    expect(limited.requiredFields).toEqual(expect.arrayContaining([
      'startsAt', 'endsAt', 'activityTags'
    ]))
    const criteria = events.completionCriteria.join('；')
    expect(criteria).toContain('限时签到')
    expect(criteria).toContain('活动商店')
    expect(criteria).toContain('角色或武器卡池')
    expect(criteria).toContain('交叉核验')
    expect(criteria).toContain('不得猜测')
    expect(criteria).toContain('只提交新增、确需修正或确认失效的活动')
    expect(criteria).toContain('verifiedUnchangedTargets')
    expect(getPublicSyncContract('events').fieldSemantics.activityTags)
      .toContain('不得写入“活动”“限时活动”“常驻活动”等版块分类')
    expect(getPublicSyncContract('events').fieldSemantics.activityTags)
      .toContain('词汇表，不是待分配清单')
    expect(getPublicSyncContract('events').fieldSemantics.activityTags)
      .toContain('每个活动必须')
    expect(getPublicSyncContract('events').activityTagCatalog)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'combat', qualityRole: 'primary' }),
        expect.objectContaining({ id: 'challenge', qualityRole: 'supporting' })
      ]))
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
    expect(cycleCriteria).toContain('提交空 items')
    expect(cycleCriteria).toContain('永久复用同一个 modeKey 和 remoteKey')
    expect(cycleCriteria).toContain('普通新一期不是新记录')
    expect(getPublicSyncContract('cycles').fieldSemantics.remoteKey)
      .toContain('禁止拼接日期')

    const [exploration] = getPublicSyncContract('exploration').sections
    expect(exploration.itemShapes[0].requiredFields).toContain('mapNodeKind')
    expect(exploration.itemShapes[0].forbiddenFields).toEqual(
      expect.arrayContaining(['progressPercent', 'completed'])
    )
    expect(exploration.inventoryScope).toContain('matchCandidates')
    expect(exploration.inventoryScope).toContain('不要重新提交')
    expect(exploration.completionCriteria.join('；')).toContain('提交空 items')
    expect(exploration.completionCriteria.join('；')).toContain('verifiedUnchangedTargets')
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

  it('版更校时优先官方时间并允许可靠暂定值，且排除卡池、活动和维护期限', () => {
    const [tasks] = getPublicSyncContract('tasks').sections
    const criteria = tasks.completionCriteria.join('；')

    expect(tasks.inventoryScope).toContain('版本阶段')
    expect(tasks.inventoryScope).toContain('可靠预计')
    expect(criteria).toContain('下半卡池')
    expect(criteria).toContain('维护补偿')
    expect(criteria).toContain('不得仅因此结束为失败')
    expect(criteria).toContain('较低 confidence')
    expect(criteria).toContain('暂定时间不是任意猜测')
    expect(criteria).toContain('同一 periodKey')
    expect(criteria).toContain('未变化时用 verifiedUnchangedTargets')
    expect(criteria).toContain('不得为了表示“已核查”而重复写入相同窗口')
    expect(getPublicSyncContract('tasks').fieldSemantics.endsAt).toContain('可靠暂定值')
    expect(getPublicSyncContract('tasks').fieldSemantics.catalogBaseline)
      .toContain('只提交相对基准的新增、删除或字段修正')
    expect(getPublicSyncContract('tasks').fieldSemantics.verifiedUnchangedTargets)
      .toContain('已核查但无需写入')
  })

})
