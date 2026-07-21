/**
 * Typed tool registry — the ENG-156 strangler seam.
 *
 * Goal (steal the shape, build in-house): one Zod schema per tool, validated at
 * the existing `agentToolGatewayService` boundary, migrating tools OFF the giant
 * `apiTools` JSON-schema + ad-hoc-repair path INCREMENTALLY. This is the target
 * `ToolRegistry` abstraction referenced by `core/types.ts` and the parity gap
 * tracked in `backend/docs/AGENTMODE_MIGRATION.md`.
 *
 * Behavior-preserving contract (this slice):
 *   `validateToolArgsAtBoundary` consults the registry. For a REGISTERED tool it
 *   validates with the tool's Zod schema; if Zod ACCEPTS, that result is
 *   authoritative (the clean-input path no longer needs the legacy repair engine).
 *   If Zod REJECTS — or the tool is NOT registered — it defers to the legacy
 *   `validateAndRepairToolArgs`, which stays authoritative for alias/scalar/JSON
 *   repairs. Because the migrated schemas are `.strict()` and non-transforming,
 *   every input Zod accepts is one the legacy validator also accepts unchanged,
 *   and every input the legacy validator would repair is one Zod rejects (→ legacy
 *   runs). The observable result is therefore IDENTICAL to today for the migrated
 *   tools — proven by the parity battery in the tests. Future slices tighten each
 *   tool's schema (coercions/aliases move INTO the typed schema) and drop the
 *   fallback per tool, deleting that tool's ad-hoc repair — an intentional, gated
 *   behavior change, one PR per tool batch.
 */

import type { z } from 'zod';
import {
  validateAndRepairToolArgs,
  buildSchemaRetryMessage,
  type AgentToolContractValidationInput,
  type AgentToolContractValidationResult,
  type AgentToolContractIssue,
  type AgentToolEffect,
} from '../agentToolGatewayService';

/** A typed tool: one Zod schema + boundary metadata behind the gateway. */
export interface TypedToolDefinition {
  name: string;
  /** Zod schema for the tool's arguments, validated at the gateway boundary. */
  schema: z.ZodType<any>;
  description?: string;
  /** Gateway effect classification (parity with the policy layer's taxonomy). */
  effect?: AgentToolEffect;
  /**
   * Anthropic/OpenAI-style read-only annotation. Reserved for a later slice that
   * uses it to unlock safe parallel dispatch of read-only tools; recorded now so
   * migrated tools carry the hint from day one.
   */
  readOnlyHint?: boolean;
}

/**
 * Deterministic, key-sorted stringify so a normalized-vs-input comparison is
 * order-insensitive. Pure; used only to decide `valid` vs `repaired`.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function zodPath(path: Array<string | number>): string {
  if (path.length === 0) return '$';
  return `$${path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('')}`;
}

function lastPathSegment(path: Array<string | number>): string {
  return path.length > 0 ? String(path[path.length - 1]) : '(root)';
}

/**
 * Map a Zod validation failure onto the gateway's existing
 * `AgentToolContractIssue` vocabulary so registry-validated tools speak the same
 * language as the legacy validator (`missing_required` / `type_mismatch` /
 * `unknown_property` / `invalid_args`).
 */
