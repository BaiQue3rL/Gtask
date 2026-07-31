export interface AdaptiveColumnLayout {
  height: number
  constrainedIndex: number
}

const HEIGHT_TOLERANCE_PX = 8

export function resolveAdaptiveColumnLayout(
  heights: readonly number[]
): AdaptiveColumnLayout | null {
  if (heights.length !== 2 || heights.some((height) => !Number.isFinite(height) || height <= 0)) {
    return null
  }
  const [firstHeight, secondHeight] = heights
  if (Math.abs(firstHeight - secondHeight) < HEIGHT_TOLERANCE_PX) return null
  return {
    height: Math.round(Math.min(firstHeight, secondHeight)),
    constrainedIndex: firstHeight > secondHeight ? 0 : 1
  }
}
