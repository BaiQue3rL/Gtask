import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import Tesseract from 'tesseract.js'
import chiSim from '@tesseract.js-data/chi_sim'
import type { ScheduleImageDraft, SyncTarget } from '../shared/contracts'
import { parseScheduleImageText } from './schedule-image-parser'

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
const MAXIMUM_IMAGE_BYTES = 25 * 1024 * 1024

export interface ScheduleImageOcrOptions {
  langPath?: string
  workerPath?: string
  onProgress?: (progress: number) => void
}

export async function recognizeScheduleImage(
  imagePath: string,
  target: Exclude<SyncTarget, 'all' | 'tasks'>,
  options: ScheduleImageOcrOptions = {}
): Promise<ScheduleImageDraft> {
  const extension = extname(imagePath).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error('只支持 PNG、JPG、WEBP 或 BMP 图片')
  const metadata = await stat(imagePath)
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAXIMUM_IMAGE_BYTES) {
    throw new Error('排期图片为空或超过 25MB')
  }

  const worker = await Tesseract.createWorker(chiSim.code, Tesseract.OEM.LSTM_ONLY, {
    langPath: options.langPath ?? chiSim.langPath,
    workerPath: options.workerPath,
    gzip: true,
    logger: (message) => options.onProgress?.(message.progress)
  })
  try {
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT })
    const result = await worker.recognize(imagePath)
    const rawText = result.data.text.trim()
    if (!rawText) throw new Error('图片中没有识别到文字')
    const candidates = parseScheduleImageText(rawText).map((candidate) => ({
      ...candidate,
      category: target === 'cycles'
        ? 'endgame' as const
        : target === 'exploration'
          ? 'exploration' as const
          : candidate.category
    }))
    return {
      fileName: basename(imagePath),
      rawText,
      confidence: Math.max(0, Math.min(100, result.data.confidence)) / 100,
      sourceTimeZone: 'Asia/Shanghai',
      candidates
    }
  } finally {
    await worker.terminate()
  }
}
