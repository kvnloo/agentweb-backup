/**
 * ENG-2828 — the ZomaProvider seam (pure types; no I/O).
 *
 * A Zoma provider is one ad platform exposed to external agents through the Zoma toolkit.
 * The shape is derived from what the Meta toolkit already does across
 * metaToolkitManifest.ts (curated tools), metaToolkitGateway.ts (account lookup),
 * zomaOnboarding.ts (setup status + connect link) and metaToolkitWrites.ts /
 * metaToolkitWriteSurface.ts (guarded writes). Meta is provider #1 and, today, the only one.
 */

/** MCP tool definition as advertised in tools/list. */
export interface ZomaToolDefinition {
  name: string;
  description?: string;
  inputSchema?: any;
  [k: string]: unknown;
}

/** Per-platform setup state, as reported to the agent. */
export interface ZomaProviderSetupStatus {
  platform: string;
  /** A usable platform connection exists for the caller. */
  connected: boolean;
  /** Link to connect (or reconnect) the platform; only present when not connected. */
  connectLink?: string;
  /** Guarded writes are allowed for the caller on this platform. */
  writesEnabled: boolean;
}

/** The guarded external write surface: entity × action pairs that go through preview → confirm. */
export interface ZomaGuardedWriteSurface {
  entities: readonly string[];
  actions: readonly string[];
  isGuardedWrite(toolName: string, args: any): boolean;
}

export interface ZomaProvider {
  /** Stable platform id, e.g. 'meta'. */
  readonly platform: string;
  /** The curated platform tool names, in advertised order. */
  readonly toolNames: readonly string[];
  /** Tag that identifies this platform's calls in usage metering. */
  readonly meteringPlatform: string;
  /** Tool definitions this provider advertises in tools/list (narrowed for external callers). */
  listTools(): ZomaToolDefinition[];
  /**
   * Resolve the platform account a call runs against for this caller. Throws when the
   * requested account is foreign/unusable or no single usable account exists.
   */
  resolveAccount(userId: string, requestedAccountId?: unknown): Promise<string>;
  /** Setup status for this caller on this platform, with a connect link when not connected. */
  getSetupStatus(userId: string): Promise<ZomaProviderSetupStatus>;
  /** The guarded-write surface for this platform. */
  readonly guardedWrites: ZomaGuardedWriteSurface;
}
