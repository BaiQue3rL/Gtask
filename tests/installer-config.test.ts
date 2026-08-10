import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Windows installer directory', () => {
  it('treats a selected directory as the parent of the Gtask install folder', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as {
      scripts?: Record<string, string>
      build?: {
        electronLanguages?: string[]
        nsis?: {
          include?: string
          allowToChangeInstallationDirectory?: boolean
          createDesktopShortcut?: boolean
          runAfterFinish?: boolean
          deleteAppDataOnUninstall?: boolean
        }
      }
    }
    const installer = readFileSync(
      new URL('../build/installer.nsh', import.meta.url),
      'utf8'
    )

    expect(packageJson.build?.nsis?.include).toBe('build/installer.nsh')
    expect(packageJson.build?.nsis?.allowToChangeInstallationDirectory).toBe(false)
    expect(packageJson.build?.nsis?.createDesktopShortcut).toBe(false)
    expect(packageJson.build?.nsis?.runAfterFinish).toBe(true)
    expect(packageJson.build?.nsis?.deleteAppDataOnUninstall).toBe(false)
    expect(packageJson.build?.electronLanguages).toEqual(['en-US', 'zh-CN', 'zh-TW'])
    expect(installer).toContain('!macro EnsureGtaskInstallDirectory PATH_VAR SCRATCH_VAR')
    expect(installer).toContain('!macro customPageAfterChangeDir')
    expect(installer).toContain('Page custom GtaskDirectoryPageCreate GtaskDirectoryPageLeave')
    expect(installer).toContain('Function GtaskDirectoryBrowse')
    expect(installer).toContain('${NSD_SetText} $GtaskDirectoryInput "$0"')
    expect(installer).toContain('SendMessage $GtaskDirectoryInput ${EM_SETSEL} 0 0')
    expect(installer).toContain('StrCpy ${PATH_VAR} "${PATH_VAR}\\${APP_FILENAME}"')
    expect(installer).toContain('Function GtaskDirectoryPageLeave')
    expect(installer).toContain('ShowInstDetails show')
    const packageScript = readFileSync(
      new URL('../scripts/build-installer-with-details.mjs', import.meta.url),
      'utf8'
    )
    expect(packageJson.scripts?.['package:installer']).toContain('build-installer-with-details.mjs')
    expect(packageJson.scripts?.['package:portable']).toContain('--publish never')
    expect(packageScript).toContain("'--publish', 'never'")
    expect(packageScript).toContain('SetDetailsPrint both')
    expect(packageScript).toContain('正在检查并移除现有版本…')
    expect(packageScript).toContain('正在解压程序文件…')
    expect(packageScript).toContain('程序文件已安装')
    expect(packageScript).toContain('正在写入安装信息…')
    expect(packageScript).toContain('正在创建快捷方式…')
    expect(packageScript).toContain("writeFileSync(installSectionPath, original, 'utf8')")
    expect(installer).toContain('!macro customInstall')
    expect(installer).toContain('Gtask 安装完成')
    expect(installer).toContain('!macro customFinishPage')
    expect(installer).toContain('MUI_FINISHPAGE_SHOWREADME_TEXT "创建桌面快捷方式"')
    expect(installer).toContain('MUI_FINISHPAGE_RUN_TEXT "运行 Gtask"')
    expect(installer).toContain('Function GtaskCreateDesktopShortcut')
  })
})
