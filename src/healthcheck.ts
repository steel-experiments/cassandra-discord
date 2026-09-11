/**
 * Container healthcheck (Section 38.3).
 *
 * Compiled to `dist/healthcheck.js` and invoked by the image's `HEALTHCHECK`
 * directive. It probes `/livez` on the configured port with a 4s budget and
 * exits non-zero when the process is not live, so an orchestrator can restart
 * an unhealthy container. This file intentionally carries no imports and no
 * logging — it is a tiny standalone probe.
 */
const port = Number(process.env.PORT ?? "3000");

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 4_000);

try {
  const response = await fetch(`http://127.0.0.1:${port}/livez`, {
    signal: controller.signal,
  });

  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
} finally {
  clearTimeout(timer);
}
