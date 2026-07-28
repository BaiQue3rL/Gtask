const ACTIVITY_TAG_ALIASES: Record<string, string> = {
  login: '签到',
  signin: '签到',
  checkin: '签到',
  combat: '战斗',
  battle: '战斗',
  challenge: '挑战',
  story: '剧情',
  quest: '任务',
  puzzle: '解谜',
  shooting: '射击',
  shooter: '射击',
  fps: '第一人称射击',
  parkour: '跑酷',
  racing: '竞速',
  rhythm: '音游',
  music: '音游',
  card: '卡牌',
  cards: '卡牌',
  boardgame: '棋盘',
  chess: '战棋',
  towerdefense: '塔防',
  management: '经营',
  simulation: '模拟经营',
  collection: '收集',
  exploration: '探索',
  coop: '联机',
  photography: '摄影',
  photo: '摄影',
  quiz: '问答',
  web: '网页活动',
  webevent: '网页活动',
  leyline: '地脉',
  doublerewards: '双倍奖励',
  doubledrops: '双倍掉落',
  doublematerial: '双倍材料'
}

function aliasKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s_-]+/g, '')
}

export function normalizeActivityTag(value: string): string {
  const tag = value.normalize('NFKC').trim()
  if (tag === '待识别') return '未知'
  const alias = ACTIVITY_TAG_ALIASES[aliasKey(tag)]
  if (alias) return alias
  // 活动标签面向中文界面展示。无法可靠转换的外语标签使用诚实兜底，
  // 避免把内部分类键直接暴露给用户。
  if (/[A-Za-z]/.test(tag)) return '未知'
  return tag
}

export function normalizeActivityTags(values: string[], outputLocale = 'zh-CN'): string[] {
  if (!outputLocale.toLocaleLowerCase('en-US').startsWith('zh')) {
    return [...new Set(values
      .map((value) => value.normalize('NFKC').trim())
      .filter(Boolean)
      .map((value) => ['待识别', '未知'].includes(value) ? 'Unknown' : value))]
  }
  return [...new Set(values.map(normalizeActivityTag).filter(Boolean))]
}
