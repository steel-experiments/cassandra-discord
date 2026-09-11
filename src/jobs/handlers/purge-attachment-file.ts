import { unlinkSync } from 'node:fs';
import type { DatabaseSync } from '../../db/database.js';
import {
  getAttachmentFilePurge,
  markAttachmentFilePurged,
  markAttachmentFilePurgeFailed,
} from '../../db/repositories/attachments.js';
import type { JobHandler } from '../worker.js';

/** Remove one archived attachment through durable, restart-safe work. */
export function createPurgeAttachmentFileHandler(deps: {
  db: DatabaseSync;
  now?: () => number;
  unlink?: (path: string) => void;
}): JobHandler<'purge_attachment_file'> {
  return async ({ purgeId }) => {
    const row = getAttachmentFilePurge(deps.db, purgeId);
    if (!row || row.status === 'purged') return;
    const now = deps.now?.() ?? Date.now();
    try {
      (deps.unlink ?? unlinkSync)(row.local_path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        const message = err instanceof Error ? err.message : String(err);
        markAttachmentFilePurgeFailed(deps.db, purgeId, message, now);
        throw err;
      }
    }
    markAttachmentFilePurged(deps.db, purgeId, now);
  };
}
