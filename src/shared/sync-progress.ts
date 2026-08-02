import type { AiScheduleJob, SyncProgressPhase } from './contracts'

/**
 * Projects implementation-specific AI job phases onto the stable phase
 * vocabulary exposed to the product UI.  Personal review and metadata jobs
 * are always shown as review/update work even if an Agent reports a more
 * implementation-oriented phase.
 */
export function projectAiJobProgressPhase(
  job: Pick<AiScheduleJob, 'jobKind' | 'status' | 'progressPhase'>
): SyncProgressPhase {
  if (job.status === 'pending') return 'queued'
  if (job.status === 'completed') return 'completed'
  if (job.status === 'failed') return 'failed'
  if (job.progressPhase === 'retrying' || job.progressPhase === 'verification') {
    return job.progressPhase
  }
  if (job.jobKind === 'personal_review' || job.jobKind === 'personal_metadata') {
    return job.progressPhase === 'writing' || job.progressPhase === 'merging'
      ? 'writing'
      : 'verifying'
  }
  if (job.progressPhase === 'fetching') return 'searching'
  if (job.progressPhase === 'merging') return 'writing'
  return job.progressPhase
}
