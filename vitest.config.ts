// ABOUTME: Vitest configuration for the whole test suite.
// ABOUTME: Registers the setup file that silences runtime logging during tests.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['test/setup.ts'],
  },
});
