import type { GameId } from '../../shared/contracts'
import type { NormalizedSyncItem } from './types'

type CatalogEntry = Pick<NormalizedSyncItem, 'remoteKey' | 'title' | 'modeKey' | 'parentTitle' | 'sourceUrl'>

const CATALOGS: Record<GameId, readonly CatalogEntry[]> = {
  genshin: [
    entry('genshin:region:mondstadt', '蒙德', 'region-mondstadt', 'https://ys.mihoyo.com/main/m/map'),
    entry('genshin:region:liyue', '璃月', 'region-liyue', 'https://ys.mihoyo.com/main/m/map'),
    entry('genshin:region:inazuma', '稻妻', 'region-inazuma', 'https://ys.mihoyo.com/main/m/map'),
    entry('genshin:region:sumeru', '须弥', 'region-sumeru', 'https://ys.mihoyo.com/main/m/map'),
    entry('genshin:region:fontaine', '枫丹', 'region-fontaine', 'https://ys.mihoyo.com/main/m/map'),
    entry('genshin:region:natlan', '纳塔', 'region-natlan', 'https://ys.mihoyo.com/main/m/map'),
    entry('genshin:region:nod-krai', '挪德卡莱', 'region-nod-krai', 'https://ys.mihoyo.com/main/m/map'),
    entry('genshin:map:enkanomiya', '渊下宫', 'independent-map-enkanomiya', 'https://api-takumi.mihoyo.com/common/map_user/ys_obc/v1/map/list?app_sn=ys_obc', '稻妻'),
    entry('genshin:map:chasm-underground', '层岩巨渊·地下矿区', 'independent-map-chasm-underground', 'https://api-takumi.mihoyo.com/common/map_user/ys_obc/v1/map/list?app_sn=ys_obc', '璃月'),
    entry('genshin:map:sea-of-bygone-eras', '旧日之海', 'independent-map-sea-of-bygone-eras', 'https://api-takumi.mihoyo.com/common/map_user/ys_obc/v1/map/list?app_sn=ys_obc', '枫丹'),
    entry('genshin:map:ancient-sacred-mountain', '远古圣山', 'independent-map-ancient-sacred-mountain', 'https://api-takumi.mihoyo.com/common/map_user/ys_obc/v1/map/list?app_sn=ys_obc', '纳塔'),
    entry('genshin:map:celestial-temple', '空之神殿', 'independent-map-celestial-temple', 'https://api-takumi.mihoyo.com/common/map_user/ys_obc/v1/map/list?app_sn=ys_obc', '挪德卡莱'),
    entry('genshin:map:frostmoon', '霜月', 'independent-map-frostmoon', 'https://api-takumi.mihoyo.com/common/map_user/ys_obc/v1/map/list?app_sn=ys_obc', '挪德卡莱')
  ],
  'star-rail': [
    entry('star-rail:destination:herta-space-station', '空间站「黑塔」', 'destination-herta-space-station', 'https://sr.mihoyo.com/main?nav=world'),
    entry('star-rail:destination:jarilo-vi', '雅利洛-Ⅵ', 'destination-jarilo-vi', 'https://sr.mihoyo.com/world/101922'),
    entry('star-rail:destination:xianzhou-luofu', '仙舟「罗浮」', 'destination-xianzhou-luofu', 'https://sr.mihoyo.com/main?nav=world'),
    entry('star-rail:destination:penacony', '匹诺康尼', 'destination-penacony', 'https://sr.mihoyo.com/world/119497'),
    entry('star-rail:destination:amphoreus', '翁法罗斯', 'destination-amphoreus', 'https://sr.mihoyo.com/news/154467'),
    entry('star-rail:destination:planarcadia', '二相乐园', 'destination-planarcadia', 'https://sr.mihoyo.com/news/163630')
  ],
  zenless: [
    entry('zenless:world:new-eridu', '新艾利都', 'world-new-eridu', 'https://zzz.mihoyo.com/news/156759'),
    entry('zenless:world:waifei-peninsula', '卫非地', 'world-waifei-peninsula', 'https://zzz.mihoyo.com/news/156759'),
    entry('zenless:world:roscaelifa-buastre', '罗斯凯利法·布亚斯特城区', 'world-roscaelifa-buastre', 'https://zzz.mihoyo.com/news/164823')
  ],
  'wuthering-waves': [
    entry('wuthering-waves:region:jinzhou', '瑝珑·今州', 'region-jinzhou', 'https://mc.kurogames.com/main'),
    entry('wuthering-waves:region:mt-firmament', '瑝珑·乘霄山', 'region-mt-firmament', 'https://mc.kurogames.com/main'),
    entry('wuthering-waves:region:black-shores', '黑海岸', 'region-black-shores', 'https://mc.kurogames.com/main'),
    entry('wuthering-waves:region:rinascita', '黎那汐塔', 'region-rinascita', 'https://www.taptap.cn/moment/623651588774300992'),
    entry('wuthering-waves:region:lahai-roi', '拉海洛', 'region-lahai-roi', 'https://apps.apple.com/cn/app/id6450693428'),
    entry('wuthering-waves:region:huanglong-mengzhou', '梦州·玄方地界', 'region-huanglong-mengzhou', 'https://www.bilibili.com/opus/1224016718894989313')
  ]
}

export function getBundledExplorationCatalog(gameId: GameId): NormalizedSyncItem[] {
  return CATALOGS[gameId].map((item) => ({
    ...item,
    category: 'exploration',
    progressPercent: 0
  }))
}

function entry(
  remoteKey: string,
  title: string,
  modeKey: string,
  sourceUrl: string,
  parentTitle: string | null = null
): CatalogEntry {
  return { remoteKey, title, modeKey, sourceUrl, parentTitle }
}
