import {
  officialPersonalFactAuthority,
  type NormalizedSyncItem,
  type SemanticReviewDraft
} from './types'

export function toCycleReviewCandidates(
  provider: 'miyoushe' | 'kuro-community',
  items: NormalizedSyncItem[]
): SemanticReviewDraft[] {
  return items
    .filter((item) => item.category === 'endgame')
    .map((item) => ({
      target: 'cycles',
      kind: 'personal-challenge-record',
      payload: {
        factAuthority: officialPersonalFactAuthority(
          'identity',
          'localized_title',
          'time_window',
          'challenge_record'
        ),
        provider,
        observedRemoteKey: item.remoteKey,
        observedTitle: item.title,
        observedHasChallengeRecord: item.completed === true,
        observedStartsAt: item.startsAt ?? null,
        observedEndsAt: item.endsAt ?? null,
        observedPeriodKey: item.periodKey ?? null,
        observedModeKey: item.modeKey ?? null
      }
    }))
}
