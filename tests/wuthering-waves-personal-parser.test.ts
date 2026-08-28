import { describe, expect, it } from 'vitest'
import {
  extractWutheringWavesExplorationProgressCandidates,
  parseWutheringWavesExploration,
  parseWutheringWavesMatrix,
  parseWutheringWavesPersonalData,
  parseWutheringWavesSlash,
  parseWutheringWavesTower
} from '../src/main/sync/wuthering-waves-personal-parser'
import { WutheringWavesPersonalAdapter } from '../src/main/sync/wuthering-waves-personal-adapter'

describe('鸣潮个人进度解析', () => {
  it('保留一级主地区和二级地区探索度', () => {
    expect(parseWutheringWavesExploration({
      open: true,
      exploreList: [{
        country: { countryId: 1, countryName: '瑝珑' },
        countryProgress: '78.4',
        areaInfoList: [
          { areaId: 101, areaName: '乘霄山', areaProgress: 100, itemList: [] },
          { areaId: 102, areaName: '黑海岸', areaProgress: 63, itemList: [] }
        ]
      }]
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        remoteKey: 'exploration:country:1',
        title: '瑝珑',
        progressPercent: 78.4,
        completed: false
      }),
      expect.objectContaining({
        remoteKey: 'exploration:area:101',
        title: '乘霄山',
        parentTitle: '瑝珑',
        progressPercent: 100
      }),
      expect.objectContaining({
        remoteKey: 'exploration:area:102',
        title: '黑海岸',
        parentTitle: '瑝珑',
        progressPercent: 63
      })
    ]))
  })

  it('地图语义候选同时发送一级主地区和二级地区', () => {
    const candidates = extractWutheringWavesExplorationProgressCandidates({
      exploreList: [{
        country: { countryId: 1, countryName: '瑝珑' },
        countryProgress: 78.4,
        areaInfoList: [
          { areaId: 101, areaName: '乘霄山', areaProgress: 100 }
        ]
      }]
    })

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          officialId: '1',
          officialTitle: '瑝珑',
          observedNodeKind: 'region',
          observedProgress: 78.4
        })
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          officialId: 'area:101',
          officialTitle: '乘霄山',
          observedNodeKind: 'subregion',
          observedParentTitle: '瑝珑',
          observedProgress: 100
        })
      })
    ]))
  })

  it('挑战模式只要必须手动的本期关卡有记录就完成，不要求满星或满分', () => {
    expect(parseWutheringWavesTower({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{
        difficultyName: '深境区',
        towerAreaList: [{
          areaName: '残响之塔',
          star: 0,
          floorList: [{ floor: 4, star: 0, hasRecord: true }]
        }]
      }]
    })).toMatchObject({
      title: '逆境深塔',
      completed: true,
      modeKey: 'tower-of-adversity'
    })

    expect(parseWutheringWavesSlash({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{
        allScore: 0,
        challengeList: [{ challengeId: 9, score: 1, halfList: [] }]
      }]
    })).toMatchObject({
      title: '冥歌海墟',
      completed: true
    })

    expect(parseWutheringWavesMatrix({
      isUnlock: true,
      endTime: 1787183999,
      modeDetails: [{ hasRecord: true, score: 0, teams: [] }]
    })).toMatchObject({
      title: '终焉矩阵',
      completed: true
    })
  })

  it('个人挑战解析不输出基准时间或期次', () => {
    const items = [
      parseWutheringWavesTower({ difficultyList: [] }),
      parseWutheringWavesSlash({ difficultyList: [] }),
      parseWutheringWavesMatrix({ modeDetails: [] })
    ]

    for (const item of items) {
      expect(item).not.toHaveProperty('startsAt')
      expect(item).not.toHaveProperty('endsAt')
      expect(item).not.toHaveProperty('periodKey')
      expect(item).not.toHaveProperty('scheduleKind')
    }
  })

  it('完全没有碰过挑战时保持未完成', () => {
    expect(parseWutheringWavesTower({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{ towerAreaList: [{ star: 0, floorList: [{ floor: 1, star: 0 }] }] }]
    })).toMatchObject({ completed: false })
    expect(parseWutheringWavesSlash({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{
        allScore: 0,
        challengeList: [{ score: 0, halfList: [{ half: 1, score: 0 }] }]
      }]
    })).toMatchObject({ completed: false })
    expect(parseWutheringWavesMatrix({
      isUnlock: true,
      endTime: 1787183999,
      modeDetails: [{ hasRecord: false, score: 0, passBoss: 0, teams: [{ roleIds: [] }] }]
    })).toMatchObject({ completed: false })
  })

  it('终焉矩阵只有快速通过结果时不算手动完成', () => {
    expect(parseWutheringWavesMatrix({
      isUnlock: true,
      modeDetails: [{
        hasRecord: false,
        score: 0,
        passBoss: 1,
        teams: [{ roleIds: [] }]
      }]
    })).toMatchObject({ completed: false })
  })

  it('逆境深塔继承层与海墟第 7、8 关不算手动记录', () => {
    expect(parseWutheringWavesTower({
      isUnlock: true,
      difficultyList: [{
        difficultyName: '稳定区',
        towerAreaList: [{
          areaName: '稳定之塔',
          floorList: [{ floor: 4, star: 3, hasRecord: true }]
        }]
      }, {
        difficultyName: '深境区',
        towerAreaList: [{
          areaName: '残响之塔',
          star: 9,
          floorList: [
            { floor: 1, star: 3, hasRecord: true },
            { floor: 2, star: 3, hasRecord: true },
            { floor: 3, star: 3, hasRecord: true }
          ]
        }]
      }]
    })).toMatchObject({ completed: false })

    expect(parseWutheringWavesSlash({
      isUnlock: true,
      difficultyList: [{
        allScore: 10000,
        challengeList: [
          { challengeId: 7, score: 5000, hasRecord: true },
          { challengeId: 8, score: 5000, hasRecord: true }
        ]
      }]
    })).toMatchObject({ completed: false })

    expect(parseWutheringWavesSlash({
      isUnlock: true,
      difficultyList: [{
        challengeList: [{
          challengeId: 12,
          score: 0,
          halfList: [{ half: 1, score: 0, hasRecord: true }]
        }]
      }]
    })).toMatchObject({ completed: true })
  })

  it('适配器按版块请求数据并保留部分成功结果', async () => {
    const order: string[] = []
    const progress: Array<{ message: string; current?: number | null; total?: number | null }> = []
    const adapter = new WutheringWavesPersonalAdapter({
      getExploration: async () => {
        order.push('exploration')
        return { open: true, exploreList: [] }
      },
      getTower: async () => {
        order.push('tower')
        return { seasonEndTime: 1787183999, difficultyList: [] }
      },
      getSlash: async () => {
        order.push('slash')
        throw new Error('接口暂时失败')
      },
      getMatrix: async () => {
        order.push('matrix')
        return { endTime: 1787183999, modeDetails: [] }
      }
    })

    const output = await adapter.sync(
      'wuthering-waves',
      'cycles',
      (update) => progress.push(update)
    )
    expect(order).toEqual(['tower', 'slash', 'matrix'])
    expect(output.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'endgame', modeKey: 'tower-of-adversity' }),
      expect.objectContaining({ category: 'endgame', modeKey: 'endstate-matrix' })
    ]))
    expect(output.snapshotCompleteness).toBe('partial')
    expect(output.scheduleObservations).toEqual([])
    expect(output.message).toContain('部分成功 2/3')
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: '正在读取逆境深塔战绩', current: 1, total: 3 }),
      expect.objectContaining({ message: '冥歌海墟战绩读取失败，继续下一项', current: 2, total: 3 }),
      expect.objectContaining({ message: '正在读取终焉矩阵战绩', current: 3, total: 3 })
    ]))
    await expect(adapter.sync('genshin')).rejects.toThrow('不能用于其他游戏')
  })

  it('拒绝完全无法识别的个人数据', () => {
    expect(() => parseWutheringWavesPersonalData({})).toThrow('没有可识别')
  })
})
