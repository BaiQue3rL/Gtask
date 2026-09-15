import { finiteNumber } from './numbers'

export interface ChallengeRecordEvidence {
  explicitFlags?: readonly unknown[]
  positiveValues?: readonly unknown[]
  /** An endpoint returned a complete, empty list of eligible manual records. */
  knownEmpty?: boolean
}

/**
 * A challenge counts as attempted only when an endpoint exposes an explicit
 * record flag or a verified numeric result. Pre-generated floors, teams,
 * halves, nodes, and other collection shapes are deliberately not evidence.
 */
export function hasChallengeRecordEvidence(
  evidence: ChallengeRecordEvidence
): boolean | undefined {
  if (
    evidence.explicitFlags?.some((value) => value === true) ||
    evidence.positiveValues?.some((value) => (finiteNumber(value) ?? 0) > 0)
  ) return true
  if (evidence.knownEmpty ||
    evidence.explicitFlags?.some((value) => value === false) ||
    evidence.positiveValues?.some((value) => finiteNumber(value) === 0)) return false
  // Missing/invalid fields are not an observation that the player did nothing.
  return undefined
}
