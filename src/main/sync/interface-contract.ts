import type {
  PersonalSyncTarget,
  PublicSyncContract,
  SemanticReviewContract,
  SyncRequestContext,
  SyncSectionContract,
  SyncTarget
} from '../../shared/contracts'

const DEFAULT_REQUEST_CONTEXT: SyncRequestContext = {
  outputLocale: 'zh-CN',
  userTimeZone: 'Asia/Shanghai'
}

const tasksContract: SyncSectionContract = {
  target: 'tasks',
  purpose: '校准当前游戏版本窗口，供主线任务和支线任务显示同一版本结束倒计时。',
  inventoryScope: '当前正在运行的正式游戏版本。',
  itemShapes: [{
    name: '当前版本固定任务',
    categories: ['main_quest', 'side_quest'],
    requiredFields: [
      'remoteKey',
      'category',
      'title',
      'startsAt',
      'endsAt',
      'periodKey',
      'scheduleKind',
      'timeZone',
      'titleSourceUrl',
      'sourceUrl',
      'confidence'
    ],
    conditionalFields: [],
    forbiddenFields: ['completed', 'progressPercent', 'activityTags', 'recurrenceRule']
  }],
  completionCriteria: [
    '恰好提交“主线任务”和“支线任务”两项。',
    '两项使用完全相同的 startsAt、endsAt、periodKey、scheduleKind=fixed_window 和 timeZone。',
    '时间覆盖当前版本，而不是已经结束或尚未开始的其他版本。'
  ]
}

const eventsContract: SyncSectionContract = {
  target: 'events',
  purpose: '建立当前有效、已公布即将开始以及常驻活动的完整清单和倒计时。',
  inventoryScope: '全部正在进行的限时活动、官方已经公布的即将开始活动，以及当前可用的常驻活动。',
  itemShapes: [
    {
      name: '限时活动',
      categories: ['limited_event'],
      requiredFields: [
        'remoteKey',
        'category',
        'title',
        'activityTags',
        'startsAt',
        'endsAt',
        'titleSourceUrl',
        'sourceUrl',
        'confidence'
      ],
      conditionalFields: [{
        field: 'timeZone',
        when: '来源使用本地时间或服务器时间而不是绝对时间戳时',
        meaning: '来源所采用的服务器时区；startsAt 和 endsAt 仍须换算成带偏移量的绝对时间。'
      }],
      forbiddenFields: ['completed', 'progressPercent', 'recurrenceRule']
    },
    {
      name: '常驻活动',
      categories: ['permanent_event'],
      requiredFields: [
        'remoteKey',
        'category',
        'title',
        'activityTags',
        'titleSourceUrl',
        'sourceUrl',
        'confidence'
      ],
      conditionalFields: [{
        field: 'startsAt',
        when: '存在适用于所有玩家的统一开放时间时',
        meaning: '常驻活动统一开放的绝对时间；仅由任务或等级解锁时可为 null。'
      }],
      forbiddenFields: ['endsAt', 'completed', 'progressPercent', 'recurrenceRule']
    }
  ],
  completionCriteria: [
    '先完成活动目录枚举，再逐项补齐字段，不能只搜索到少数热门活动就结束。',
    '限时活动必须同时具有准确 startsAt 和 endsAt；开始后界面自动由“距离开始”切换为“剩余”。',
    '每个活动必须具有 1 至 5 个符合 requestContext.outputLocale 的玩法标签；无法核验时使用该语言的未知表达。',
    '同一活动只能保留一个语义记录；名称或标点不同但实际相同时使用 matchItemId。'
  ]
}

