/**
 * 米游社同一个确定性数值字段在不同接口或版本中可能返回 JSON number
 * 或十进制字符串。这里只做结果唯一的机械转换，不解释字段语义。
 */
export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
