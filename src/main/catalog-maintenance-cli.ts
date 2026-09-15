import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateCatalogPublication } from './catalog-validation'
import { compileCatalogDelta } from './catalog-compiler'
import { writeFileAtomically } from './atomic-file'

try {
  const args = process.argv.slice(2)
  const usage = '用法：pnpm catalog:check [--input 文件] [--inventory]，或 --base 当前清单 --delta 核验差异 --output 生成清单'
  if (args.includes('--delta')) {
    if (args.length !== 6 || new Set(args.filter((_, index) => index % 2 === 0)).size !== 3 ||
      !['--base', '--delta', '--output'].every((key) => args.indexOf(key) >= 0 && args.indexOf(key) % 2 === 0)) throw new Error(usage)
    const read = (key: string) => JSON.parse(readFileSync(resolve(args[args.indexOf(key) + 1]), 'utf8'))
    const result = compileCatalogDelta(read('--base'), read('--delta'))
    const output = resolve(args[args.indexOf('--output') + 1])
    writeFileAtomically(output, `${JSON.stringify(result.feed, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ ok: true, output, changed: result.changed, ...result.validation }, null, 2)}\n`)
  } else {
    const inventory = args.includes('--inventory')
    const options = args.filter((value) => value !== '--inventory')
    if (options.length !== 0 && (options.length !== 2 || options[0] !== '--input')) throw new Error(usage)
    const input = resolve(options.length ? options[1] : 'updates/catalog.json')
    const result = validateCatalogPublication(JSON.parse(readFileSync(input, 'utf8')), { inventory })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '清单检查失败' })}\n`)
  process.exitCode = 1
}