const cyclesContract: SyncSectionContract = {
  target: 'cycles',
  purpose: '校准当前主要周期挑战的名称、周期窗口与模式身份；固定周常由应用机械维护。',
  inventoryScope: '当前正在进行或官方已经公布下一期的全部主要周期挑战模式。',
  itemShapes: [
    {
      name: '周期挑战',
      categories: ['endgame'],
      requiredFields: [
        'remoteKey',
        'category',
        'title',
        'modeKey',
        'periodKey',
        'startsAt',
        'endsAt',
        'titleSourceUrl',
        'sourceUrl',
        'confidence'
      ],
      conditionalFields: [{
        field: 'timeZone',
        when: '来源使用服务器本地时间时',
        meaning: '来源服务器时区；提交的起止时间仍须是绝对时间。'
      }],
      forbiddenFields: ['completed', 'progressPercent', 'activityTags', 'recurrenceRule']
    }
  ],
  completionCriteria: [
    '软件会机械补齐固定周一重置的“周常”，Codex 重点检索所有主要周期挑战。',
    '每种周期挑战使用稳定 modeKey；每一期使用独立 periodKey 和 remoteKey。',
    '深渊类事项不设置自动 recurrenceRule；新一期是新记录。'
  ]
}

const explorationContract: SyncSectionContract = {
  target: 'exploration',
  purpose: '建立游戏当前已开放的一级地区与独立地图目录，供个人数据随后合并探索度。',
  inventoryScope: '全部当前已正式开放的一级主地区，以及具有独立探索度的独立地图；普通二级子区域不进入清单。',
  itemShapes: [{
    name: '地图目录节点',
    categories: ['exploration'],
    requiredFields: [
      'remoteKey',
      'category',
      'title',
      'mapNodeKind',
      'titleSourceUrl',
      'sourceUrl',
      'confidence'
    ],
    conditionalFields: [
      {
        field: 'parentRemoteKey',
        when: '独立地图在官方目录中真实包含于某一级地区时',
        meaning: '对应一级地区的 remoteKey。'
      },
      {
        field: 'relatedRegionRemoteKey',
        when: 'independent 节点与某一级地区相关但不构成真实包含关系时',
        meaning: '关联一级地区的 remoteKey，仅用于展示归属。'
      },
      {
        field: 'parentTitle',
        when: '需要为父级关系提供显示回退名称时',
        meaning: '仅为显示回退；身份与层级以 remoteKey 为准。'
      }
    ],
    forbiddenFields: [
      'completed',
      'progressPercent',
      'startsAt',
      'endsAt',
      'activityTags',
      'recurrenceRule'
    ]
  }],
  completionCriteria: [
    '完整枚举全部一级地区与具有独立探索度的独立地图；普通二级子区域不提交。',
    '地图清单只使用 region 与 independent；不创建 subregion、group 或通用世界根节点。',
    '同一独立地图只保留一个节点，不在根目录和地区下各复制一份。',
    '公开资料只建立目录，应用机械初始化为 0%；探索度仅由个人数据或用户更新。'
  ]
}

const sectionContracts: Record<Exclude<SyncTarget, 'all'>, SyncSectionContract> = {
  tasks: tasksContract,
  events: eventsContract,
  cycles: cyclesContract,
  exploration: explorationContract
}

