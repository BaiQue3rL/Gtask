import { createHash, randomUUID } from 'node:crypto'
import type { ScheduleImageCandidate } from '../shared/contracts'

const RANGE_PATTERN = /(?:(\d{4})\s*[年./-]\s*)?(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:[-~～—至到]\s*)(?:(\d{4})\s*[年./-]\s*)?(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*[:：]\s*(\d{2})/g

export function parseScheduleImageText(
  rawText: string,
  reference = new Date(),
  sourceOffsetMinutes = 8 * 60
): ScheduleImageCandidate[] {
  const text = rawText.replaceAll('\r', '').replace(/[ \t]+/g, ' ').trim()
  const candidates: ScheduleImageCandidate[] = []
  for (const match of text.matchAll(RANGE_PATTERN)) {
    const startYear = Number(match[1] || reference.getUTCFullYear())
    let endYear = Number(match[6] || startYear)
    const startsAt = toOffsetIso(
      startYear,
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      sourceOffsetMinutes
    )
    let endsAt = toOffsetIso(
      endYear,
      Number(match[7]),
      Number(match[8]),
      Number(match[9]),
      Number(match[10]),
      sourceOffsetMinutes
    )
    if (Date.parse(endsAt) <= Date.parse(startsAt) && !match[6]) {
      endYear += 1
      endsAt = toOffsetIso(
        endYear,
        Number(match[7]),
        Number(match[8]),
        Number(match[9]),
        Number(match[10]),
        sourceOffsetMinutes
      )
    }
    if (Date.parse(endsAt) <= Date.parse(startsAt)) continue
    const title = titleBeforeRange(text, match.index ?? 0)
    const warnings: string[] = []
    if (!match[1] || !match[6]) warnings.push('图片未完整标注年份，请核对跨年情况')
    if (!title || title === '未识别活动名称') warnings.push('未可靠识别名称，请手动填写')
    const stableKey = createHash('sha256')
      .update(`${title}|${startsAt}|${endsAt}`)
      .digest('hex')
      .slice(0, 16)
    if (candidates.some((item) => item.id === stableKey)) continue
    candidates.push({
      id: stableKey || randomUUID(),
      category: 'limited_event',
      title,
      startsAt,
      endsAt,
      confidence: warnings.length === 0 ? 0.82 : 0.58,
      warnings
    })
  }
  return candidates
}

function titleBeforeRange(text: string, rangeIndex: number): string {
  const prefix = text.slice(0, rangeIndex)
  const sameLine = prefix.slice(prefix.lastIndexOf('\n') + 1).replace(/[：:·|｜]+$/g, '').trim()
  const lines = prefix.split('\n').map((line) => line.trim()).filter(Boolean)
  const candidate = sameLine || lines.at(-1)?.replace(/[：:·|｜]+$/g, '').trim() || ''
  if (!candidate || /^\d/.test(candidate) || candidate.length > 100) return '未识别活动名称'
  return candidate
}

function toOffsetIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  offsetMinutes: number
): string {
  const timestamp = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60 * 1000
  const date = new Date(timestamp)
  const sourceLocal = new Date(timestamp + offsetMinutes * 60 * 1000)
  if (
    !Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31 ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59 || Number.isNaN(date.getTime()) ||
    sourceLocal.getUTCFullYear() !== year || sourceLocal.getUTCMonth() !== month - 1 ||
    sourceLocal.getUTCDate() !== day || sourceLocal.getUTCHours() !== hour ||
    sourceLocal.getUTCMinutes() !== minute
  ) throw new Error('图片中的日期时间格式不正确')
  return date.toISOString()
}
