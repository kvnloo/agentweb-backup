/**
 * ENG-2303 — Zoma toolkit-local tool definitions (pure: no I/O, no db). Kept apart from
 * zomaOnboarding.ts so the Meta Toolkit manifest can advertise them without importing
 * services. Handlers live in zomaOnboarding.ts and are dispatched by the toolkit gateway.
 */
/**
 * ENG-2823 dark-launch switch for the Google Ads provider. Off: the toolkit advertises,
 * accepts and reports exactly what it did before (Meta only). On: Google tools are listed,
 * routed, and shown in zoma_status.
 */
export function googleToolkitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZOMA_GOOGLE_ADS_ENABLED === 'true';
}

export const ZOMA_TOOL_NAMES = ['zoma_status', 'zoma_usage', 'zoma_prepare_upload'] as const;
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
  {
    name: 'zoma_prepare_upload',
    description:
      'Upload a creative (image or video) that is on the user\'s computer, e.g. a batch exported from Higgsfield, Midjourney or Canva. Returns a one-time upload_command (curl PUT, 15 minutes) and a file_url. Run the command with the real local path, then pass file_url as params.image_url to AD_CREATIVE UPLOAD_IMAGE or params.video_url to AD_CREATIVE UPLOAD_VIDEO. Not needed when the file already has a public https URL (including a direct video-file link from a UGC platform or CDN); pass that URL directly. A link to a post page is not a file: download it first. One call per file.',
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
