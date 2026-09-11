import { type DatabaseSync } from '../../db/database.js';
import {
  expirePendingProposals,
  PROPOSAL_EXPIRY_BATCH_SIZE,
} from '../../db/repositories/proposals.js';
import type { Logger } from '../../logger.js';
import type { JobHandler } from '../worker.js';
import type { JobRow } from '../types.js';

/**
 * Proposal-expiry maintenance step (Sections 10, 25, 28).
 *
 * The periodic scheduler enqueues one durable `maintenance` job
 * (`schedule:maintenance`). Proposal expiry is the first step of that bundle:
 * finalize every `pending_review` proposal whose 72-hour deadline has passed as
 * `expired` so the review queue cannot accumulate stale interventions forever.
 *
 * The work is delegated to the idempotent {@link expirePendingProposals}, which
 * only ever touches past-deadline `pending_review` rows — never approved, sent,
 * dismissed, observed, or already-expired proposals. Re-running the job is a safe
 * no-op. The handler logs only counts and ids (no content or secrets).
 *
 * {@link runExpiry} is exposed so a future, fuller maintenance handler can
 * compose this step alongside WAL checkpoints and `PRAGMA optimize` rather than
 * owning the whole `maintenance` type.
 */

export interface ExpireProposalsHandlerDeps {
  db: DatabaseSync;
  /** Inject a clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  logger?: Logger;
}

export interface ExpireProposalsResult {
  /** Epoch ms at which the sweep ran. */
  now: number;
  /** Proposal ids transitioned to `expired` this pass. */
  expiredIds: string[];
}

/** Build the proposal-expiry step as a `maintenance` job handler. */
export function createExpireProposalsHandler(
  deps: ExpireProposalsHandlerDeps,
): JobHandler<'maintenance'> & {
  runExpiry(): Promise<ExpireProposalsResult>;
} {
  const run = async (): Promise<ExpireProposalsResult> => {
    const now = deps.now?.() ?? Date.now();
    const expiredIds: string[] = [];
    for (;;) {
      const batch = expirePendingProposals(deps.db, now, PROPOSAL_EXPIRY_BATCH_SIZE);
      expiredIds.push(...batch);
      if (batch.length < PROPOSAL_EXPIRY_BATCH_SIZE) break;
    }
    if (expiredIds.length > 0) {
      deps.logger?.info(
        { event: 'proposals.expired', count: expiredIds.length, ids: expiredIds },
        'expired past-deadline pending proposals',
      );
    }
    return { now, expiredIds };
  };

  const handler = async (_payload: Record<string, never>, _job: JobRow): Promise<void> => {
    await run();
  };

  return Object.assign(handler, { runExpiry: run });
}
