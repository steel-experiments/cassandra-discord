import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

/**
 * Container healthcheck executable (Section 38.3; task T110).
 *
 * Acceptance — verbatim: "The executable returns zero for healthy /livez and
 * nonzero for timeout, network, or non-success responses."
 *
 * The healthcheck is a standalone probe (`src/healthcheck.ts`) that fetches
 * `/livez` on the configured port with a 4 s abort and exits 0 or 1. Because it
 * calls `process.exit` at module load it must run as a subprocess; Node 24 runs
 * the TypeScript source directly via type stripping, so the test spawns the real
 * file (no build step, no behavior-preserving rewrite) against controlled
 * `/livez` servers and asserts the exit code for each outcome.
 */

const HEALTHCHECK = fileURLToPath(new URL('../../src/healthcheck.ts', import.meta.url));
const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** Spawn the healthcheck against `port` and resolve its exit code. */
function runHealthcheck(port: number, timeoutMs = 7_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HEALTHCHECK], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`healthcheck did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Start a one-shot HTTP server whose handler decides the `/livez` response. */
function startLivezServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    servers.push(server);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? (addr as AddressInfo).port : -1;
      resolve(port);
    });
  });
}

/** A port that is currently free (bind, read the port, release). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? (addr as AddressInfo).port : -1;
      probe.close(() => resolve(port));
    });
  });
}

describe('healthcheck exit codes (Section 38.3)', () => {
  it('exits 0 when /livez returns a success status', async () => {
    const port = await startLivezServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    expect(await runHealthcheck(port)).toBe(0);
  });

  it('exits 1 when /livez returns a non-success status', async () => {
    const port = await startLivezServer((_req, res) => {
      res.statusCode = 503;
      res.end('unhealthy');
    });
    expect(await runHealthcheck(port)).toBe(1);
  });

  it('exits 1 when no server is listening (network error)', async () => {
    const port = await freePort();
    expect(await runHealthcheck(port)).toBe(1);
  });

  it('exits 1 when /livez hangs past the 4 s abort budget', async () => {
    // Accept the connection but never respond; the healthcheck's AbortController
    // fires at 4 s, the fetch rejects, and the process exits 1.
    const port = await startLivezServer(() => {
      /* intentionally never respond */
    });
    expect(await runHealthcheck(port, 8_000)).toBe(1);
  });
});
