/**
 * Job error classification (Section 10, 21.4).
 *
 * Permanent errors (Discord 401/403 permission failures, invalid channel) are
 * not retried indefinitely — they are recorded as terminal failures. Transient
 * errors (rate limits, 5xx, network) follow capped exponential backoff.
 */

/** Mark an error as not retryable. */
export class PermanentJobError extends Error {
  readonly permanent = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

/** Mark an error as retryable (the default for unknown errors). */
export interface BillableAgentRun {
  runId: string;
  costUsd: number;
  startedAtMs: number;
}

export class TransientJobError extends Error {
  readonly transient = true;
  readonly billableAgentRun: BillableAgentRun | null;
  constructor(message: string, options?: { cause?: unknown; billableAgentRun?: BillableAgentRun }) {
    super(message, options);
    this.name = 'TransientJobError';
    this.billableAgentRun = options?.billableAgentRun ?? null;
  }
}

/** Hold a job until an external gate (budget/outage) may be retried, without consuming an attempt. */
export class DeferJobError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = 'DeferJobError';
  }
}

/**
 * Requeue the same durable row after meaningful domain progress.
 * Unlike an external-gate defer, progress starts a fresh retry boundary.
 */
export class ContinueJobError extends DeferJobError {
  constructor(message: string, retryAfterMs: number) {
    super(message, retryAfterMs);
    this.name = 'ContinueJobError';
  }
}

export interface ErrorClassification {
  permanent: boolean;
  message: string;
}

/**
 * Classify an error. Discord permission failures (401/403) and explicitly
 * permanent errors are terminal; everything else is transient. Discord REST
 * errors are duck-typed (status / code) so this layer stays free of discord.js
 * types.
 */
export function classifyError(err: unknown): ErrorClassification {
  if (err instanceof PermanentJobError) {
    return { permanent: true, message: err.message };
  }
  if (err instanceof TransientJobError) {
    return { permanent: false, message: err.message };
  }

  const status = readStatus(err);
  if (status !== null) {
    // 401/403 → missing access or permissions; retrying won't help.
    if (status === 401 || status === 403) {
      return { permanent: true, message: describe(err, `permission denied (${status})`) };
    }
    // 429 and 5xx are transient.
    return { permanent: false, message: describe(err, `http ${status}`) };
  }

  const code = readCode(err);
  if (code !== null) {
    // Discord error codes for missing access / unknown channel / forbidden.
    if (MISSING_ACCESS_CODES.has(code) || FORBIDDEN_CODES.has(code)) {
      return { permanent: true, message: describe(err, `discord code ${code}`) };
    }
  }

  return { permanent: false, message: describe(err, 'transient error') };
}

const MISSING_ACCESS_CODES = new Set([50001, 50004, 50008]);
const FORBIDDEN_CODES = new Set([50009, 50013, 50023]);

function readStatus(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status: unknown }).status;
    return typeof s === 'number' ? s : null;
  }
  return null;
}

function readCode(err: unknown): number | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === 'number' ? c : null;
  }
  return null;
}

function describe(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  return fallback;
}
