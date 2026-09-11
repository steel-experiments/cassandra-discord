import { describe, it, expect, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import { createReadinessProbe } from '../../src/http/health.js';
import { RuntimeState, READINESS_ORDER } from '../../src/runtime-state.js';

/**
 * Readiness state and `/readyz` endpoint (Sections 9.2, 32.2, 34).
 *
 * Acceptance: startup-order tests prove readiness stays false until every
 * required milestone and becomes false immediately on shutdown; a transient
 * model outage or in-flight backfill does not undo initial readiness.
 */

const HOST = '127.0.0.1';
const log = () => createLogger({ level: 'silent' });

let handle: HttpServerHandle | undefined;
let base: string;

async function start(state: RuntimeState): Promise<void> {
  handle = await startHttpServer({
    port: 0,
    host: HOST,
    logger: log(),
    readinessProbe: createReadinessProbe(state),
  });
  base = `http://${HOST}:${handle.port}`;
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
});

/** Mark all four milestones on `s`, in startup order. */
function markAll(s: RuntimeState): void {
  s.markMigrationsApplied();
  s.markPolicyAndPromptsCompiled();
  s.markDiscordAuthenticated();
  s.markCommandsRegistered();
}

describe('RuntimeState — monotonic milestones', () => {
  it('is not ready at construction and names migrations as the first pending milestone', () => {
    const s = new RuntimeState();
    expect(s.isReady()).toBe(false);
    expect(s.blockingReason()).toBe('migrations_pending');
    expect(s.pendingMilestone()).toBe('migrationsApplied');
  });

  it('stays not ready until every required milestone is met', () => {
    const s = new RuntimeState();
    // Each milestone alone is insufficient; readiness follows the startup order.
    s.markMigrationsApplied();
    expect(s.isReady()).toBe(false);
    expect(s.blockingReason()).toBe('policy_prompts_pending');

    s.markPolicyAndPromptsCompiled();
    expect(s.isReady()).toBe(false);
    expect(s.blockingReason()).toBe('discord_auth_pending');

    s.markDiscordAuthenticated();
    expect(s.isReady()).toBe(false);
    expect(s.blockingReason()).toBe('commands_pending');

    s.markCommandsRegistered();
    expect(s.isReady()).toBe(true);
    expect(s.blockingReason()).toBeNull();
  });

  it('reports the earliest pending milestone regardless of the order marks were applied', () => {
    const s = new RuntimeState();
    // Apply later milestones first — the pending reason still names step 1.
    s.markCommandsRegistered();
    s.markDiscordAuthenticated();
    expect(s.blockingReason()).toBe('migrations_pending');
    s.markMigrationsApplied();
    expect(s.blockingReason()).toBe('policy_prompts_pending'); // step 2 still pending
  });

  it('milestone markers are idempotent and monotonic (never clear readiness)', () => {
    const s = new RuntimeState();
    markAll(s);
    expect(s.isReady()).toBe(true);
    // Re-marking is a no-op; there is no API to clear a milestone.
    s.markMigrationsApplied();
    s.markCommandsRegistered();
    expect(s.isReady()).toBe(true);
  });

  it('becomes not ready immediately when shutdown begins', () => {
    const s = new RuntimeState();
    markAll(s);
    expect(s.isReady()).toBe(true);
    s.beginShutdown();
    expect(s.isReady()).toBe(false);
    expect(s.blockingReason()).toBe('shutting_down');
    expect(s.snapshot().shuttingDown).toBe(true);
  });

  it('shutdown dominates: not ready even if all milestones were marked', () => {
    const s = new RuntimeState();
    markAll(s);
    s.beginShutdown();
    expect(s.isReady()).toBe(false);
  });

  it('a model outage after startup does NOT undo readiness (non-gating)', () => {
    const s = new RuntimeState();
    markAll(s);
    s.markModelHealthy();
    expect(s.isReady()).toBe(true);
    // Later model degradation must not fail readiness (Section 21).
    s.markModelDegraded();
    expect(s.isReady()).toBe(true);
    expect(s.snapshot().modelCurrentlyHealthy).toBe(false);
    expect(s.snapshot().ready).toBe(true);
  });

  it('readiness never depends on model health: ready even before any model signal', () => {
    const s = new RuntimeState();
    markAll(s);
    // No markModelHealthy call at all — still ready.
    expect(s.isReady()).toBe(true);
    expect(s.snapshot().modelCurrentlyHealthy).toBe(false);
  });

  it('READINESS_ORDER lists the four milestones in startup order', () => {
    expect(READINESS_ORDER).toEqual([
      'migrationsApplied',
      'policyAndPromptsCompiled',
      'discordAuthenticatedOnce',
      'commandsRegistered',
    ]);
  });
});

describe('createReadinessProbe / /readyz', () => {
  it('returns 503 with the pending reason until every milestone is met', async () => {
    const s = new RuntimeState();
    await start(s);
    let res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'not_ready', error: 'migrations_pending' });

    s.markMigrationsApplied();
    s.markPolicyAndPromptsCompiled();
    s.markDiscordAuthenticated();
    res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('commands_pending');
  });

  it('returns 200 ready once all milestones are met', async () => {
    const s = new RuntimeState();
    await start(s);
    markAll(s);
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });
  });

  it('becomes 503 shutting_down immediately when shutdown begins', async () => {
    const s = new RuntimeState();
    await start(s);
    markAll(s);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    s.beginShutdown();
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'not_ready', error: 'shutting_down' });
  });

  it('stays 200 across a model outage after startup (degradation is not failure)', async () => {
    const s = new RuntimeState();
    await start(s);
    markAll(s);
    s.markModelHealthy();
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    s.markModelDegraded();
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('the readiness probe is cheap and re-checkable (no state mutation on read)', async () => {
    const s = new RuntimeState();
    await start(s);
    markAll(s);
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/readyz`);
      expect(res.status).toBe(200);
    }
    // Reading readiness never advanced or regressed state.
    expect(s.snapshot().ready).toBe(true);
  });
});
