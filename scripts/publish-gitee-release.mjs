import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { giteeResourceId, isMissingGiteeRelease } from './gitee-release-api.mjs'

const owner = process.env.GITEE_OWNER?.trim() || 'l3rui'
const repo = process.env.GITEE_REPO?.trim() || 'Gtask'
const token = process.env.GITEE_TOKEN?.trim() || ''
const apiBase = (process.env.GITEE_API_BASE_URL?.trim() || 'https://gitee.com/api/v5')
  .replace(/\/$/, '')
const assetDirectory = process.env.GITEE_RELEASE_ASSET_DIR?.trim() || 'release'
const dryRun = process.env.GITEE_RELEASE_DRY_RUN === '1'
const waitTimeoutMs = Number(process.env.GITEE_MIRROR_WAIT_MS || 300_000)
const pollIntervalMs = Number(process.env.GITEE_MIRROR_POLL_MS || 5_000)

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
const version = packageJson.version
const tag = `v${version}`
const releaseName = `Gtask ${version}`
const releaseBody = await readFile(`docs/release-notes-${version}.md`, 'utf8')
const assetPaths = [
  join(assetDirectory, `Gtask-${version}-setup.exe`),
  join(assetDirectory, `Gtask-${version}-portable.exe`),
  join(assetDirectory, 'SHA256SUMS.txt')
]

for (const assetPath of assetPaths) {
  const details = await stat(assetPath)
  if (!details.isFile() || details.size === 0) throw new Error(`发布附件无效：${assetPath}`)
}

if (dryRun) {
  console.log(`Gitee Release dry-run: ${owner}/${repo} ${tag}`)
  for (const assetPath of assetPaths) console.log(`- ${assetPath}`)
  process.exit(0)
}

if (!token) throw new Error('缺少 GITEE_TOKEN，无法发布 Gitee Release')
if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
  throw new Error('GITEE_MIRROR_WAIT_MS 必须是非负数')
}
if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
  throw new Error('GITEE_MIRROR_POLL_MS 必须是正数')
}

function endpoint(path, includeToken = false) {
  const url = new URL(`${apiBase}${path}`)
  if (includeToken) url.searchParams.set('access_token', token)
  return url
}

async function requestJson(path, options = {}) {
  const {
    method = 'GET',
    form,
    acceptedStatuses = []
  } = options
  const response = await fetch(endpoint(path, method === 'GET' || method === 'DELETE'), {
    method,
    body: form
  })
  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    const message = typeof payload === 'string'
      ? payload.slice(0, 300)
      : JSON.stringify(payload)?.slice(0, 300)
    throw new Error(`Gitee API 返回 HTTP ${response.status}${message ? `：${message}` : ''}`)
  }
  return { status: response.status, payload }
}

async function waitForMirroredTag() {
  const startedAt = Date.now()
  while (true) {
    const { payload } = await requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags?per_page=100`
    )
    if (Array.isArray(payload) && payload.some((candidate) => candidate?.name === tag)) return
    if (Date.now() - startedAt >= waitTimeoutMs) {
      throw new Error(`等待 Gitee 镜像同步标签 ${tag} 超时`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

function releaseForm(includeTarget = false) {
  const form = new FormData()
  form.set('access_token', token)
  form.set('tag_name', tag)
  form.set('name', releaseName)
  form.set('body', releaseBody)
  form.set('prerelease', 'false')
  if (includeTarget) form.set('target_commitish', tag)
  return form
}

async function upsertRelease() {
  const tagPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/releases/tags/${encodeURIComponent(tag)}`
  const existing = await requestJson(tagPath, { acceptedStatuses: [404] })
  if (isMissingGiteeRelease(existing.status, existing.payload)) {
    const created = await requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`,
      { method: 'POST', form: releaseForm(true) }
    )
    return created.payload
  }
  const releaseId = giteeResourceId(existing.payload?.id)
  if (!releaseId) throw new Error('Gitee Release 缺少有效 ID')
  const updated = await requestJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${releaseId}`,
    { method: 'PATCH', form: releaseForm() }
  )
  return updated.payload
}

async function replaceAttachments(release) {
  const releaseId = giteeResourceId(release?.id)
  if (!releaseId) throw new Error('Gitee Release 缺少有效 ID')
  const basePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/releases/${releaseId}/attach_files`
  const listed = await requestJson(`${basePath}?per_page=100`)
  const attachments = Array.isArray(listed.payload) ? listed.payload : []
  const expectedNames = new Set(assetPaths.map((assetPath) => basename(assetPath)))

  for (const attachment of attachments) {
    const attachmentId = giteeResourceId(attachment?.id)
    if (!expectedNames.has(attachment?.name) || !attachmentId) continue
    await requestJson(`${basePath}/${attachmentId}`, { method: 'DELETE' })
  }

  for (const assetPath of assetPaths) {
    const fileName = basename(assetPath)
    const form = new FormData()
    form.set('access_token', token)
    form.set('file', new Blob([await readFile(assetPath)]), fileName)
    await requestJson(basePath, { method: 'POST', form })
    console.log(`已上传 Gitee Release 附件：${fileName}`)
  }
}

await waitForMirroredTag()
const release = await upsertRelease()
await replaceAttachments(release)
console.log(`Gitee Release 已发布：https://gitee.com/${owner}/${repo}/releases/tag/${tag}`)
