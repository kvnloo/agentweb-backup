/**
 * ENG-1414's transport-independent model-id boundary.
 *
 * AgentWeb keeps `openrouter/<provider>/<model>` as a logical ID so task policy,
 * entitlements, and metering can attribute the original decision. OpenRouter only
 * accepts `<provider>/<model>` on the wire. This function is deliberately pure:
 * transport, fallback, retries, and provider selection stay out of business code.
 */
export class GatewayContractError extends Error {
  public readonly code = 'INVALID_OPENROUTER_MODEL_ID';

  constructor(message: string) {
    super(message);
    this.name = 'GatewayContractError';
  }
}

const UPSTREAM_MODEL_ID = /^[^/\s]+\/[^/\s]+$/;

export type GatewayTaskClass =
  | 'interactive'
  | 'scheduled'
  | 'content'
  | 'judge'
  | 'mcp'
  | 'agent-engine'
  | 'coding-agent';

export interface GatewayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Actual OpenRouter charge; never substitute a local pricing estimate. */
  costUsd: number;
}

export interface GatewayRequest {
  taskClass: GatewayTaskClass;
  logicalModelId: string;
  eventId: string;
  stream?: boolean;
  tools?: unknown[];
  responseFormat?: unknown;
  input: unknown;
  timeoutMs: number;
}

export interface GatewayResponse<T> {
  logicalModelId: string;
  upstreamModelId: string;
  output: T;
  usage: GatewayUsage;
}

/** Convert AgentWeb's logical ID to OpenRouter's validated upstream wire ID. */
export function normalizeOpenRouterModelId(logicalModelId: string): string {
  if (typeof logicalModelId !== 'string' || logicalModelId.trim() !== logicalModelId) {
    throw new GatewayContractError('OpenRouter model id must be a non-empty trimmed string');
  }

  const upstreamModelId = logicalModelId.startsWith('openrouter/')
    ? logicalModelId.slice('openrouter/'.length)
    : logicalModelId;

  if (!UPSTREAM_MODEL_ID.test(upstreamModelId)) {
    throw new GatewayContractError(
      `OpenRouter model id "${logicalModelId}" must be an OpenRouter upstream id in provider/model form`,
    );
  }

  return upstreamModelId;
}