export function getPublicSyncContract(
  target: SyncTarget,
  requestContext: SyncRequestContext = DEFAULT_REQUEST_CONTEXT
): PublicSyncContract {
  return {
    schemaVersion: 3,
    authority: 'interface_contract',
    decisionAuthority: 'codex',
    executorPolicy: 'mechanical_validation_only',
    allowedMutations: ['create', 'update', 'archive'],
    target,
    requestContext,
    workflow: ['inventory', 'research_required_fields', 'verify', 'match_existing', 'submit'],
    commonRequiredItemFields: [
      'remoteKey',
      'category',
      'title',
      'titleSourceUrl',
      'sourceUrl',
      'confidence'
    ],
    submissionRequiredFields: [
      'agentId',
      'jobId',
      'contentLocale',
      'retrievedAt',
      'items',
      'evidence'
    ],
    fieldSemantics: {
      matchItemId: '与 matchCandidates 中现有事项语义相同时使用其 itemId；真正新增时省略。',
      remoteKey: '同一逻辑事项稳定、可重复同步的机器身份；周期挑战的每一期使用独立 remoteKey。',
      category: 'Codex 根据资料语义选择的最终版块分类。',
      title: `由 ${requestContext.outputLocale} 官方本地化资料确认的游戏内名称，不自行翻译。`,
      activityTags: `1 至 5 个使用 ${requestContext.outputLocale} 展示的实际玩法标签；无法核验时使用该语言的“未知”表达。`,
      startsAt: '活动或周期开始的绝对时刻，ISO-8601 且包含 Z 或明确 UTC 偏移量。',
      endsAt: '活动或周期结束的绝对时刻，ISO-8601 且包含 Z 或明确 UTC 偏移量。',
      periodKey: '版本或周期实例身份；同一期稳定，不同周期不能复用。',
      modeKey: '跨周期稳定的玩法模式身份。',
      mapNodeKind: '地图节点语义：当前清单只接受一级地区 region 与独立地图 independent。个人接口返回的 parentId、层级或节点类型只是观测证据，不能覆盖公开规范目录的节点类型。',
      titleSourceUrl: `能够核验 ${requestContext.outputLocale} 官方本地化名称的直接页面。`,
      sourceUrl: '能够核验该事项核心事实的直接 HTTP(S) 来源。',
      confidence: 'Codex 对该条结构化结果的 0 到 1 置信度。',
      evidence: '本次提交的交叉核验证据；至少一条，且应覆盖所提交事项。'
    },
    sections: target === 'all'
      ? [tasksContract, eventsContract, cyclesContract, explorationContract]
      : [sectionContracts[target]]
  }
}

