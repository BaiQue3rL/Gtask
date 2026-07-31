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
  inventoryScope:
    '当前正在运行的正式游戏版本及其全服版本结束时刻；版本阶段、卡池阶段和单个活动窗口不属于版本窗口。',
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
    '时间覆盖当前版本，而不是已经结束或尚未开始的其他版本。',
    '正例是官方版本更新公告、版本专题或能够证明整个版本起止时间的排期资料；反例是下半卡池开始时间、单个活动结束时间、维护补偿领取期限和前瞻直播时间。',
    '若官方公告出现延期、提前更新或来源时区不明，必须交叉核验最新公告与服务器时区；仍不能确认整个版本结束时刻时不得猜测或提交。'
  ]
}

const eventsContract: SyncSectionContract = {
  target: 'events',
  purpose: '建立当前有效及官方已公布即将开始的限时活动清单和倒计时。',
  inventoryScope:
    '全部正在进行的限时活动，以及官方已经公布的即将开始限时活动。这里的“活动”是面向玩家、具有独立官方活动名称和整体参与窗口的活动容器，包括限时签到、战斗、剧情、经营或小游戏活动；不是活动内部的单个阶段、关卡、任务或奖励节点。',
  itemShapes: [{
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
  }],
  completionCriteria: [
    '先完成活动目录枚举，再逐项补齐字段，不能只搜索到少数热门活动就结束。',
    '限时活动正例：具有独立官方活动名称、整体开始时间和整体结束时间的限时签到、限时玩法或限时剧情活动。',
    '限时活动反例：活动内部的每日阶段、单个关卡、剧情任务、活动商店、奖励档位、版本前瞻、维护公告、兑换码和角色或武器卡池；这些不能作为新的活动清单项。',
    '同一活动的预告页、规则页、玩法页和奖励页只是同一活动的不同资料，不得分别建项；标题应使用活动容器的官方本地化总名称。',
    '限时活动必须同时具有准确 startsAt 和 endsAt；开始后界面自动由“距离开始”切换为“剩余”。',
    '每个活动必须具有 1 至 5 个符合 requestContext.outputLocale 的玩法标签；无法核验时使用该语言的未知表达。',
    '同一活动只能保留一个语义记录；名称或标点不同但实际相同时使用 matchItemId。',
    '如果无法确认某个名称是整体活动还是内部阶段，或不同页面是否属于同一活动，必须结合官方活动规则、时间窗口和至少一个独立可靠来源交叉核验；仍无法确认则不得猜测或提交。'
  ]
}

const cyclesContract: SyncSectionContract = {
  target: 'cycles',
  purpose: '校准当前主要周期挑战的名称、周期窗口与模式身份；固定周常由应用机械维护。',
  inventoryScope:
    '当前正在进行或官方已经公布下一期的全部主要周期挑战模式及其当期实例。周期挑战是具有独立模式入口、重复结算周期和个人挑战进度的主要常驻终局玩法；单层、单节点、单阶段或当期增益不是独立模式。',
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
    '模式正例：原神“深境螺旋”“幻想真境剧诗”、星铁“混沌回忆”“虚构叙事”“末日幻影”、绝区零“式舆防卫战”“危局强袭战”等具有独立入口和重复周期的主要挑战。',
    '模式反例：某一层、节点、关卡、难度、当期增益、敌人阵容、奖励档位、周常首领、体力副本或限时活动挑战；这些不能作为新的周期模式。',
    '每种周期挑战使用稳定 modeKey；每一期使用独立 periodKey 和 remoteKey。',
    '同一模式的本期标题、副标题或期数属于 periodKey 对应的周期实例，不得因为标题变化创建新的 modeKey；不同模式即使时间窗相同也不得合并。',
    '周期 startsAt/endsAt 必须是该期挑战开放与结算窗口，不是奖励领取期限、单个阶段开放时间或版本结束时间。',
    '无法确认某内容是独立周期模式还是模式内部阶段时，必须交叉核验官方玩法入口、周期说明和可靠社区资料；仍无法确认则不得猜测或提交。',
    '深渊类事项不设置自动 recurrenceRule；新一期是新记录。'
  ]
}

