/**
 * The tools migrated onto the typed registry so far (ENG-156).
 *
 * First batch = the foundation read/search tools. They are the safest possible
 * starting point: pure read effect, tiny argument surface, and — critically —
 * their `.strict()`, non-transforming Zod schemas are provably equivalent to the
 * legacy `validateAndRepairToolArgs` decision for every input (see the parity
 * battery in `agentModeToolRegistry.test.ts`), so migrating them is fully
 * behavior-preserving. Each schema mirrors the JSON schema declared in
 * `mcp/server/apiTools.ts` for the same tool.
 *
 * Adding a tool here is one PR per batch; widening/tightening a schema so the
 * typed path takes over a legacy repair (and the boundary fallback can be dropped
 * for that tool) is a separate, intentionally behavior-changing slice.
 */

import { z } from 'zod';
import { TypedToolRegistry, type TypedToolDefinition } from './toolRegistry';

/**
 * `query` is required and non-empty: `.min(1)` mirrors the legacy validator
 * treating an empty string as a missing required value, so an empty query falls
 * back to the legacy path (which rejects it) rather than being accepted here.
 * `max_results` is an optional number with NO default — the legacy validator does
 * not inject JSON-schema defaults, and the tool handlers already apply their own
 * fallback, so injecting one would change the args passed to execute.
 */
const youSearchWebSchema = z
  .object({
    query: z.string().min(1),
    max_results: z.number().optional(),
  })
  .strict();

const youSearchNewsSchema = z
  .object({
    query: z.string().min(1),
    max_results: z.number().optional(),
    freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
  })
  .strict();

const googleSearchWebSchema = z
  .object({
    query: z.string().min(1),
    max_results: z.number().optional(),
  })
  .strict();

/** The migrated tool definitions, in registration order. */
export const MIGRATED_TOOLS: TypedToolDefinition[] = [
  {
    name: 'you_search_web',
    description: 'Search the public web using You.com Search.',
    schema: youSearchWebSchema,
    effect: 'read',
    readOnlyHint: true,
  },
  {
    name: 'you_search_news',
    description: 'Search current news using You.com Search.',
    schema: youSearchNewsSchema,
    effect: 'read',
    readOnlyHint: true,
  },
  {
    name: 'google_search_web',
    description: 'Opt-in Google Custom Search web search.',
    schema: googleSearchWebSchema,
    effect: 'read',
    readOnlyHint: true,
  },
];

/** Build a fresh registry populated with every migrated tool. */
export function createDefaultToolRegistry(): TypedToolRegistry {
  const registry = new TypedToolRegistry();
  for (const tool of MIGRATED_TOOLS) {
    registry.register(tool);
  }
  return registry;
}
