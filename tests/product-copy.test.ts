import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('product copy', () => {
  it('面向用户的界面不暴露调度和实现细节', () => {
    const app = readFileSync(
      new URL('../src/renderer/src/App.vue', import.meta.url),
      'utf8'
    )

    for (const internalCopy of [
      '必要时自动升级',
      '固定 6 个任务槽位',
      '新同步任务将使用最新版',
      '公开数据 AI',
      'Codex 资料同步插件',
      '官方个人快照',
      '本地基准补齐',
      '插件不会静默安装',
      'Codex/MCP',
      'Agent 已连接'
    ]) {
      expect(app).not.toContain(internalCopy)
    }
    expect(app).not.toContain('<option value="smart">智能（推荐）</option>')
    expect(app).toContain('所有后台任务使用这里选择的模型与推理强度。')
    expect(app).toContain('需要安装同步插件')
    expect(app).toContain('同步公开数据需要插件；同步个人数据时也会用它补充和校正清单信息。')
    expect(app).toContain('result.sources.some((source) => source.requiresCodexPlugin)')
  })

  it('同步周期事项不展示内部校时说明', () => {
    const app = readFileSync(
      new URL('../src/renderer/src/App.vue', import.meta.url),
      'utf8'
    )
    const cycleCatalog = readFileSync(
      new URL('../src/main/sync/cycle-catalog.ts', import.meta.url),
      'utf8'
    )

    expect(app).toContain("row.item.resetRule && row.item.source === 'manual'")
    expect(cycleCatalog).not.toContain('按官方周期校准')
  })

  it('同步界面只用结构化字段生成固定阶段文案', () => {
    const app = readFileSync(
      new URL('../src/renderer/src/App.vue', import.meta.url),
      'utf8'
    )
    const displayCopy = readFileSync(
      new URL('../src/renderer/src/sync-display-copy.ts', import.meta.url),
      'utf8'
    )
    const progressProjection = readFileSync(
      new URL('../src/shared/sync-progress.ts', import.meta.url),
      'utf8'
    )

    expect(app).toContain('userFacingProgressMessage(progress)')
    expect(app).toContain('syncResultNotice(result)')
    expect(app).toContain('projectAiJobProgressPhase(job)')
    expect(app).not.toContain('交叉核验')
    expect(displayCopy).toContain('progress.message is an internal diagnostic and is never rendered')
    for (const internalCopy of [
      'INTERNAL_SYNC_COPY',
      'normalizeSyncCopy',
      'observedStatus',
      'completionRule',
      'fieldPath',
      'personal_review',
      'contentLocale'
    ]) {
      expect(displayCopy).not.toContain(internalCopy)
    }
    expect(progressProjection).toContain("job.jobKind === 'personal_review'")
    expect(progressProjection).toContain("? 'writing'")
    expect(progressProjection).toContain(": 'verifying'")
  })

  it('系统清单不提供删除入口，设置页更新控件保持统一尺寸', () => {
    const app = readFileSync(
      new URL('../src/renderer/src/App.vue', import.meta.url),
      'utf8'
    )
    const styles = readFileSync(
      new URL('../src/renderer/src/styles.css', import.meta.url),
      'utf8'
    )

    expect(app).toContain('v-if="panel.allowClear === true"')
    expect(app).toContain("editingItem?.source === 'manual'")
    expect(app).toContain('手动删除的事项会保留在本机')
    expect(app).toContain('启动后自动检查更新')
    expect(app).toContain('检查更新')
    expect(app).toContain('>默认顺序</button>')
    expect(app).not.toContain('恢复默认顺序')
    expect(app).toContain('class="sidebar-action-count"')
    expect(styles).toContain('.software-update-footer { display: grid; grid-template-columns: minmax(0, 1fr) max-content;')
    expect(styles).toContain('.settings-action-button { box-sizing: border-box; min-width: 112px; height: var(--control-height);')
    expect(styles).toContain('.settings-modal button:not(.close-button) { box-sizing: border-box; width: 112px; min-width: 112px; height: var(--control-height);')
    expect(styles).not.toContain('.sidebar-footer button > span:last-child')
  })
})