const explorationContract: SyncSectionContract = {
  target: 'exploration',
  purpose: '以应用提供的已核验地图基准目录为基础，只核验新版本带来的增量、改名与归属修正，供个人数据随后按稳定来源 ID 合并探索度。',
  inventoryScope:
    'matchCandidates 是应用当前完整的已核验基准目录。联网确认基准核验后新正式开放但尚未列出的一级主地区及二级地区，并检查可靠资料明确指出的改名或归属修正；不要重新提交未变化的既有目录。地图只有 region 与 subregion 两层。',
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
        when: 'mapNodeKind 为 subregion 时',
        meaning: '必填，且必须指向本次目录中唯一的一级主地区 region。'
      },
      {
        field: 'parentTitle',
        when: 'mapNodeKind 为 subregion 时',
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
    '先把 matchCandidates 视为已核验基准，按当前正式版本检查是否存在缺失的新增地区、官方改名或父级归属修正；没有变化时允许提交空 items 表示本次增量核验通过。',
    '只提交新增或确需修正的目录节点，不重复回写未变化节点；同一地点只能出现一次。',
    'region 只表示顶层主地区，例如原神“璃月”“稻妻”、星铁“匹诺康尼”、鸣潮“瑝珑”“黑海岸”“黎那汐塔”。',
    'subregion 表示归属于某个一级主地区的具体地区，例如原神“层岩巨渊·地下矿区”归于“璃月”，鸣潮“云陵谷”“今州城”归于“瑝珑”。',
    '地下区域、特殊入口或箱庭区域也只作为 subregion，并必须给出唯一 parentRemoteKey；不得复制为根节点。',
    'region 不得包含 parentRemoteKey；subregion 必须包含 parentRemoteKey，且父级必须为 region。禁止第三层、通用世界根节点和无父级子地区。',
    '无法确认某地点的一级归属时，继续用官方地图导航、官方社区战绩目录及可靠资料交叉核验；仍无法确认则不得猜测、不得提交。',
    '若 matchCandidates 中已有经核验属于普通二级区域的同步项，应在提交正确目录时通过 archiveItems 移入回收站；不得删除手动项目。',
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
    schemaVersion: 6,
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
      catalogBaseline: '地图任务的 matchCandidates 是应用已维护的完整基准目录。本次只需联网查找基准之后的增量、改名或归属修正；没有变化时提交空 items 即可完成核验，不得为了凑数重复提交全部目录。',
      remoteKey: '同一逻辑事项稳定、可重复同步的机器身份；周期挑战的每一期使用独立 remoteKey。',
      category: 'Codex 根据资料语义选择最终版块分类；页面或接口的栏目名只是证据，不能代替活动容器、周期模式或地图层级的实际语义判断。',
      title: `由 ${requestContext.outputLocale} 官方本地化资料确认的游戏内名称，不自行翻译。`,
      activityTags: `1 至 5 个使用 ${requestContext.outputLocale} 展示的实际玩法标签；无法核验时使用该语言的“未知”表达。`,
      startsAt: '活动或周期开始的绝对时刻，ISO-8601 且包含 Z 或明确 UTC 偏移量。',
      endsAt: '活动或周期结束的绝对时刻，ISO-8601 且包含 Z 或明确 UTC 偏移量。',
      periodKey: '版本或周期实例身份；同一期稳定，不同周期不能复用。周期挑战的标题、副标题或期数变化通常属于 periodKey，而不是新的 modeKey。',
      modeKey: '跨周期稳定的玩法模式身份；单层、节点、阶段、难度、增益或奖励档位不能拥有独立 modeKey。',
      mapNodeKind:
        '地图只有 region 与 subregion。region 是一级主地区且 parentRemoteKey 必须为空；subregion 是二级地区且 parentRemoteKey 必须指向唯一 region。不得提交第三种节点或第三层。个人接口层级只是观测证据，不能单独覆盖规范目录。',
      titleSourceUrl: `能够核验 ${requestContext.outputLocale} 官方本地化名称的直接页面。`,
      sourceUrl: '能够核验该事项核心事实的直接 HTTP(S) 来源。',
      confidence: 'Codex 对该条结构化结果的 0 到 1 置信度。',
      evidence: '本次提交的交叉核验证据；至少一条，且应覆盖所提交事项。'
    },
    sections: target === 'all'
      ? [tasksContract, eventsContract, cyclesContract]
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
          when: '候选最终属于 limited_event 时',
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
          when: '候选匹配规范目录中的 subregion 时',
          meaning: '使用规范目录中唯一一级父地区的 remoteKey。'
        }
      ]
    }
  }
  const identitySemantics: Record<PersonalSyncTarget, string> = {
    events:
      '活动候选必须对应具有独立官方名称和整体参与窗口的活动容器。限时签到、限时玩法和限时剧情活动是正例；每日阶段、单个关卡、剧情任务、活动商店、奖励档位、规则页和卡池是反例。个人接口若返回内部阶段，应匹配其活动容器而不是新建活动；无法确认容器身份时交叉核验，仍不确定则拒绝，禁止猜测。',
    cycles:
      '周期候选必须区分稳定模式与当期实例。深境螺旋、幻想真境剧诗、混沌回忆、虚构叙事、末日幻影、式舆防卫战和危局强袭战是模式正例；楼层、节点、关卡、难度、当期增益和奖励档位是反例。同一模式的标题变化属于 periodKey；无法确认是否为独立模式时交叉核验，仍不确定则拒绝，禁止猜测。',
    exploration:
      '地图候选只对应规范目录中的一级主地区 region 或其二级地区 subregion。云陵谷、今州城、渊下宫、层岩巨渊·地下矿区等具体地点均应匹配到所属一级主地区下的 subregion。无法确认归属时交叉核验，仍不确定则拒绝，禁止猜测。'
  }
  return {
    schemaVersion: 9,
    authority: 'interface_contract',
    decisionAuthority: 'codex',
    executorPolicy: 'mechanical_validation_only',
    allowedMutations: ['create', 'update', 'archive'],
    target,
    requestContext,
    requiredDecisionFields: targetFields[target].required,
    conditionalFields: targetFields[target].conditional,
    fieldSemantics: {
      factAuthority: '候选中 factAuthority.source=official_personal_api 时，facts 列出的 identity、localized_title、time_window、progress、hierarchy 或 challenge_record 是已由登录后的官方接口直接提供并由适配器机械校验的事实，无需再次联网证明。它只证明字段值来自官方，不会把未列出的活动完成语义变成已知。',
      catalogPrerequisite: '个人接口只提供观测值与进度，不决定最终清单目录。应用仅在当前版块的公开规范清单覆盖度为 complete 后开放本候选；空目录或不完整目录会先由公开资料任务建立规范项目，再将个人来源 ID 绑定到规范项目。',
      itemIdentity: identitySemantics[target],
      matchCandidates: '当前版块已有同步清单或与当前地图记录机械筛出的相关子集。提交前必须逐项完成身份核对；个人接口的简称、总称和 provider remoteKey 只是观察值，不代表新事项。新增前必须比较同类别候选的标题核心语义、startsAt/endsAt 时间窗和界面倒计时：名称明显重复且时间窗重叠，或倒计时相同/接近时，默认是同一事项，除非有明确证据证明它们是不同玩法。',
      matchCandidateScope: 'complete_target 表示返回当前版块全部候选；relevant_map_subset 表示地图版块已按当前名称和父级关系机械缩小范围；bound_item 表示该官方 ID 已有 Codex 确认的持久映射，只返回规范承载项。筛选只减少无关上下文，不替代 Codex 对本次状态语义的判断。',
      duplicateDetection: '同一 category 下，公开全称与个人简称、玩法名与节点后缀、标点或语序差异不能制造新事项。标题核心名称相同并且时间窗重叠或倒计时相同/接近，是强重复信号；必须优先匹配现有 public_schedule 项。只有能够说明两者实际玩法不同的明确证据，才允许省略 matchItemId 新建。',
      matchItemId: '只要候选与现有事项指向同一实际玩法或同一期内容，就必须使用现有 itemId；尤其是名称核心相同且时间窗重叠或倒计时相同/接近时。即使名称含不同前后缀、标点、节点名，modeKey 粒度不同、provider remoteKey/periodKey 不同或时间仅存在服务器时区边界差异，也不得另建重复项。存在 public_schedule 与 personal_sync 两个候选时，优先选择 public_schedule 的 itemId 作为规范承载项。',
      archiveItems: '对 matchCandidates 中已确认错误、重复或失效的同步项给出 itemId 与理由；应用只机械执行 Codex 的归档决定。如果当前版块已经同时存在同一事项的 public_schedule 与 personal_sync 重复项，必须在本次提交中保留规范项并通过 archiveItems 归档其余同步重复项，不能只更新其中一项后让重复项继续存在。',
      remoteKey: '个人来源的 remoteKey 是来源侧观察标识。匹配现有项时由 matchItemId 保留清单的规范身份，不能因 remoteKey 不同而另建重复项。',
      completed: '周期候选按接口契约提交 true 或 false。活动完成状态只能来自能够证明“当前账号已完成整个活动”的个人字段语义；公开活动说明不能证明个人完成，is_finished、all_finished、状态字符串或奖励计数也不能跨接口一概解释。证据不足时必须省略，表示 unknown，应用保留当前状态。',
      completionRule: '仅活动提交 completed 时使用。fieldPath 必须指向本次 payload.observedStatus 下的一个原始字段，并列出明确的完成值与未完成值；规则必须能机械复现本次结论，确认后会绑定到该来源接口与官方 ID，后续同步直接复用。',
      progressPercent: '仅地图探索使用，范围 0 到 100。',
    mapNodeKind:
      '地图候选只绑定规范目录中的 region 或 subregion。region 必须无父级；subregion 必须挂到唯一 region，且禁止第三层。特殊入口、地下层和箱庭地图仍按真实归属匹配为 subregion。个人接口的节点类型只作为观测，不能覆盖规范目录。',
      category: 'Codex 可纠正解析器初始分类；应用不再二次解释业务语义。',
      title: `使用 ${requestContext.outputLocale} 的官方本地化名称。`,
      activityTags: `使用 ${requestContext.outputLocale} 的玩法标签。`,
      evidence: '支持本次语义判断的证据或字段关系说明。'
    }
  }
}
