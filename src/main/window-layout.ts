export const PORTRAIT_WINDOW_ASPECT_RATIO = 3 / 4

export interface WorkAreaSize {
  width: number
  height: number
}

export interface PortraitWindowSize {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

const PREFERRED_HEIGHT = 1000
const PREFERRED_MIN_HEIGHT = 720
const WORK_AREA_MARGIN = 24

/**
 * Fits the single portrait layout inside the current display without creating
 * a separate landscape branch. Width is always derived from height so both
 * the initial and minimum bounds use the same 3:4 ratio.
 */
export function calculatePortraitWindowSize(workArea: WorkAreaSize): PortraitWindowSize {
  const availableHeight = Math.max(480, Math.floor(workArea.height - WORK_AREA_MARGIN))
  const availableWidthAsHeight = Math.max(
    480,
    Math.floor((workArea.width - WORK_AREA_MARGIN) / PORTRAIT_WINDOW_ASPECT_RATIO)
  )
  const height = Math.min(PREFERRED_HEIGHT, availableHeight, availableWidthAsHeight)
  const width = Math.round(height * PORTRAIT_WINDOW_ASPECT_RATIO)
  const minHeight = Math.min(PREFERRED_MIN_HEIGHT, height)
  const minWidth = Math.round(minHeight * PORTRAIT_WINDOW_ASPECT_RATIO)
  return { width, height, minWidth, minHeight }
}
