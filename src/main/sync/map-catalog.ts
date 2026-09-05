import { createHash } from 'node:crypto'
import type { GameId } from '../../shared/contracts'
import type { NormalizedSyncItem } from './types'

interface MapRegionDefinition {
  title: string
  subregions: readonly string[]
}

const MAP_CATALOG_VERIFIED_AT: Record<GameId, string> = {
  genshin: '2026-08-12T18:20:00+08:00',
  'star-rail': '2026-08-09T12:30:00+08:00',
  zenless: '2026-08-09T12:30:00+08:00',
  'wuthering-waves': '2026-09-05T19:40:00+08:00'
}

/**
 * Bundled canonical map catalog.
 *
 * These definitions deliberately contain names and hierarchy only. Personal
 * progress, account identifiers and provider IDs are learned separately and
 * bound to these canonical rows during personal synchronization.
 */
const MAP_CATALOGS: Record<GameId, readonly MapRegionDefinition[]> = {
  genshin: [
    {
      title: '至冬',
      subregions: ['古兽冰原', '白桦雪葬地', '永凝冻土', '焰羽谷', '霜殛寒峰']
    },
    { title: '空之神殿', subregions: [] },
    {
      title: '挪德卡莱',
      subregions: [
        '帕哈岛',
        '伦波岛',
        '希汐岛',
        '虚海望',
        '逐浪野',
        '烟硌山峰',
        '杜南纳深坑',
        '月之高地',
        '月荡海',
        '月之暗面'
      ]
    },
    {
      title: '纳塔',
      subregions: [
        '坚岩隘谷',
        '万火之瓯',
        '涌流地',
        '踞石山',
        '镜璧山',
        '奥奇卡纳塔',
        '翘枝崖',
        '安饶之野',
        '悠悠度假村',
        '远古圣山'
      ]
    },
    {
      title: '枫丹',
      subregions: [
        '白露区',
        '苍晶区',
        '枫丹廷区',
        '黎翡区',
        '枫丹动能工程科学研究院区',
        '伊黎耶林区',
        '莫尔泰区',
        '诺思托伊区',
        '旧日之海'
      ]
    },
    {
      title: '须弥',
      subregions: [
        '护世森',
        '阿陀河谷',
        '二净甸',
        '善见地',
        '道成林',
        '失落的苗圃',
        '桓那兰那',
        '下风蚀地',
        '列柱沙原',
        '上风蚀地',
        '千壑沙地',
        '荒石苍漠',
        '浮罗囿'
      ]
    },
    {
      title: '稻妻',
      subregions: ['鸣神岛', '神无冢', '八酝岛', '清籁岛', '海祇岛', '鹤观', '渊下宫']
    },
    {
      title: '璃月',
      subregions: [
        '碧水原',
        '珉林',
        '云来海',
        '璃沙郊',
        '琼玑野',
        '层岩巨渊',
        '层岩巨渊·地下矿区',
        '来歆山',
        '沉玉谷',
        '沉玉谷·南陵',
        '沉玉谷·上谷'
      ]
    },
    {
      title: '蒙德',
      subregions: ['坠星山谷', '风啸山坡', '苍风高地', '明冠山地', '龙脊雪山', '风息山']
    }
  ],
  'star-rail': [
    {
      title: '空间站「黑塔」',
      subregions: ['主控舱段', '基座舱段', '收容舱段', '支援舱段', '禁闭舱段']
    },
    {
      title: '雅利洛-Ⅵ',
      subregions: [
        '行政区',
        '城郊雪原',
        '边缘通路',
        '铁卫禁区',
        '残响回廊',
        '永冬岭',
        '磐岩镇',
        '大矿区',
        '铆钉镇',
        '机械聚落',
        '历史文化博物馆',
        '造物之柱',
        '旧武器试验场'
      ]
    },
    {
      title: '仙舟「罗浮」',
      subregions: [
        '星槎海中枢',
        '流云渡',
        '迴星港',
        '长乐天',
        '太卜司',
        '工造司',
        '丹鼎司',
        '鳞渊境',
        '金人巷',
        '绥园',
        '幽囚狱',
        '竞锋舰'
      ]
    },
    {
      title: '匹诺康尼',
      subregions: [
        '「白日梦」酒店-梦境',
        '黄金的时刻',
        '筑梦边境',
        '稚子的梦',
        '「白日梦」酒店-现实',
        '朝露公馆',
        '克劳克影视乐园',
        '流梦礁',
        '苏乐达™热砂海选会场',
        '匹诺康尼大剧院',
        '晖长石号',
        '匹诺康尼折纸大学学院',
        '橡木鸣蛀之梦'
      ]
    },
    {
      title: '翁法罗斯',
      subregions: [
        '「永恒圣城」奥赫玛',
        '「纷争荒墟」悬锋城',
        '创世涡心',
        '「浴血战端」悬锋城',
        '「命运重渊」雅努萨波利斯',
        '「呓语密林」神悟树庭',
        '「神谕圣地」雅努萨波利斯',
        '「半神议院」黎明云崖',
        '「龙骸古城」斯缇科西亚',
        '「穹顶关塞」晨昏之眼',
        '「云端遗堡」晨昏之眼',
        '「无晖祈堂」黎明云崖',
        '「沉沦暮城」奥赫玛',
        '哀丽秘榭',
        '「酣歌海垠」斯缇科西亚',
        '「全世矩阵」无名泰坦大墓',
        '「辉痕圣林」神悟树庭',
        '「葬忆彼岸」时光归墟',
        '「灾梦余温」无名泰坦大墓',
        '「岁月彼岸」一页永恒'
      ]
    },
    {
      title: '二相乐园',
      subregions: [
        '二维市',
        '绘世学院',
        '鸽川区',
        '幻月秘庭',
        '「世界尽头」酒馆',
        '珠星大厦',
        '观览云岛站',
        '海原市',
        '海原电视塔',
        '渡画泉隐',
        '寂灭空飨妖都',
        '坠星的摇篮'
      ]
    },
    {
      title: '星穹列车',
      subregions: ['观景车厢', '客房车厢', '派对车厢']
    }
  ],
  zenless: [
    {
      title: '罗斯凯利法',
      subregions: ['布亚斯特城区', '[管制区]算枢局', '[管制区]能源区']
    },
    { title: '斯卡莫空洞', subregions: ['[空洞]沉没回廊'] },
    { title: '卫非地', subregions: ['澄辉坪'] },
    {
      title: '莱姆尼安空洞',
      subregions: [
        '[空洞]中央制造区',
        '[空洞]职工社区旧址',
        '[空洞]科研院旧址',
        '[空洞]粗加工中心',
        '[空洞]轻松公寓',
        '[空洞]航天科学站',
        '[空洞]旧建筑群',
        '[空洞]社区储运站',
        '[空洞]昔丘',
        '[空洞]港口工厂旧址',
        '[空洞]辉瓷加工基地',
        '[空洞]辉岭石矿场',
        '[空洞]青溟秘境'
      ]
    },
    {
      title: '雅努斯区',
      subregions: ['六分街', '光映广场', '黑雁工地旧址', '芭莱大厦前', '厄匹斯港']
    },
    { title: '外环地带', subregions: ['野火镇'] }
  ],
  'wuthering-waves': [
    {
      title: '瑝珑',
      subregions: [
        '云陵谷',
        '今州城',
        '中曲台地',
        '荒石高地',
        '归墟港市',
        '无光之森',
        '无明湾',
        '北落野',
        '怨鸟泽',
        '虎口山脉',
        '乘霄山',
        '玄方城',
        '方擎西峰',
        '落渊南丘',
        '玄幽东岳'
      ]
    },
    { title: '黑海岸', subregions: ['黑海岸群岛', '泰缇斯之底'] },
    {
      title: '黎那汐塔',
      subregions: [
        '拉古那城',
        '埃弗拉德金库',
        '悲叹墓岛',
        '赞悼圣迹',
        '拂风水畔',
        '氤柔水境',
        '槲生半岛',
        '狄萨莱海脊',
        '下层金库',
        '黎乔利群岛',
        '阿维纽林',
        '贝奥海域',
        '七丘',
        '隐海试验场',
        '桑古伊斯狩原'
      ]
    },
    {
      title: '罗伊冰原',
      subregions: [
        '联运椎骨',
        '牙列石壑',
        '陷足流川',
        '复生丘原',
        '蚀刻平原',
        '星炬学院',
        '隐喙深腹',
        '巨目远野',
        '浮光林',
        '冰原运输港',
        '加拉尔冠阶',
        '盲望之塌',
        '元林遗址',
        '覆海原',
        '落日堤屿',
        '封存地',
        '寂静断崖',
        '恒黯之原'
      ]
    }
  ]
}

