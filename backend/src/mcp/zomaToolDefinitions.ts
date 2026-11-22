/**
 * ENG-2303 — Zoma toolkit-local tool definitions (pure: no I/O, no db). Kept apart from
 * zomaOnboarding.ts so the Meta Toolkit manifest can advertise them without importing
 * services. Handlers live in zomaOnboarding.ts and are dispatched by the toolkit gateway.
 */
export const ZOMA_TOOL_NAMES = ['zoma_status', 'zoma_usage'] as const;
export type ZomaToolName = (typeof ZOMA_TOOL_NAMES)[number];

export function isZomaTool(name: string): name is ZomaToolName {
  return (ZOMA_TOOL_NAMES as readonly string[]).includes(name);
}

export const ZOMA_TOOL_DEFINITIONS = [
  {
    name: 'zoma_status',
    description:
      "Start here. Checks the user's Zoma setup (AgentWeb login, payment method on file, connected Meta ad account) and returns the next step with a direct link. Reads work without a payment method; changes to ads need both a payment method and a connected Meta ad account. Call this when the user asks to set up Zoma, and again after they say they finished a step.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zoma_usage',
    description:
      "Shows this month's Zoma usage for the logged-in user: tool calls, and writes sent to Meta with their read-back result (confirmed, mismatch, unconfirmed). Call when the user asks what they have used. Billing is not enabled yet; usage is only recorded.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
