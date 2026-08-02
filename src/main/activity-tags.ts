export const ACTIVITY_TAG_TAXONOMY_VERSION = 5
export const MIN_AI_ACTIVITY_TAGS = 1
export const MAX_AI_ACTIVITY_TAGS = 5

export const ACTIVITY_TAG_DIMENSIONS = ['gameplay', 'format', 'content', 'reward'] as const
export type ActivityTagDimension = (typeof ACTIVITY_TAG_DIMENSIONS)[number]
export type ActivityTagQualityRole = 'primary' | 'supporting' | 'fallback'

export interface ActivityTagDefinition {
  id: string
  dimension: ActivityTagDimension
  labels: Record<string, string>
  description: string
  aliases: string[]
  builtin: boolean
}

type BuiltinTagInput = Omit<ActivityTagDefinition, 'builtin'>

const BUILTIN_ACTIVITY_TAGS: BuiltinTagInput[] = [
  tag('unknown', 'content', '未知', 'Unknown', '充分核验后仍无法确定的活动类型。', ['待识别']),
  tag('sign-in', 'format', '签到', 'Check-in', '按日或按阶段登录、签到并领取奖励。', ['login', 'signin', 'checkin']),
  tag('combat', 'gameplay', '战斗', 'Combat', '以实时或回合制战斗为主要交互。', ['battle']),
  tag('challenge', 'gameplay', '挑战', 'Challenge', '以限定规则、目标或成绩为核心的挑战玩法。'),
  tag('story', 'content', '剧情', 'Story', '以剧情阅读、演出或叙事任务为主要内容。'),
  tag('quest', 'content', '任务', 'Quest', '以完成连续任务目标为主要形式。'),
  tag('puzzle', 'gameplay', '解谜', 'Puzzle', '以机关、逻辑或线索推理解谜为主要玩法。'),
  tag('shooting', 'gameplay', '射击', 'Shooting', '以瞄准和射击为主要玩法。', ['shooter']),
  tag('first-person-shooting', 'gameplay', '第一人称射击', 'First-person shooting', '使用第一人称视角进行射击。', ['fps']),
  tag('parkour', 'gameplay', '跑酷', 'Parkour', '以连续移动、跳跃或躲避障碍为主要玩法。'),
  tag('racing', 'gameplay', '竞速', 'Racing', '以完成路线和用时竞争为主要玩法。'),
  tag('rhythm', 'gameplay', '音游', 'Rhythm', '按音乐节奏完成输入判定。', ['music']),
  tag('card', 'gameplay', '卡牌', 'Card game', '以卡牌构筑、出牌或牌局对抗为主要玩法。', ['cards']),
  tag('board', 'gameplay', '棋盘', 'Board game', '以棋盘移动、格子或棋子规则为主要玩法。', ['boardgame']),
  tag('tactics', 'gameplay', '战棋', 'Tactical', '以单位部署、回合和格子战术为主要玩法。', ['chess']),
  tag('tower-defense', 'gameplay', '塔防', 'Tower defense', '以布置单位或设施阻挡敌人为主要玩法。', ['towerdefense']),
  tag('management', 'gameplay', '经营', 'Management', '以资源配置、建设或经营决策为主要玩法。'),
  tag('simulation', 'gameplay', '模拟经营', 'Simulation', '以模拟系统中的长期建设和经营为主要玩法。'),
  tag('collection', 'gameplay', '收集', 'Collection', '以寻找并收集目标物品为主要玩法。'),
  tag('exploration', 'gameplay', '探索', 'Exploration', '以区域探索和发现内容为主要玩法。'),
  tag('co-op', 'format', '联机', 'Co-op', '支持或要求多人协作进行。', ['coop']),
  tag('photography', 'gameplay', '摄影', 'Photography', '以取景、拍摄或照片目标为主要玩法。', ['photo']),
  tag('quiz', 'gameplay', '问答', 'Quiz', '以回答问题或知识判断为主要玩法。'),
  tag('web-event', 'format', '网页活动', 'Web event', '主要交互发生在游戏外网页中。', ['web', 'webevent']),
  tag('ley-line', 'reward', '地脉', 'Ley Line', '以地脉相关奖励或挑战为目标。', ['leyline']),
  tag('double-reward', 'reward', '双倍奖励', 'Double rewards', '活动期间提供额外次数或双倍奖励。', ['doublerewards']),
  tag('double-drop', 'reward', '双倍掉落', 'Double drops', '活动期间提高指定内容的掉落收益。', ['doubledrops']),
  tag('material-reward', 'reward', '养成材料', 'Upgrade materials', '主要奖励或目标是角色、武器等养成材料。', ['doublematerial']),
  tag('festival', 'content', '节庆', 'Festival', '围绕游戏内节庆主题展开的活动内容。')
]

