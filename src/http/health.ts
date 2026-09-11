import type { DatabaseSync } from '../db/database.js';
import type { Probe, ProbeResult } from './server.js';
import type { RuntimeState } from '../runtime-state.js';

/**
 * Liveness probe for `GET /livez` (Section 32.1).
 *
 * Liveness is intentionally narrow: the process is up and the event loop is
 * responsive if this probe is running at all, and SQLite is healthy if a bounded
 * `SELECT 1` succeeds. Liveness is independent of Discord and the model — an
 * outage in either must NOT fail liveness, so the probe never touches them. An
 * unavailable database (closed, busy, or erroring) fails liveness.
 *
 * The bound on a locked database is `PRAGMA busy_timeout` (5000 ms, Section 28):
 * a contended `SELECT 1` returns SQLITE_BUSY within that window instead of
 * hanging. The probe never reports the database path, query text, or the raw
 * error message — only a short, safe failure code.
 */

/** Safe, content-free failure codes surfaced by the liveness probe. */
export type LivenessError =
  | 'database_closed'
  | 'database_busy'
  | 'database_unhealthy'
  | 'probe_failed';

/** Map a thrown database error to a safe code without leaking details. */
export function classifyDatabaseError(err: unknown): LivenessError {
  if (!(err instanceof Error)) return 'database_unhealthy';
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ERR_INVALID_STATE') return 'database_closed';
  if (code === 'ERR_SQLITE_ERROR') {
    // errcode 5 is SQLITE_BUSY (contended; bounded by busy_timeout).
    const errcode = (err as { errcode?: number }).errcode;
    if (errcode === 5) return 'database_busy';
    return 'database_unhealthy';
  }
  return 'database_unhealthy';
}

/**
 * Build the `/livez` probe bound to a single database connection. The probe is
 * synchronous (SQLite is synchronous); the HTTP layer awaits it regardless.
 */
export function createLivenessProbe(db: DatabaseSync): Probe {
  return (): ProbeResult => {
    try {
      db.prepare('SELECT 1').get();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: classifyDatabaseError(err) };
    }
  };
}

/**
 * Readiness probe for `GET /readyz` (Section 32.2). Returns ok only
 * when every required startup milestone is met and the process is not shutting
 * down. Readiness is driven solely by {@link RuntimeState}; it never touches the
 * model or waits on backfill, so a transient model outage or in-flight backfill
 * cannot make a ready process report not-ready. The failure code names the
 * earliest milestone still pending (or `shutting_down`) — content-free and safe
 * to expose on an unauthenticated endpoint.
 */
export function createReadinessProbe(state: RuntimeState): Probe {
  return (): ProbeResult => {
    if (state.isReady()) return { ok: true };
    return { ok: false, error: state.blockingReason() ?? 'not_ready' };
  };
}
