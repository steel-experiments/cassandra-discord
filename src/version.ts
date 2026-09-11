import pkg from '../package.json' with { type: 'json' };

/**
 * Application version (package.json `version`). Recorded in backup manifests
 * (Section 42.1) and surfaced by the status endpoint. Isolated in its own module
 * so callers do not each parse `package.json`.
 */
export const APP_VERSION: string =
  typeof pkg?.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
