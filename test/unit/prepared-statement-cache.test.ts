import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import {
  MAX_PREPARED_STATEMENTS_PER_CONNECTION,
  prepareCached,
  preparedStatementCacheSize,
} from '../../src/db/repositories/util.js';

describe('prepared statement cache', () => {
  let env: TestDb | undefined;

  afterEach(() => env?.cleanup());

  it('bounds per-connection statement cardinality and retains recent entries', () => {
    env = createTestDb();
    for (let index = 0; index < MAX_PREPARED_STATEMENTS_PER_CONNECTION + 50; index += 1) {
      prepareCached(env.db, `cache-test:${index}`, `SELECT ${index} AS value`);
    }

    expect(preparedStatementCacheSize(env.db)).toBe(MAX_PREPARED_STATEMENTS_PER_CONNECTION);
    expect(prepareCached(
      env.db,
      `cache-test:${MAX_PREPARED_STATEMENTS_PER_CONNECTION + 49}`,
      'SELECT 1',
    ).get()).toEqual({ value: MAX_PREPARED_STATEMENTS_PER_CONNECTION + 49 });
  });
});
