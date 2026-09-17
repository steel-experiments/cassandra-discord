import { PermanentJobError } from '../errors.js';
import type { JobHandler } from '../worker.js';

/** Legacy payloads have no independent approval and must never erase content. */
export function createForgetUserHandler(): JobHandler<'forget_user'> {
  return async () => {
    throw new PermanentJobError('Legacy deletion disabled: create an independently approved deletion request');
  };
}
