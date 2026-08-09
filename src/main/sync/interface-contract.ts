import type {
  PublicSyncContract,
  SyncRequestContext,
  SyncSectionContract,
  SyncTarget
} from '../../shared/contracts'
import {
  MAX_AI_ACTIVITY_TAGS,
  MIN_AI_ACTIVITY_TAGS,
  serializeActivityTagCatalog
} from '../activity-tags'

const DEFAULT_REQUEST_CONTEXT: SyncRequestContext = {
  outputLocale: 'zh-CN',
  userTimeZone: 'Asia/Shanghai'
}

function activityTagSemantics(outputLocale: string): string {
  return `activityTagCatalog 只是可用词汇表，不是待分配清单。每个活动必须依据玩法规则提交 ${MIN_AI_ACTIVITY_TAGS} 至 ${MAX_AI_ACTIVITY_TAGS} 个稳定标签 ID，并按 ${outputLocale} 的标签定义自主判断最贴切的玩法语义；不得猜测、凑数或从词表中硬挑。现有目录无法准确表达资料明确描述的新玩法时，可调用标签注册工具创建 custom.* ID 后再引用。不得写入“活动”“限时活动”“常驻活动”等版块分类，也不得提交数据来源标签。`
}

const tasksContract: SyncSectionContract = {
  target: 'tasks',
  purpose: '校准当前游戏版本窗口，供游戏导航显示版本剩余时间。',
  inventoryScope:
    '当前正在运行的正式游戏版本及其全服版本结束时刻。优先采用官方已经确认的下次版本维护时刻；官方尚未公布精确时刻时，允许用当前版本官方开始时间、已公布的后续排期与既往稳定版更节奏交叉核验出可靠预计。版本阶段、卡池阶段和单个活动窗口不属于版本窗口。',
  itemShapes: [],
  completionCriteria: [
    '通过 apply_gacha_public_schedule 的 versionWindow 提交且 items 保持为空；版本时间不是清单事项。',
    'versionWindow 必须包含 startsAt、endsAt、periodKey、timeZone、sourceUrl 和 confidence。',
    '时间覆盖当前正在运行的正式版本，而不是已经结束或尚未开始的其他版本。',
    '正例是官方版本更新公告、版本专题或能够证明整个版本起止时间的排期资料；反例是下半卡池开始时间、单个活动结束时间、维护补偿领取期限和前瞻直播时间。',
    '官方已公布精确版更时刻时必须采用官方值，并在 evidence 中保留直接来源。',
    '官方尚未公布精确版更时刻时，不得仅因此结束为失败；应交叉核验当前版本官方开始时间、官方已公布的后续内容排期、相邻版本维护记录或可靠排期资料，给出最可信的暂定 endsAt，并用较低 confidence 且在 evidence.note 中明确说明“暂定”及推算依据。',
    '暂定时间不是任意猜测：不能直接拿卡池、单个活动或奖励期限充当版本结束时间；证据互相冲突且无法形成可信结论时才允许失败。',
    '后续官方公告出现延期、提前更新或精确维护时刻时，必须以同一 periodKey 重新提交并覆盖暂定时间；来源时区不明时先核验服务器时区。'
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
      'startsAt',
      'endsAt',
      'activityTags',
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
    `玩法标签是活动必填字段。提交 ${MIN_AI_ACTIVITY_TAGS} 至 ${MAX_AI_ACTIVITY_TAGS} 个符合 requestContext.outputLocale 的准确标签；不能同义重复、用泛化词凑数或为了覆盖词表而硬贴。`,
    '提交标签前应阅读能够直接说明玩法规则的资料；只有排期图、活动标题或奖励列表不足以证明玩法。现有标签目录无法准确表达明确的新玩法时应注册 custom.* 标签后再提交。',
    '同一活动只能保留一个语义记录；名称或标点不同但实际相同时使用 matchItemId。',
    '如果无法确认某个名称是整体活动还是内部阶段，或不同页面是否属于同一活动，必须结合官方活动规则、时间窗口和至少一个独立可靠来源交叉核验；仍无法确认则不得猜测或提交。'
  ]
}

