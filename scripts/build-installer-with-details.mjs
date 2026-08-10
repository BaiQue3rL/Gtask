import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const electronBuilderPackage = require.resolve('electron-builder/package.json')
const appBuilderPackage = require.resolve('app-builder-lib/package.json', {
  paths: [dirname(electronBuilderPackage)]
})
const installSectionPath = join(
  dirname(appBuilderPackage),
  'templates',
  'nsis',
  'installSection.nsh'
)
const original = readFileSync(installSectionPath, 'utf8')

function replaceOnce(source, expected, replacement) {
  const index = source.indexOf(expected)
  if (index < 0 || source.indexOf(expected, index + expected.length) >= 0) {
    throw new Error(`electron-builder 安装模板与已核验版本不一致：${expected}`)
  }
  return `${source.slice(0, index)}${replacement}${source.slice(index + expected.length)}`
}

let patched = original
patched = replaceOnce(
  patched,
  '  SetDetailsPrint none',
  '  SetDetailsPrint both\n  DetailPrint "正在准备安装 Gtask…"'
)
patched = replaceOnce(
  patched,
  '!insertmacro uninstallOldVersion SHELL_CONTEXT\n!insertmacro handleUninstallResult SHELL_CONTEXT',
  'DetailPrint "正在检查并移除现有版本…"\n!insertmacro uninstallOldVersion SHELL_CONTEXT\n!insertmacro handleUninstallResult SHELL_CONTEXT\nDetailPrint "现有版本检查完成"'
)
patched = replaceOnce(
  patched,
  '!insertmacro installApplicationFiles\n!insertmacro registryAddInstallInfo\n!insertmacro addStartMenuLink $keepShortcuts\n!insertmacro addDesktopLink $keepShortcuts',
  [
    'DetailPrint "正在解压程序文件…"',
    '!insertmacro installApplicationFiles',
    'DetailPrint "程序文件已安装"',
    'DetailPrint "正在写入安装信息…"',
    '!insertmacro registryAddInstallInfo',
    'DetailPrint "安装信息已写入"',
    'DetailPrint "正在创建快捷方式…"',
    '!insertmacro addStartMenuLink $keepShortcuts',
    '!insertmacro addDesktopLink $keepShortcuts',
    'DetailPrint "快捷方式已创建"'
  ].join('\n')
)

try {
  writeFileSync(installSectionPath, patched, 'utf8')
  const cliPath = require.resolve('electron-builder/cli.js')
  const result = spawnSync(
    process.execPath,
    [cliPath, '--win', 'nsis', '--publish', 'never'],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit'
    }
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
} finally {
  writeFileSync(installSectionPath, original, 'utf8')
}
