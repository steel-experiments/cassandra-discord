import { type DatabaseSync } from '../db/database.js';
import type { McpTokenGrant } from './auth.js';

/**
 * Shared MCP protocol types (Section 32.5.1).
 *
 * Sourced in this leaf module so the protocol layer (`server.ts`) and the tool
 * catalog/handlers (`tools.ts`) share one definition without a circular import:
 * `tools.ts` needs the result/error shapes to type its tool handlers, and
 * `server.ts` needs them to type its method handlers and dispatch loop. Both
 * import from here; neither imports the other for these types.
 */

/** Standard JSON-RPC 2.0 error codes, plus one server-defined protocol error. */
export const MCP_JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNSUPPORTED_PROTOCOL_VERSION: -32000,
} as const;

/** A JSON-RPC 2.0 error object. */
export interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** The result a method handler returns. */
export type McpMethodResult =
  | { ok: true; result: unknown; auditCount?: number }
  | { ok: false; error: McpJsonRpcError };

/** The per-request scope handed to each method handler. */
export interface McpRequestContext {
  /** Authenticated token id (never the plaintext). */
  tokenId: string;
  /** The token's visibility grant, substituting for a run scope (Section 32.5.3). */
  grant: McpTokenGrant;
  db: DatabaseSync;
  nowMs: number;
}

/** A stateless JSON-RPC method handler (discover, tools/list, tools/call, …). */
export type McpMethodHandler = (
  params: unknown,
  ctx: McpRequestContext,
) => Promise<McpMethodResult> | McpMethodResult;
