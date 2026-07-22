import { describe, expect, it } from 'vitest'
import { detectCodexPlugin } from '../src/main/ai/codex-plugin'

describe('Codex 插件检测', () => {
  it('需要启用配置和安装缓存同时存在', () => {
    const status = detectCodexPlugin({
      userHome: 'C:\\Users\\Test',
      exists: (path) =>
        path.endsWith('config.toml') ||
        path.endsWith('marketplace.json') ||
        path.endsWith('gacha-task-manager'),
      readText: () => [
        '[plugins."other@personal"]',
        'enabled = false',
        '',
        '[plugins."gacha-task-manager@personal"]',
        'enabled = true',
        '',
        '[features]',
        'js_repl = false'
      ].join('\n'),
      listDirectory: () => ['0.1.0']
    })
    expect(status.installed).toBe(true)
    expect(status.deeplink).toContain('codex://plugins/gacha-task-manager?marketplacePath=')
  })

  it('识别应用自带市场名称并返回对应安装页', () => {
    const appMarketplacePath = 'C:\\Users\\Test\\AppData\\Roaming\\gacha-task-manager\\codex-integration\\marketplace.json'
    const status = detectCodexPlugin({
      userHome: 'C:\\Users\\Test',
      appMarketplacePath,
      exists: (path) => path.endsWith('config.toml') || path.endsWith('gacha-task-manager'),
      readText: () => [
        '[plugins."gacha-task-manager@personal"]',
        'enabled = false',
        '',
        '[plugins."gacha-task-manager@gacha-task-manager-app"]',
        'enabled = true'
      ].join('\n'),
      listDirectory: () => ['0.1.0']
    })

    expect(status.installed).toBe(true)
    expect(status.marketplacePath).toBe(appMarketplacePath)
    expect(decodeURIComponent(status.deeplink)).toContain(appMarketplacePath)
  })

  it('禁用或缓存缺失时不误报已安装', () => {
    expect(detectCodexPlugin({
      userHome: 'C:\\Users\\Test',
      exists: () => true,
      readText: () => '[plugins."gacha-task-manager@personal"]\nenabled = false',
      listDirectory: () => ['0.1.0']
    }).installed).toBe(false)
    expect(detectCodexPlugin({
      userHome: 'C:\\Users\\Test',
      exists: (path) => !path.endsWith('gacha-task-manager'),
      readText: () => '[plugins."gacha-task-manager@personal"]\nenabled = true',
      listDirectory: () => []
    }).installed).toBe(false)
  })
})
