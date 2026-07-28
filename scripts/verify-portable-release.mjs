import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const releaseDirectory = resolve(projectRoot, process.argv[2] ?? 'release')
const artifactPath = join(
  releaseDirectory,
  `${packageJson.build.productName}-${packageJson.version}-portable.exe`
)
const unpackedExecutablePath = join(
  releaseDirectory,
  'win-unpacked',
  `${packageJson.build.productName}.exe`
)
const asarPath = join(releaseDirectory, 'win-unpacked', 'resources', 'app.asar')

function requireFile(path, minimumBytes) {
  if (!existsSync(path)) throw new Error(`缺少发布文件：${path}`)
  const sizeBytes = statSync(path).size
  if (sizeBytes < minimumBytes) throw new Error(`发布文件异常过小：${path}`)
  return sizeBytes
}

function requirePortableExecutable(path) {
  const header = readFileSync(path).subarray(0, 2).toString('ascii')
  if (header !== 'MZ') throw new Error(`Windows 可执行文件头不正确：${path}`)
}

const artifactSizeBytes = requireFile(artifactPath, 10 * 1024 * 1024)
const unpackedSizeBytes = requireFile(unpackedExecutablePath, 1024 * 1024)
const asarSizeBytes = requireFile(asarPath, 500 * 1024)
requirePortableExecutable(artifactPath)
requirePortableExecutable(unpackedExecutablePath)

const asarBytes = readFileSync(asarPath)
for (const requiredName of ['LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
  if (!asarBytes.includes(Buffer.from(requiredName))) {
    throw new Error(`app.asar 缺少发布声明：${requiredName}`)
  }
}

const sha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
process.stdout.write(
  `${JSON.stringify(
    {
      artifactPath,
      artifactSizeBytes,
      unpackedSizeBytes,
      asarSizeBytes,
      sha256
    },
    null,
    2
  )}\n`
)
