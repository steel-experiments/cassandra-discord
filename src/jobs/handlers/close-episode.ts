import type { DatabaseSync } from '../../db/database.js';
import type { Logger } from '../../logger.js';
import type { JobHandler } from '../worker.js';
import type { JobRow } from '../types.js';
import { DeferJobError } from '../errors.js';
import { getEpisode } from '../../episodes/repository.js';
import {
  closeEpisodeAndQueueReview,
  quietTimeoutClose,
  DEFAULT_EPISODE_TIMING,
  type EpisodeTimingConfig,
} from '../../episodes/builder.js';

/**
 * `close_episode` job handler (Sections 11.3, 11.5).
 *
 * The quiet-timeout timer is a durable job (re)scheduled whenever an episode gains
 * activity. When it fires, it re-checks the quiet gap against the episode's current
 * `last_activity_at_ms`: if elapsed, the episode closes and its review is queued;
 * if a newer message pushed activity past this job's scheduled time, it reschedules
 * itself to the new quiet deadline and closes nothing. Any other trigger (message
 * cap, duration cap, thread archival, admin flush) will already have closed the
 * episode, so a late quiet job finding the episode non-open is a no-op.
 */

export interface CloseEpisodeHandlerDeps {
  db: DatabaseSync;
  timing?: EpisodeTimingConfig;
  /** Inject a clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export interface CloseEpisodeHandlerResult {
  episodeId: string;
  /** True when this run closed the episode. */
  closed: boolean;
  trigger?: 'quiet';
  /** True when quiet had not elapsed and the close job was rescheduled. */
  rescheduled: boolean;
}

/** Build a `close_episode` handler. `runClose(episodeId)` exposes the work for callers/tests. */
export function createCloseEpisodeHandler(
  deps: CloseEpisodeHandlerDeps,
): JobHandler<'close_episode'> & {
  runClose(episodeId: string): Promise<CloseEpisodeHandlerResult>;
} {
  const timing = deps.timing ?? DEFAULT_EPISODE_TIMING;

  const runClose = async (episodeId: string): Promise<CloseEpisodeHandlerResult> => {
    const now = deps.now?.() ?? Date.now();
    const episode = getEpisode(deps.db, episodeId);
    if (!episode || episode.status !== 'open') {
      // Already closed by another trigger, or gone — nothing to do.
      return { episodeId, closed: false, rescheduled: false };
    }

    const quiet = quietTimeoutClose(episode, timing, now);
    if (quiet.close) {
      closeEpisodeAndQueueReview(deps.db, episode.conversation_channel_id, now);
      deps.logger?.info({ episodeId, trigger: 'quiet' }, 'close_episode: quiet timeout closed episode');
      return { episodeId, closed: true, trigger: 'quiet', rescheduled: false };
    }

    // A newer message extended activity past this job's fire time: reschedule.
    const rescheduleAt = quiet.rescheduleAt ?? episode.last_activity_at_ms + timing.quietSeconds * 1000;
    deps.logger?.info({ episodeId, rescheduleAt }, 'close_episode: quiet not elapsed; rescheduled');
    return { episodeId, closed: false, rescheduled: true };
  };

  const handler = async (payload: { episodeId: string }, _job: JobRow): Promise<void> => {
    const outcome = await runClose(payload.episodeId);
    if (outcome.rescheduled) {
      const now = deps.now?.() ?? Date.now();
      const episode = getEpisode(deps.db, payload.episodeId);
      const runAt = episode ? episode.last_activity_at_ms + timing.quietSeconds * 1000 : now + 1;
      throw new DeferJobError('episode quiet period has not elapsed', Math.max(1, runAt - now));
    }
  };

  return Object.assign(handler, { runClose });
}
