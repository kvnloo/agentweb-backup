/**
 * ENG-2303 — Zoma toolkit-local tool definitions (pure: no I/O, no db). Kept apart from
 * zomaOnboarding.ts so the Meta Toolkit manifest can advertise them without importing
 * services. Handlers live in zomaOnboarding.ts and are dispatched by the toolkit gateway.
 */
export const ZOMA_TOOL_NAMES = ['zoma_status', 'zoma_usage', 'zoma_prepare_upload'] as const;
export type ZomaToolName = (typeof ZOMA_TOOL_NAMES)[number];

export function isZomaTool(name: string): name is ZomaToolName {
  return (ZOMA_TOOL_NAMES as readonly string[]).includes(name);
}

export interface ToolkitToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * ENG-2747 — MCP tool annotations for every tool the Meta Toolkit (Zoma) advertises.
 * Marketplaces and MCP gateways use these hints to decide what needs human approval, so a
 * hint must never understate what a call can do.
 *
 * - call_meta_marketing_api is ONE tool carrying both reads and guarded writes (CREATE paused,
 *   UPDATE status/budget), so it is labelled a destructive write. A client that honours the
 *   hint will gate every call to it, reads included; splitting it into a read tool and a write
 *   tool is the separate server-side approval work and is not done here.
 * - call_meta_ads_insights_api is labelled read-only: it only fetches reporting rows. Meta-side
 *   async report runs and the optional S3 spill of a large result are internal and change no
 *   ad, budget or status.
 * - zoma_status is NOT read-only: when payment is missing it mints a Stripe setup link
 *   (getZomaReadiness with mintLinks), which can create a Stripe customer and Checkout session.
 * - zoma_prepare_upload mints a one-time presigned upload URL under the caller's prefix.
 * Explicit by name, no derivation: a new toolkit tool without an entry fails the manifest.
 */
export const TOOLKIT_TOOL_ANNOTATIONS: Readonly<Record<string, ToolkitToolAnnotations>> = Object.freeze({
  list_meta_ads_campaigns: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  get_meta_ads_metrics: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  call_meta_ads_insights_api: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  call_meta_marketing_api: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  zoma_status: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  zoma_usage: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  zoma_prepare_upload: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
});

export function getToolkitToolAnnotations(name: string): ToolkitToolAnnotations | undefined {
  return Object.prototype.hasOwnProperty.call(TOOLKIT_TOOL_ANNOTATIONS, name)
    ? TOOLKIT_TOOL_ANNOTATIONS[name]
    : undefined;
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
  {
    name: 'zoma_prepare_upload',
    description:
      'Upload a creative (image or video) that is on the user\'s computer, e.g. a batch exported from Higgsfield, Midjourney or Canva. Returns a one-time upload_command (curl PUT, 15 minutes) and a file_url. Run the command with the real local path, then pass file_url as params.image_url to AD_CREATIVE UPLOAD_IMAGE or params.video_url to AD_CREATIVE UPLOAD_VIDEO. Not needed when the file already has a public https URL; pass that URL directly. One call per file.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The local file name including extension: .jpg .jpeg .png .gif .webp (images, max 30 MB) or .mp4 .mov .m4v .webm (videos, max 1 GB).' },
        size_bytes: { type: 'number', description: 'Optional file size in bytes, checked against the limit before uploading.' },
      },
      required: ['filename'],
      additionalProperties: false,
    },
  },
];
