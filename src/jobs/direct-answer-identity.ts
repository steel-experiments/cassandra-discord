/** Queue identity shared by Gateway admission and durable startup repair. */

/** Lower numbers run first; ordinary jobs default to 100. */
export const DIRECT_ANSWER_PRIORITY = 25;

/** Active-unique queue key; terminal dedupe lives on the durable request row. */
export function directAnswerJobKey(messageId: string): string {
  return `direct-answer:message:${messageId}`;
}