export function zodErrorToContractIssues(error: z.ZodError): AgentToolContractIssue[] {
  const issues: AgentToolContractIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'invalid_type') {
      if ((issue as { received?: unknown }).received === 'undefined') {
        issues.push({
          code: 'missing_required',
          path: zodPath(issue.path),
          message: `Missing required argument "${lastPathSegment(issue.path)}".`,
        });
      } else {
        const expected = (issue as { expected?: unknown }).expected;
        issues.push({
          code: 'type_mismatch',
          path: zodPath(issue.path),
          message: `Argument "${lastPathSegment(issue.path)}" has the wrong type.${
            expected ? ` Expected ${String(expected)}.` : ''
          }`,
        });
      }
      continue;
    }

    if (issue.code === 'unrecognized_keys') {
      for (const key of (issue as { keys?: string[] }).keys ?? []) {
        issues.push({
          code: 'unknown_property',
          path: `$.${key}`,
          message: `Unknown argument "${key}".`,
        });
      }
      continue;
    }

    issues.push({
      code: 'invalid_args',
      path: zodPath(issue.path),
      message: issue.message,
    });
  }

  // Zod can (in theory) produce an error with no issues; never return an empty
  // set for an invalid result, or the boundary would treat it as valid.
  if (issues.length === 0) {
    issues.push({ code: 'invalid_args', path: '$', message: 'Arguments failed schema validation.' });
  }
  return issues;
}

/** In-memory registry of typed tools. Dependency-free apart from Zod + gateway types. */
export class TypedToolRegistry {
  private readonly tools = new Map<string, TypedToolDefinition>();

  /** Register a tool. Throws on empty name or duplicate registration. */
  register(def: TypedToolDefinition): this {
    if (!def.name) {
      throw new Error('TypedToolRegistry.register: tool name is required.');
    }
    if (this.tools.has(def.name)) {
      throw new Error(`TypedToolRegistry.register: tool "${def.name}" is already registered.`);
    }
    this.tools.set(def.name, def);
    return this;
  }

  get(name: string): TypedToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): TypedToolDefinition[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * Validate args for a registered tool against its Zod schema, returning the
   * gateway's shared result shape. A tool that is not registered is treated as a
   * no-op pass (defensive — the boundary guards with `has()` first).
   */
  validate(name: string, args: unknown): AgentToolContractValidationResult {
    const def = this.tools.get(name);
    if (!def) {
      return { status: 'valid', args, issues: [], repairs: [] };
    }

    const parsed = def.schema.safeParse(args);
    if (parsed.success) {
      const changed = stableStringify(parsed.data) !== stableStringify(args);
      return {
        status: changed ? 'repaired' : 'valid',
        args: parsed.data,
        issues: [],
        repairs: changed ? ['schema:normalized'] : [],
      };
    }

    const issues = zodErrorToContractIssues(parsed.error);
    return {
      status: 'invalid',
      args,
      issues,
      repairs: [],
      modelMessage: buildSchemaRetryMessage(name, issues),
    };
  }
}

let defaultRegistry: TypedToolRegistry | undefined;

/**
 * The process-wide default registry, populated with the tools migrated so far.
 * Lazily built (and importing `registeredTools` lazily) to avoid module import
 * cycles and to keep construction side-effect-free until first use.
 */
export function getDefaultToolRegistry(): TypedToolRegistry {
  if (!defaultRegistry) {
    // Lazy require to break the toolRegistry <-> registeredTools import cycle.
    const { createDefaultToolRegistry } = require('./registeredTools') as typeof import('./registeredTools');
    defaultRegistry = createDefaultToolRegistry();
  }
  return defaultRegistry;
}

/** Test hook: drop the memoized default registry so a test can rebuild it. */
export function _resetDefaultToolRegistry(): void {
  defaultRegistry = undefined;
}

/**
 * The gateway-boundary validation seam. Registered tool → Zod (authoritative on
 * accept); otherwise, or on Zod rejection, the legacy `validateAndRepairToolArgs`
 * is authoritative. See the module header for the behavior-preserving proof.
 */
export function validateToolArgsAtBoundary(
  input: AgentToolContractValidationInput,
  registry: TypedToolRegistry = getDefaultToolRegistry(),
): AgentToolContractValidationResult {
  if (registry.has(input.toolName)) {
    const result = registry.validate(input.toolName, input.args);
    if (result.status !== 'invalid') {
      return result;
    }
    // Zod rejected — defer to the legacy validator, which may still repair+accept.
  }
  return validateAndRepairToolArgs(input);
}
