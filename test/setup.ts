// ABOUTME: Runs before every test file (vitest setupFiles).
// ABOUTME: Silences loggers built with createLogger() so test output stays clean.

// Loggers created without an explicit level read LOG_LEVEL. Tests that assert
// on log records pass their own level and stream, so they are not affected.
// An operator can still set LOG_LEVEL before running the suite to see output.
process.env.LOG_LEVEL ??= 'silent';
