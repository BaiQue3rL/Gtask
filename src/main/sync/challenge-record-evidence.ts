import { finiteNumber } from './numbers'

export interface ChallengeRecordEvidence {
  explicitFlags?: readonly unknown[]
  positiveValues?: readonly unknown[]
}

/**
 * A challenge counts as attempted only when an endpoint exposes an explicit
 * record flag or a verified numeric result. Pre-generated floors, teams,
 * halves, nodes, and other collection shapes are deliberately not evidence.
 */
export function hasChallengeRecordEvidence(
  evidence: ChallengeRecordEvidence
): boolean {
  return Boolean(
    evidence.explicitFlags?.some((value) => value === true) ||
    evidence.positiveValues?.some((value) => (finiteNumber(value) ?? 0) > 0)
  )
}
