// Preserve the original package. The separate harness only sets isolated paths
// before loading the byte-identical packaged application, never player data.
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'

const workspace = resolve('.')
const argument = (flag, fallback) => { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1] }
const packageDirectory = resolve(argument('--package-directory', 'tmp/goal-package'))
const source = join(packageDirectory, 'win-unpacked')
const target = resolve(argument('--harness-directory', 'tmp/goal-package-audit'))
for (const path of [source, target]) assert.ok(relative(workspace, path).startsWith(`tmp${process.platform === 'win32' ? '\\' : '/'}`))
assert.equal(existsSync(target), false, 'Keep any previous audit; choose a new target instead of overwriting it')
cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
const resources = join(target, 'resources')
const originalArchive = join(resources, 'app.asar')
const payloadArchive = join(resources, 'app-payload.asar')
assert.equal(relative(resources, originalArchive), 'app.asar')
assert.equal(relative(resources, payloadArchive), 'app-payload.asar')
renameSync(originalArchive, payloadArchive)
const wrapper = join(resources, 'app')
mkdirSync(wrapper)
const metadata = JSON.parse(readFileSync('package.json', 'utf8'))
writeFileSync(join(wrapper, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: 'audit-bootstrap.cjs' }))
writeFileSync(join(wrapper, 'audit-bootstrap.cjs'), `
const assert = require('node:assert/strict');
const { resolve, relative, dirname, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { app } = require('electron');
const documents = resolve(process.env.GTASK_AUDIT_DOCUMENTS || 'invalid');
const userData = resolve(process.env.GTASK_AUDIT_USER_DATA || 'invalid');
assert.equal(dirname(documents), dirname(userData));
assert.ok(basename(dirname(documents)).startsWith('gtask-ui-audit-'));
const beneathTemporaryRoot = relative(resolve(tmpdir()), documents);
assert.ok(beneathTemporaryRoot && !beneathTemporaryRoot.startsWith('..') && !require('node:path').isAbsolute(beneathTemporaryRoot));
app.setPath('documents', documents);
app.setPath('userData', userData);
require('../app-payload.asar/out/main/index.js');
`)
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const originalHash = hash(join(source, 'resources/app.asar'))
assert.equal(hash(payloadArchive), originalHash)
assert.equal(hash(join(source, 'Gtask.exe')), hash(join(target, 'Gtask.exe')))
const result = { executablePath: join(target, 'Gtask.exe'), originalArchiveSha256: originalHash,
  executableSha256: hash(join(source, 'Gtask.exe')), isolation: 'test bootstrap sets paths before unmodified packaged main loads' }
writeFileSync(join(packageDirectory, 'audit-manifest.json'), JSON.stringify(result, null, 2))
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
