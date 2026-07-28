import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const rootPackages = ['@modelcontextprotocol/sdk', 'zod']
const visited = new Set()
const notices = []

function findPackageRoot(entryPath) {
  let directory = dirname(entryPath)
  const root = parse(directory).root
  while (directory !== root) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (manifest.name && manifest.version) return { directory, manifest }
    } catch {
      // Continue walking toward the package root.
    }
    directory = dirname(directory)
  }
  throw new Error(`无法定位依赖包目录：${entryPath}`)
}

function resolvePackage(packageName, fromDirectory) {
  let searchDirectory = fromDirectory
  const root = parse(searchDirectory).root
  while (searchDirectory !== root) {
    const directManifestPath = join(
      searchDirectory,
      'node_modules',
      ...packageName.split('/'),
      'package.json'
    )
    if (existsSync(directManifestPath)) {
      const directory = realpathSync(dirname(directManifestPath))
      return {
        directory,
        manifest: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      }
    }
    searchDirectory = dirname(searchDirectory)
  }
  const localRequire = createRequire(join(fromDirectory, 'package.json'))
  return findPackageRoot(localRequire.resolve(packageName))
}

function visitPackage(packageName, fromDirectory) {
  const { directory, manifest } = resolvePackage(packageName, fromDirectory)
  const key = `${manifest.name}@${manifest.version}`
  if (visited.has(key)) return
  visited.add(key)

  const licenseFile = readdirSync(directory).find((name) =>
    /^(licen[cs]e|copying)(\.|$)/i.test(name)
  )
  notices.push({
    key,
    homepage: manifest.homepage ?? manifest.repository?.url ?? '',
    declaredLicense: manifest.license ?? '未声明',
    licenseText: licenseFile
      ? readFileSync(join(directory, licenseFile), 'utf8').trim()
      : `Package declares license: ${manifest.license ?? 'unknown'}`
  })

  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {})
  }
  for (const dependencyName of Object.keys(dependencies)) {
    visitPackage(dependencyName, directory)
  }
}

for (const packageName of rootPackages) visitPackage(packageName, projectRoot)
notices.sort((left, right) => left.key.localeCompare(right.key))

const content = [
  'Gtask 第三方软件声明',
  '========================',
  '',
  '本文件由 scripts/generate-third-party-notices.mjs 根据实际锁定依赖生成。',
  '',
  ...notices.flatMap((notice) => [
    '------------------------------------------------------------------------',
    notice.key,
    `License: ${notice.declaredLicense}`,
    notice.homepage ? `Homepage: ${notice.homepage}` : '',
    '',
    notice.licenseText,
    ''
  ].filter(Boolean))
].join('\n')

writeFileSync(join(projectRoot, 'THIRD_PARTY_NOTICES.txt'), `${content}\n`, 'utf8')
process.stdout.write(`已生成 ${notices.length} 个第三方依赖声明。\n`)
