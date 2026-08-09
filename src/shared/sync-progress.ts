import type { AiScheduleJob, SyncProgressPhase } from './contracts'

/** Projects background baseline-maintenance phases onto stable product phases. */
export function projectAiJobProgressPhase(
  job: Pick<AiScheduleJob, 'jobKind' | 'status' | 'progressPhase'>
): SyncProgressPhase {
  if (job.status === 'pending') return 'queued'
  if (job.status === 'completed') return 'completed'
  if (job.status === 'failed') return 'failed'
  if (job.progressPhase === 'retrying' || job.progressPhase === 'verification') {
    return job.progressPhase
  }
  if (job.progressPhase === 'fetching') return 'searching'
  if (job.progressPhase === 'merging') return 'writing'
  return job.progressPhase
}