function stableKey(gameId: GameId, kind: 'region' | 'subregion', identity: string): string {
  // 1.0.0 shipped the typo “虚海垒”. Keep that released machine identity
  // while correcting the user-facing official name to “虚海望”.
  const stableIdentity = gameId === 'genshin' && kind === 'subregion' &&
    identity.normalize('NFKC').trim() === '挪德卡莱\0虚海望'
    ? '挪德卡莱\0虚海垒'
    : identity
  const digest = createHash('sha256')
    .update(`${gameId}\0${kind}\0${stableIdentity.normalize('NFKC').trim()}`, 'utf8')
    .digest('hex')
    .slice(0, 20)
  return `map-catalog:${gameId}:${kind}:${digest}`
}

export function getBundledMapCatalog(gameId: GameId): NormalizedSyncItem[] {
  return MAP_CATALOGS[gameId].flatMap((region) => {
    const regionRemoteKey = stableKey(gameId, 'region', region.title)
    return [
      {
        remoteKey: regionRemoteKey,
        category: 'exploration' as const,
        title: region.title,
        progressPercent: 0,
        parentTitle: null,
        mapNodeKind: 'region' as const,
        parentRemoteKey: null,
        modeKey: regionRemoteKey
      },
      ...region.subregions.map((title): NormalizedSyncItem => {
        const remoteKey = stableKey(gameId, 'subregion', `${region.title}\0${title}`)
        return {
          remoteKey,
          category: 'exploration',
          title,
          progressPercent: 0,
          parentTitle: region.title,
          mapNodeKind: 'subregion',
          parentRemoteKey: regionRemoteKey,
          modeKey: remoteKey
        }
      })
    ]
  })
}

export function getBundledMapCatalogVerifiedAt(gameId: GameId): string {
  return new Date(MAP_CATALOG_VERIFIED_AT[gameId]).toISOString()
}

export function getBundledMapCatalogCounts(gameId: GameId): {
  regions: number
  subregions: number
} {
  const regions = MAP_CATALOGS[gameId]
  return {
    regions: regions.length,
    subregions: regions.reduce((sum, region) => sum + region.subregions.length, 0)
  }
}
