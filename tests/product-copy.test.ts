import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

describe('product copy and built-in section boundaries', () => {
  it('does not expose maintenance-agent or public-source controls', () => {
    for (const obsoleteCopy of [
      'Codex',
      '同步公开数据',
      '切换数据来源',
      '建立你的第一份清单',
      '需要安装同步插件',
      '公开数据 AI'
    ]) {
      expect(app).not.toContain(obsoleteCopy)
    }
  })

  it('offers direct progress sync, direct login, and startup preferences', () => {
    expect(app).toContain('↻ 同步进度')
    expect(app).toContain('同步进度需要登录')
    expect(app).toContain('启动后自动同步')
    expect(app).toContain('saveAutoSyncPreference')
    expect(app).toContain('beginPendingPersonalLogin')
  })

  it('only exposes creation and editing for the custom section', () => {
    expect(app).toContain('v-if="panel.allowCreate === true"')
    expect(app).toContain("v-if=\"panel.section === 'custom'\"")
    expect(app).toContain("if (section === 'custom') openEdit(item)")
    expect(app).toContain("if (item.category !== 'custom' || item.source !== 'manual') return")
  })

  it('uses compact single-line identity cards without category or source chips', () => {
    expect(app).toContain('class="item-identity"')
    expect(app).not.toContain('class="item-details"')
    expect(app).not.toContain('class="source-detail"')
    expect(styles).toContain('min-height: 50px')
    expect(styles).toContain('.item-identity .activity-tag')
  })
})
