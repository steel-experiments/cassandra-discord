import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  createMcpToken,
  extractBearerToken,
  resolveMcpRequestAuth,
  type McpRequestAuthDeps,
} from '../../src/mcp/auth.js';
import {
  createRateLimiter,
  DEFAULT_MCP_RATE_LIMIT_PER_MINUTE,
  DEFAULT_MCP_RATE_WINDOW_MS,
} from '../../src/mcp/rate-limit.js';
import { revokeMcpToken, getMcpToken } from '../../src/db/repositories/mcp-tokens.js';

/**
 * MCP request authentication and rate limiting (Sections 32.5.2, 32.5.4; task T100).
 *
 * Acceptance — verbatim: "Invalid, expired, and revoked credentials return 401;
 * excess valid requests return 429; content is never logged."
 *
 * The suite drives the request-auth path end to end against a seeded database:
 * each stateless request extracts the bearer, resolves it to a grant (hashing the
 * value, checking expiry/revocation, touching `last_used_at_ms`), and consumes one
 * unit of the per-token limiter. Credential failures collapse to a uniform `401`
 * (no oracle), exhaustion yields `429`, and the plaintext token never reaches the
 * outcome object or console output.
 */

const GUILD = '100000000000000001';
const ACTOR = '100000000000000003';
const NOW = 1_700_000_000_000;
const FUTURE = NOW + 86_400_000;

interface Issued {
  token: string;
  id: string;
}

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db, GUILD);
});

afterEach(() => {
  env.cleanup();
});

function issue(name = 'ci-bot', over: { expiresAtMs?: number } = {}): Issued {
  const outcome = createMcpToken({ db, nowMs: NOW }, { name, createdByUserId: ACTOR, ...over });
  if (outcome.kind !== 'created') throw new Error(`token not created: ${JSON.stringify(outcome)}`);
  return { token: outcome.token, id: outcome.row.id };
}

function authDeps(limiter = createRateLimiter({ limit: 3 }), nowMs = NOW): McpRequestAuthDeps {
  return { db, nowMs, rateLimiter: limiter };
}

function auth(header: string | null, deps: McpRequestAuthDeps) {
  return resolveMcpRequestAuth(deps, { authorizationHeader: header });
}

describe('bearer extraction', () => {
  it('parses a well-formed Bearer header and trims whitespace', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('  Bearer   xyz  ')).toBe('xyz');
  });

  it('accepts the scheme case-insensitively', () => {
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('BEARER abc')).toBe('abc');
  });

  it('rejects missing, empty, and non-Bearer headers', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('   ')).toBeNull();
    expect(extractBearerToken('abc123')).toBeNull(); // no scheme
    expect(extractBearerToken('Basic abc123')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull(); // no value
  });
});

describe('credential failures return 401 (uniform, no oracle)', () => {
  it('authenticates a valid token and returns its grant', () => {
    const { token } = issue();
    const outcome = auth(`Bearer ${token}`, authDeps());
    expect(outcome.kind).toBe('authenticated');
    if (outcome.kind !== 'authenticated') return;
    expect(outcome.grant.scopeType).toBe('org');
    expect(outcome.remaining).toBe(2); // limit 3, first use
  });

  it('returns 401 for a missing header', () => {
    expect(auth(null, authDeps())).toEqual({ kind: 'unauthenticated', status: 401 });
  });

  it('returns 401 for a malformed header', () => {
    const { token } = issue();
    expect(auth(token, authDeps())).toEqual({ kind: 'unauthenticated', status: 401 }); // no Bearer
    expect(auth(`Basic ${token}`, authDeps())).toEqual({ kind: 'unauthenticated', status: 401 });
  });

  it('returns 401 for an unknown token', () => {
    expect(auth('Bearer not-a-real-token-value', authDeps())).toEqual({ kind: 'unauthenticated', status: 401 });
  });

  it('returns 401 for an expired token', () => {
    const { token } = issue('expiring', { expiresAtMs: FUTURE });
    expect(auth(`Bearer ${token}`, authDeps(createRateLimiter({ limit: 3 }), FUTURE + 1)).kind).toBe(
      'unauthenticated',
    );
  });

  it('returns 401 for a revoked token', () => {
    const { token, id } = issue();
    revokeMcpToken(db, id, NOW);
    expect(auth(`Bearer ${token}`, authDeps()).kind).toBe('unauthenticated');
  });

  it('updates last_used_at_ms on an authenticated request', () => {
    const { token, id } = issue();
    expect(getMcpToken(db, id)?.lastUsedAtMs).toBeNull();
    auth(`Bearer ${token}`, authDeps(createRateLimiter({ limit: 3 }), NOW + 5000));
    expect(getMcpToken(db, id)?.lastUsedAtMs).toBe(NOW + 5000);
  });
});