export function getSemanticReviewContract(
  target: PersonalSyncTarget,
  requestContext: SyncRequestContext = DEFAULT_REQUEST_CONTEXT
): SemanticReviewContract {
  const targetFields: Record<PersonalSyncTarget, {
    required: string[]
    conditional: SemanticReviewContract['conditionalFields']
  }> = {
    events: {
      required: ['remoteKey', 'category', 'title'],
      conditional: [
        {
          field: 'completed',
          when: '个人接口字段语义足以确定玩家已完成或未完成时',
          meaning: '提交 true 或 false；无法证明时省略该字段，表示 unknown，并保留当前完成状态。'
        },
        {
          field: 'completionRule',
          when: '提交活动 completed 时',
          meaning: '同时声明能够从本次 observedStatus 原始字段机械复现该状态的可复用规则；应用保存到来源绑定，后续相同官方 ID 无需 Codex 重审。'
        },
        {
          field: 'activityTags',
          when: '候选最终属于 limited_event 或 permanent_event 时',
          meaning: '保留或补充实际玩法标签。'
        },
        {
          field: 'startsAt/endsAt',
          when: '个人端提供时间，或需要与公开资料项目精确合并时',
          meaning: '经 Codex 判断后的绝对活动窗口；未来活动 completed 必须为 false。'
        }
      ]
    },
    cycles: {
      required: ['remoteKey', 'category', 'title', 'completed'],
      conditional: [
        {
          field: 'modeKey/periodKey/startsAt/endsAt',
          when: '候选最终属于 endgame 时',
          meaning: '模式身份、周期身份和本期绝对时间窗口。'
        }
      ]
    },
    exploration: {
      required: ['remoteKey', 'category', 'title', 'progressPercent', 'mapNodeKind'],
      conditional: [
        {
          field: 'parentRemoteKey',
          when: '独立地图在官方目录中真实包含于某一级地区时',
          meaning: '与公开地图目录匹配后的一级地区 remoteKey。'
        },
        {
          field: 'relatedRegionRemoteKey',
          when: '独立地图仅与一级地区相关而非真实包含时',
          meaning: '关联地区 remoteKey。'
        }
      ]
    }
  }
  return {
    schemaVersion: 5,
    authority: 'interface_contract',
    decisionAuthority: 'codex',
    executorPolicy: 'mechanical_validation_only',
    allowedMutations: ['create', 'update', 'archive'],
    target,
    requestContext,
    requiredDecisionFields: targetFields[target].required,
    conditionalFields: targetFields[target].conditional,
    fieldSemantics: {
      catalogPrerequisite: '个人接口只提供观测值与进度，不决定最终清单目录。应用仅在当前版块的公开规范清单覆盖度为 complete 后开放本候选；空目录或不完整目录会先由公开资料任务建立规范项目，再将个人来源 ID 绑定到规范项目。',
      matchCandidates: '当前版块已有同步清单或与当前地图记录机械筛出的相关子集。提交前必须逐项完成身份核对；个人接口的简称、总称和 provider remoteKey 只是观察值，不代表新事项。新增前必须比较同类别候选的标题核心语义、startsAt/endsAt 时间窗和界面倒计时：名称明显重复且时间窗重叠，或倒计时相同/接近时，默认是同一事项，除非有明确证据证明它们是不同玩法。',
      matchCandidateScope: 'complete_target 表示返回当前版块全部候选；relevant_map_subset 表示地图版块已按当前名称和父级关系机械缩小范围；bound_item 表示该官方 ID 已有 Codex 确认的持久映射，只返回规范承载项。筛选只减少无关上下文，不替代 Codex 对本次状态语义的判断。',
      duplicateDetection: '同一 category 下，公开全称与个人简称、玩法名与节点后缀、标点或语序差异不能制造新事项。标题核心名称相同并且时间窗重叠或倒计时相同/接近，是强重复信号；必须优先匹配现有 public_schedule 项。只有能够说明两者实际玩法不同的明确证据，才允许省略 matchItemId 新建。',
      matchItemId: '只要候选与现有事项指向同一实际玩法或同一期内容，就必须使用现有 itemId；尤其是名称核心相同且时间窗重叠或倒计时相同/接近时。即使名称含不同前后缀、标点、节点名，modeKey 粒度不同、provider remoteKey/periodKey 不同或时间仅存在服务器时区边界差异，也不得另建重复项。存在 public_schedule 与 personal_sync 两个候选时，优先选择 public_schedule 的 itemId 作为规范承载项。',
      archiveItems: '对 matchCandidates 中已确认错误、重复或失效的同步项给出 itemId 与理由；应用只机械执行 Codex 的归档决定。如果当前版块已经同时存在同一事项的 public_schedule 与 personal_sync 重复项，必须在本次提交中保留规范项并通过 archiveItems 归档其余同步重复项，不能只更新其中一项后让重复项继续存在。',
      remoteKey: '个人来源的 remoteKey 是来源侧观察标识。匹配现有项时由 matchItemId 保留清单的规范身份，不能因 remoteKey 不同而另建重复项。',
      completed: '周期候选按接口契约提交 true 或 false。活动完成状态只能来自能够证明“当前账号已完成整个活动”的个人字段语义；公开活动说明不能证明个人完成，is_finished、all_finished、状态字符串或奖励计数也不能跨接口一概解释。证据不足时必须省略，表示 unknown，应用保留当前状态。',
      completionRule: '仅活动提交 completed 时使用。fieldPath 必须指向本次 payload.observedStatus 下的一个原始字段，并列出明确的完成值与未完成值；规则必须能机械复现本次结论，确认后会绑定到该来源接口与官方 ID，后续同步直接复用。',
      progressPercent: '仅地图探索使用，范围 0 到 100。',
      category: 'Codex 可纠正解析器初始分类；应用不再二次解释业务语义。',
      title: `使用 ${requestContext.outputLocale} 的官方本地化名称。`,
      activityTags: `使用 ${requestContext.outputLocale} 的玩法标签。`,
      evidence: '支持本次语义判断的证据或字段关系说明。'
    }
  }
}
