import { JobWorker, type WorkerOptions } from '../worker.js';
import type { JobType } from '../types.js';

/**
 * Job-handler registration and default concurrency (Section 5.1, 35.3, 35.4).
 *
 * Subsystems keep independent concurrency caps: reviews are bounded by
 * AGENT_MAX_CONCURRENCY (default 1), backfills by BACKFILL_CONCURRENCY (default
 * 2), and sends are serialized. Concrete handlers are registered by the
 * subsystems that own them (ingestion, episodes, agent, outbox); this module
 * supplies the default caps and the worker factory.
 */

export type JobCategory = 'reviews' | 'sends' | 'backfills' | 'other';

/** Map a job type to its subsystem category. */
export function categoryOf(type: JobType): JobCategory {
  switch (type) {
    case 'review_episode':
    case 'review_due_memories':
    case 'review_due_memory_cohort':
    case 'direct_answer':
    case 'deep_recap':
      return 'reviews';
    case 'send_outbox':
    case 'sync_proposal_review':
    case 'deliver_channel_policy_review':
      return 'sends';
    case 'backfill_channel':
    case 'build_historical_episodes':
    case 'reconcile_channel':
    case 'recover_message':
    case 'discover_threads':
      return 'backfills';
    default:
      return 'other';
  }
}

/** Default per-category caps (Section 35.3 BACKFILL_CONCURRENCY, 35.4 AGENT_MAX_CONCURRENCY). */
export const DEFAULT_CONCURRENCY: Record<JobCategory, number> = {
  reviews: 1,
  sends: 1,
  backfills: 2,
  other: 1,
};

/** The default cap for a job type, derived from its category. */
export function defaultConcurrencyFor(type: JobType): number {
  return DEFAULT_CONCURRENCY[categoryOf(type)];
}

/** Build a worker with the given runtime options but no handlers registered yet. */
export function createJobWorker(opts: WorkerOptions): JobWorker {
  return new JobWorker(opts);
}