describe('excess valid requests return 429', () => {
  it('allows up to the limit then returns 429 with a retry window', () => {
    const { token } = issue();
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
    const deps = authDeps(limiter, NOW);

    expect(auth(`Bearer ${token}`, deps).kind).toBe('authenticated');
    expect(auth(`Bearer ${token}`, deps).kind).toBe('authenticated');
    expect(auth(`Bearer ${token}`, deps).kind).toBe('authenticated');

    const over = auth(`Bearer ${token}`, deps);
    expect(over.kind).toBe('rate_limited');
    if (over.kind !== 'rate_limited') return;
    expect(over.status).toBe(429);
    expect(over.retryAfterMs).toBeGreaterThan(0);
    expect(over.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('admits requests again after the window resets', () => {
    const { token } = issue();
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(auth(`Bearer ${token}`, authDeps(limiter, NOW)).kind).toBe('authenticated');
    expect(auth(`Bearer ${token}`, authDeps(limiter, NOW)).kind).toBe('authenticated');
    expect(auth(`Bearer ${token}`, authDeps(limiter, NOW)).kind).toBe('rate_limited');
    // Advance past the window: a fresh bucket opens.
    expect(auth(`Bearer ${token}`, authDeps(limiter, NOW + 1001)).kind).toBe('authenticated');
  });

  it('rate-limits each token independently', () => {
    const a = issue('a');
    const b = issue('b');
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    const deps = authDeps(limiter, NOW);
    expect(auth(`Bearer ${a.token}`, deps).kind).toBe('authenticated');
    expect(auth(`Bearer ${a.token}`, deps).kind).toBe('rate_limited'); // a exhausted
    expect(auth(`Bearer ${b.token}`, deps).kind).toBe('authenticated'); // b has its own bucket
  });

  it('counts the rate-limited request against last_used (it authenticated first)', () => {
    const { token, id } = issue();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    const t = NOW + 7_000;
    auth(`Bearer ${token}`, authDeps(limiter, t)); // allowed
    const over = auth(`Bearer ${token}`, authDeps(limiter, t)); // 429
    expect(over.kind).toBe('rate_limited');
    expect(getMcpToken(db, id)?.lastUsedAtMs).toBe(t); // resolve touched it before the limit denied
  });
});

describe('unauthenticated failures share a global budget (Section 32.5.4)', () => {
  it('returns 401 while budget remains and 429 once it is exhausted', () => {
    const unauth = createRateLimiter({ limit: 2 });
    const deps: McpRequestAuthDeps = { ...authDeps(), unauthRateLimiter: unauth };
    expect(auth('Bearer wrong-1', deps).kind).toBe('unauthenticated');
    expect(auth(null, deps).kind).toBe('unauthenticated');
    const third = auth('Bearer wrong-2', deps);
    expect(third.kind).toBe('rate_limited');
    if (third.kind !== 'rate_limited') return;
    expect(third.status).toBe(429);
    expect(third.tokenId).toBeNull(); // no token was resolved
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it('never throttles a valid token, even with the budget exhausted', () => {
    const unauth = createRateLimiter({ limit: 1 });
    const deps: McpRequestAuthDeps = { ...authDeps(), unauthRateLimiter: unauth };
    auth('Bearer wrong', deps); // consumes the whole budget
    expect(auth('Bearer wrong', deps).kind).toBe('rate_limited');
    const { token } = issue();
    expect(auth(`Bearer ${token}`, deps).kind).toBe('authenticated');
  });

  it('admits failures again after the window resets', () => {
    const unauth = createRateLimiter({ limit: 1, windowMs: 1000 });
    const at = (nowMs: number): McpRequestAuthDeps => ({
      ...authDeps(createRateLimiter({ limit: 3 }), nowMs),
      unauthRateLimiter: unauth,
    });
    auth('Bearer wrong', at(NOW));
    expect(auth('Bearer wrong', at(NOW)).kind).toBe('rate_limited');
    expect(auth('Bearer wrong', at(NOW + 1000)).kind).toBe('unauthenticated');
  });

  it('leaves the plain 401 behavior when no budget is configured', () => {
    const deps = authDeps();
    for (let i = 0; i < 10; i += 1) {
      expect(auth('Bearer wrong', deps).kind).toBe('unauthenticated');
    }
  });
});

describe('the limiter default and pruning', () => {
  it('defaults to 60/minute per Section 32.5.4', () => {
    expect(DEFAULT_MCP_RATE_LIMIT_PER_MINUTE).toBe(60);
    expect(DEFAULT_MCP_RATE_WINDOW_MS).toBe(60_000);
    const limiter = createRateLimiter();
    const d = limiter.check('tok', NOW);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(59);
  });

  it('prunes only stale windows', () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000 });
    limiter.check('old', NOW);
    limiter.check('fresh', NOW + 2000);
    expect(limiter.prune(NOW + 2000)).toBe(1); // 'old' is stale
    // 'fresh' survives and keeps its count.
    const d = limiter.check('fresh', NOW + 2000);
    expect(d.remaining).toBe(3); // was 1, now 2 used → 3 left of 5
  });
});

describe('content is never logged', () => {
  it('emits no token to stdout/stderr and carries no plaintext in the outcome', () => {
    const { token } = issue();
    // One shared limiter (limit 1): first request authenticates, second is 429.
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const chunks: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    try {
      const ok = auth(`Bearer ${token}`, authDeps(limiter, NOW));
      const limited = auth(`Bearer ${token}`, authDeps(limiter, NOW + 1));
      expect(ok.kind).toBe('authenticated');
      expect(limited.kind).toBe('rate_limited');
      expect(chunks.join('')).not.toContain(token);
      expect(JSON.stringify(ok)).not.toContain(token);
      expect(JSON.stringify(limited)).not.toContain(token);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