function tag(
  id: string,
  dimension: ActivityTagDimension,
  zhCN: string,
  enUS: string,
  description: string,
  aliases: string[] = []
): BuiltinTagInput {
  return {
    id,
    dimension,
    labels: { 'zh-CN': zhCN, 'en-US': enUS },
    description,
    aliases
  }
}

const RESERVED_ACTIVITY_TAG_KEYS = new Set([
  '活动', '限时活动', '常驻活动', '个人数据', '公开资料', '公开数据', '手动',
  '活动玩法', '玩法活动', '活动内容', '活动模式', '通用玩法', '其他玩法', '其它玩法',
  'event', 'limitedevent', 'permanentevent', 'eventgameplay', 'gameplayevent',
  'eventcontent', 'genericgameplay', 'othergameplay', 'personaldata', 'publicdata',
  'publicschedule', 'manual'
].map(aliasKey))

// These labels can add useful context, but none of them answers the core
// question "what does the player actually do?" on its own.  Keeping this
// distinction in the interface contract prevents an Agent from satisfying a
// metadata job with low-information combinations such as “挑战 + 任务 + 奖励”.
const SUPPORTING_ACTIVITY_TAG_IDS = new Set([
  'challenge',
  'story',
  'quest',
  'co-op',
  'material-reward',
  'festival'
])

let runtimeTags: ActivityTagDefinition[] = []

function aliasKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s_-]+/g, '')
}

function preferredLocale(locale: string): string {
  return locale.toLocaleLowerCase('en-US').startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function configureRuntimeActivityTags(definitions: ActivityTagDefinition[]): void {
  runtimeTags = definitions.filter((definition) => !definition.builtin)
}

export function listActivityTagDefinitions(): ActivityTagDefinition[] {
  return [
    ...BUILTIN_ACTIVITY_TAGS.map((definition) => ({ ...definition, builtin: true })),
    ...runtimeTags.map((definition) => ({ ...definition, builtin: false }))
  ]
}

export function isValidActivityTagId(id: string): boolean {
  return listActivityTagDefinitions().some((definition) => definition.id === id)
}

export function getActivityTagQualityRole(id: string): ActivityTagQualityRole {
  if (id === 'unknown') return 'fallback'
  if (SUPPORTING_ACTIVITY_TAG_IDS.has(id)) return 'supporting'
  return 'primary'
}

export function normalizeActivityTags(values: string[], outputLocale = 'zh-CN'): string[] {
  const definitions = listActivityTagDefinitions()
  const lookup = new Map<string, string>()
  for (const definition of definitions) {
    lookup.set(aliasKey(definition.id), definition.id)
    for (const label of Object.values(definition.labels)) lookup.set(aliasKey(label), definition.id)
    for (const alias of definition.aliases) lookup.set(aliasKey(alias), definition.id)
  }
  const normalized = values.flatMap((value) => {
    const candidate = value.normalize('NFKC').trim()
    if (!candidate) return []
    const key = aliasKey(candidate)
    if (RESERVED_ACTIVITY_TAG_KEYS.has(key)) return []
    return [lookup.get(key) ?? 'unknown']
  })
  return [...new Set(normalized)].slice(0, 5)
}

export function localizeActivityTags(ids: string[], outputLocale = 'zh-CN'): string[] {
  const locale = preferredLocale(outputLocale)
  const definitions = new Map(listActivityTagDefinitions().map((definition) => [definition.id, definition]))
  return [...new Set(ids.map((id) => {
    const definition = definitions.get(id)
    if (!definition) return locale === 'zh-CN' ? '未知' : 'Unknown'
    return definition.labels[locale] ?? definition.labels['zh-CN'] ?? definition.id
  }))]
}

export function activityTagsMeetQualityContract(
  values: string[],
  outputLocale = 'zh-CN'
): boolean {
  const normalized = normalizeActivityTags(values, outputLocale)
  return normalized.length >= MIN_AI_ACTIVITY_TAGS &&
    normalized.length <= MAX_AI_ACTIVITY_TAGS &&
    !normalized.includes('unknown')
}

export function serializeActivityTagCatalog(outputLocale = 'zh-CN'): Array<{
  id: string
  dimension: ActivityTagDimension
  qualityRole: ActivityTagQualityRole
  label: string
  description: string
}> {
  const locale = preferredLocale(outputLocale)
  return listActivityTagDefinitions().map((definition) => ({
    id: definition.id,
    dimension: definition.dimension,
    qualityRole: getActivityTagQualityRole(definition.id),
    label: definition.labels[locale] ?? definition.labels['zh-CN'] ?? definition.id,
    description: definition.description
  }))
}
