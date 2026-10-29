/**
 * ENG-2113 (tool relay, backend side): builds the bounded `tools` manifest of `turn.run` from the bridge's tool list.
 *
 * The relay's name pattern is protocol.ts `TOOL_NAME` (today `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`: letters of both cases, digits, `_` and `-`, no leading `-`)
 * and the `aw_relay_` prefix is the shim's own (case-sensitive, as the host checks it). Emma's tool names are snake_case, per-user MCP tools may use capitals
 * and hyphens (the `mcp__emma__` prefix seen in the CLI's stream is added by the CLI, it is not part of the name the bridge lists), so the mapping is the
 * IDENTITY on every name that fits,
 * which is a bijection by construction and needs no table that could drift. A name that does not fit is SKIPPED (never rewritten: a rewrite could collide with
 * another tool), counted, and logged by reason only. The same predicate decides, on a `tool-call`, whether a name can be mapped back.
 *
 * Tools that only become available after `install_skills` are included from the start as `locked` (the host reveals them when a result carries `unlock`).
 * Nothing here trusts the CLI: the dispatcher re-validates every call against the bridge's CURRENT list.
 */
import { RELAY_RESERVED_PREFIX, TOOL_LIMITS, TOOL_NAME, toolManifest, type ToolDef } from "../../loginHost/protocol";
import type { BridgeTool } from "./toolBridge";

export const EMPTY_TOOL_SCHEMA = { type: "object", properties: {} } as const;
/** The tool the model uses to get more tools; it must always survive the size caps. */
export const INSTALL_TOOL = "install_skills";

export type SkipReason = "name" | "reserved" | "duplicate" | "schema_not_object" | "schema_too_large" | "manifest_full" | "manifest_too_large";

export interface RelayManifest {
  tools: ToolDef[];
  /** Names the manifest marks `locked`. */
  locked: ReadonlySet<string>;
  /** Names offered from the start. */
  open: ReadonlySet<string>;
  skipped: Partial<Record<SkipReason, number>>;
  /** Descriptions cut to the byte limit (the tool is offered, with less text than an AgentWeb turn shows). */
  truncated: number;
}

const byteLen = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

/** Whether a bridge tool name can be offered through the relay (and so mapped back). */
export function relayName(name: unknown): name is string {
  return typeof name === "string" && TOOL_NAME.safeParse(name).success && !name.toLowerCase().startsWith(RELAY_RESERVED_PREFIX);
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  while (out.endsWith("�")) out = out.slice(0, -1); // a cut multi-byte character
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `open`: the run's current tool list. `candidates`: tools the run could have after a skill install (they are marked `locked` unless already open).
 * Throws only if the finished manifest fails the protocol's own schema (a bug: the caller turns it into a typed stop).
 */
export function buildRelayManifest(open: BridgeTool[], candidates: BridgeTool[] = []): RelayManifest {
  const skipped: Partial<Record<SkipReason, number>> = {};
  const skip = (why: SkipReason) => void (skipped[why] = (skipped[why] ?? 0) + 1);
  const seen = new Set<string>();
  const openSeen = new Set<string>();
  const out: ToolDef[] = [];
  let truncated = 0;

  const add = (tool: BridgeTool, locked: boolean) => {
    const name = tool?.name;
    if (!relayName(name)) return skip(typeof (name as unknown) === "string" && String(name).toLowerCase().startsWith(RELAY_RESERVED_PREFIX) && TOOL_NAME.safeParse(name).success ? "reserved" : "name");
    // The host folds case for duplicates and for the reserved prefix: so do we (a name differing only in case is a duplicate, and a refusal of the turn).
    const folded = name.toLowerCase();
    if (seen.has(folded)) {
      if (locked && openSeen.has(name)) return; // a candidate the run already has open: offered once, nothing is lost
      return skip("duplicate");
    }
    let schema: Record<string, unknown>;
    if (tool.inputSchema === undefined || tool.inputSchema === null || !isObject(tool.inputSchema)) schema = { ...EMPTY_TOOL_SCHEMA };
    else if (tool.inputSchema.type === "object") schema = tool.inputSchema;
    else return skip("schema_not_object");
    if (byteLen(schema) > TOOL_LIMITS.maxSchemaBytes) return skip("schema_too_large");
    seen.add(folded);
    const full = typeof tool.description === "string" ? tool.description : "";
    const description = truncateUtf8(full, TOOL_LIMITS.maxDescriptionBytes);
    if (description !== full) truncated++;
    if (!locked) openSeen.add(name);
    out.push({ name, description, inputSchema: schema, ...(locked ? { locked: true } : {}) });
  };

  for (const t of open) add(t, false);
  for (const t of candidates) add(t, true);

  // The caps. Locked candidates go first, then the tail of the open list, and `install_skills` is never dropped.
  const drop = (): boolean => {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].locked) {
        out.splice(i, 1);
        return true;
      }
    }
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].name !== INSTALL_TOOL) {
        out.splice(i, 1);
        return true;
      }
    }
    return false;
  };
  while (out.length > TOOL_LIMITS.maxTools) {
    if (!drop()) break;
    skip("manifest_full");
  }
  while (out.length > 1 && byteLen(out) > TOOL_LIMITS.maxTotalBytes) {
    if (!drop()) break;
    skip("manifest_too_large");
  }

  const locked = new Set(out.filter((t) => t.locked).map((t) => t.name));
  const openNames = new Set(out.filter((t) => !t.locked).map((t) => t.name));
  return { tools: out, locked, open: openNames, skipped, truncated };
}

/** True when the manifest offers less than the bridge listed: a tool left out (any reason) or a description cut. The backend refuses such a turn. */
export function manifestCut(m: Pick<RelayManifest, "skipped" | "truncated">): boolean {
  return Object.keys(m.skipped).length > 0 || m.truncated > 0;
}

/** Checks a finished manifest with the protocol's own schema (the host would refuse the whole turn otherwise). Returns the failing code, or undefined. */
export function manifestProblem(tools: ToolDef[]): string | undefined {
  const parsed = toolManifest.safeParse(tools);
  if (parsed.success) return undefined;
  return parsed.error.issues.map((i) => (i.code === "custom" && /^[a-z_]{1,40}$/.test(i.message) ? i.message : i.code)).slice(0, 3).join(",");
}