const cyclesContract: SyncSectionContract = {
  target: 'cycles',
  purpose: '校准当前主要周期挑战的名称、周期窗口与模式身份。',
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
    '模式正例：原神“深境螺旋”“幻想真境剧诗”、星铁“混沌回忆”“虚构叙事”“末日幻影”、绝区零“式舆防卫战”“危局强袭战”等具有独立入口和重复周期的主要挑战。',
    '模式反例：某一层、节点、关卡、难度、当期增益、敌人阵容、奖励档位、每周首领、体力副本或限时活动挑战；这些不能作为新的周期模式。',
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
    schemaVersion: 13,
    jobKind: 'public_catalog',
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
      ...(target === 'tasks'
        ? ['versionWindow']
        : target === 'all'
          ? ['items', 'versionWindow']
          : ['items']),
      'evidence'
    ],
    fieldSemantics: {
      matchItemId: '与 matchCandidates 中现有事项语义相同时使用其 itemId；真正新增时省略。',
      catalogBaseline: '地图任务的 matchCandidates 是应用已维护的完整基准目录。本次只需联网查找基准之后的增量、改名或归属修正；没有变化时提交空 items 即可完成核验，不得为了凑数重复提交全部目录。',
      remoteKey: '同一逻辑事项稳定、可重复同步的机器身份；周期挑战的每一期使用独立 remoteKey。',
      category: 'Codex 根据资料语义选择最终版块分类；页面或接口的栏目名只是证据，不能代替活动容器、周期模式或地图层级的实际语义判断。',
      title: `由 ${requestContext.outputLocale} 官方本地化资料确认的游戏内名称，不自行翻译。`,
      activityTags: activityTagSemantics(requestContext.outputLocale),
      startsAt: '活动、周期或当前游戏版本开始的绝对时刻，ISO-8601 且包含 Z 或明确 UTC 偏移量。',
      endsAt: '活动、周期或当前游戏版本结束的绝对时刻，ISO-8601 且包含 Z 或明确 UTC 偏移量。版本校时在官方精确时刻尚未公布时按 tasks 契约提交可靠暂定值，其他版块不得套用该例外。',
      periodKey: '版本或周期实例身份；同一期稳定，不同周期不能复用。周期挑战的标题、副标题或期数变化通常属于 periodKey，而不是新的 modeKey。',
      modeKey: '跨周期稳定的玩法模式身份；单层、节点、阶段、难度、增益或奖励档位不能拥有独立 modeKey。',
      mapNodeKind:
        '地图只有 region 与 subregion。region 是一级主地区且 parentRemoteKey 必须为空；subregion 是二级地区且 parentRemoteKey 必须指向唯一 region。不得提交第三种节点或第三层。个人接口层级只是观测证据，不能单独覆盖规范目录。',
      titleSourceUrl: `能够核验 ${requestContext.outputLocale} 官方本地化名称的直接页面。`,
      sourceUrl: '能够核验该事项核心事实的直接 HTTP(S) 来源。',
      confidence: 'Codex 对该条结构化结果的 0 到 1 置信度；任务版更校时的暂定结束时间必须低于官方精确公告的置信度。',
      versionWindow: '游戏级版本窗口，不是清单事项。只在 tasks 目标提交；包含当前正式版本的 startsAt、endsAt、periodKey、timeZone、sourceUrl 和 confidence。',
      evidence: '本次提交的交叉核验证据；至少一条，且应覆盖所提交事项。'
    },
    activityTagCatalog: serializeActivityTagCatalog(requestContext.outputLocale),
    sections: target === 'all'
      ? [tasksContract, eventsContract, cyclesContract]
      : [sectionContracts[target]]
  }
}
