import type { SemanticReviewDraft } from './types'

function validTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

export function isSemanticReviewDraftRelevant(
  draft: SemanticReviewDraft,
  reference = new Date()
): boolean {
  if (draft.target === 'exploration') return true
  const endField = draft.target === 'events' ? 'normalizedEndAt' : 'observedEndsAt'
  const endsAt = validTimestamp(draft.payload[endField])
  return endsAt === null || endsAt > reference.getTime()
}

export function filterRelevantSemanticReviewDrafts(
  drafts: SemanticReviewDraft[],
  reference = new Date()
): SemanticReviewDraft[] {
  return drafts.filter((draft) => isSemanticReviewDraftRelevant(draft, reference))
}
