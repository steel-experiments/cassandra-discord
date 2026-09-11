import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { type Static } from '@sinclair/typebox';
import { GetMessageContextToolInput } from '../schemas.js';
import {
  getMessageContext,
  type CompactMessage,
} from '../../db/repositories/message-context.js';
import { fitItemsToBudget, type AgentRunContext } from '../run-context.js';
import { formatTimestamp } from './render.js';

/**
 * `get_message_context` — neighbors and reply chain around a permitted anchor
 * (Sections 7.3, 21.2, 22.2).
 *
 * An anchor that is missing, deleted, or outside the run's scope yields a
 * generic rejection that does not reveal whether the message exists, so the
 * model cannot probe for hidden content. Permitted neighbors count against the
 * per-run character budget and every exposed channel is recorded as provenance.
 */
export interface GetMessageContextDetails {
  visible: boolean;
  messageIds: string[];
  truncated: number;
  charsExposed: number;
}

const DESCRIPTION = `Return the messages around one permitted message id, plus its reply/thread chain.
An id you cannot see returns a generic rejection. Use search_messages first to find ids.`;

interface AnchoredLine {
  message: CompactMessage;
  line: string;
  /** Display group: preceding lines sit above the anchor, the rest below it. */
  precedes: boolean;
}

function render(message: CompactMessage, role: string): string {
  return `[${message.messageId}] ${formatTimestamp(message.createdAtMs)} ${message.authorDisplayName} in #${message.channelId} (${role}):\n${message.content}`;
}

export function createGetMessageContextTool(
  ctx: AgentRunContext,
): AgentTool<typeof GetMessageContextToolInput, GetMessageContextDetails> {
  return {
    name: 'get_message_context',
    label: 'Get message context',
    description: DESCRIPTION,
    parameters: GetMessageContextToolInput,
    async execute(
      _toolCallId,
      params: Static<typeof GetMessageContextToolInput>,
    ): Promise<AgentToolResult<GetMessageContextDetails>> {
      const result = getMessageContext(ctx.db, ctx.grant, {
        messageId: params.messageId,
        beforeCount: params.beforeCount,
        afterCount: params.afterCount,
        includeReplies: params.includeReplies,
      });

      if (!result.anchor) {
        // Generic: does not distinguish missing from forbidden.
        return {
          content: [
            {
              type: 'text',
              text: 'That message is not visible in this run\'s scope.',
            } as TextContent,
          ],
          details: {
            visible: false,
            messageIds: [],
            truncated: 0,
            charsExposed: ctx.retrieval.charsExposed,
          },
        };
      }

      // The anchor is the subject of the call, so it reserves its budget before
      // any neighbor. Fitting neighbors first lets a wide beforeCount spend the
      // remaining budget and return a window without the message it is about.
      const anchorLine = render(result.anchor, 'anchor');
      if (!ctx.retrieval.tryReserve(anchorLine.length + 1)) {
        return {
          content: [
            {
              type: 'text',
              text: '[context omitted — per-run character budget reached]',
            } as TextContent,
          ],
          details: {
            visible: true,
            messageIds: [],
            truncated: 1 + result.before.length + result.after.length + result.replies.length,
            charsExposed: ctx.retrieval.charsExposed,
          },
        };
      }
      ctx.retrieval.recordMessage(
        result.anchor.messageId,
        result.anchor.channelId,
        'message_context',
      );

      const neighbors: AnchoredLine[] = [
        ...result.before.map((m) => ({ message: m, line: render(m, 'before'), precedes: true })),
        ...result.after.map((m) => ({ message: m, line: render(m, 'after'), precedes: false })),
        ...result.replies.map((m) => ({ message: m, line: render(m, 'reply'), precedes: false })),
      ];

      const fit = fitItemsToBudget(
        ctx.retrieval,
        neighbors,
        (al) => al.line,
        (n) => `[${n} more message(s) omitted — per-run character budget reached]`,
      );
      for (const al of fit.included) {
        ctx.retrieval.recordMessage(al.message.messageId, al.message.channelId, 'message_context');
      }

      // fitItemsToBudget appends its truncation note past the included lines.
      const note = fit.lines.length > fit.included.length ? fit.lines[fit.lines.length - 1] : undefined;
      const lines = [
        ...fit.included.filter((al) => al.precedes).map((al) => al.line),
        anchorLine,
        ...fit.included.filter((al) => !al.precedes).map((al) => al.line),
        ...(note === undefined ? [] : [note]),
      ];

      return {
        content: [{ type: 'text', text: lines.join('\n\n') } as TextContent],
        details: {
          visible: true,
          messageIds: [
            result.anchor.messageId,
            ...fit.included.map((al) => al.message.messageId),
          ],
          truncated: fit.truncated,
          charsExposed: ctx.retrieval.charsExposed,
        },
      };
    },
  };
}
