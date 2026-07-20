import { emmaToolRegistry } from './registry';

/** Infer a platform from the reason string when the model omits the platform field. */
function inferPlatformFromReason(reason: string | undefined): string | null {
  if (!reason) return null;
  const r = reason.toLowerCase();
  if (r.includes('youtube'))                                   return 'youtube';
  if (r.includes('gmail') || r.includes('google mail'))       return 'gmail';
  if (r.includes('outlook') || r.includes('microsoft 365') || r.includes('office 365')) return 'outlook';
  if (r.includes('instagram'))                                 return 'instagram';
  if (r.includes('meta') || r.includes('facebook'))           return 'meta';
  if (r.includes('outreach') || r.includes('unipile'))        return 'unipile';
  if (r.includes('linkedin ads') || r.includes('linkedin ad')) return 'linkedin_ads';
  if (r.includes('fathom'))                                    return 'fathom';
  if (r.includes('linkedin'))                                  return 'linkedin';
  return null;
}

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  linkedin_ads: 'LinkedIn Ads',
  gmail: 'Gmail',
  outlook: 'Outlook / Microsoft 365',
  youtube: 'YouTube',
  meta: 'Meta Marketing',
  instagram: 'Instagram',
  fathom: 'Fathom',
  unipile: 'LinkedIn Outreach',
};

emmaToolRegistry.register({
  name: 'connect_account',
  definition: {
    name: 'connect_account',
    description:
      'Initiate an OAuth account connection directly within the current page — no navigation required. ' +
      'Use this whenever the user needs to connect a platform account (LinkedIn, Gmail, YouTube, Meta, etc.). ' +
      'The user will see a popup where they can authorize the connection without leaving the conversation. ' +
      'After they connect, you will be notified so you can continue helping them.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['linkedin', 'linkedin_ads', 'gmail', 'outlook', 'youtube', 'meta', 'instagram', 'fathom', 'unipile'],
          description:
            'Which platform to connect. ' +
            '"linkedin" → LinkedIn personal profile; ' +
            '"linkedin_ads" → LinkedIn Ads account; ' +
            '"gmail" → Gmail / Google account; ' +
            '"outlook" → Outlook / Microsoft 365 mailbox; ' +
            '"youtube" → YouTube channel; ' +
            '"meta" → Facebook / Meta Ads; ' +
            '"instagram" → Instagram business account; ' +
            '"fathom" → Fathom analytics; ' +
            '"unipile" → LinkedIn Outreach (via Unipile).',
        },
        reason: {
          type: 'string',
          description: 'Brief explanation of why this connection is needed (shown to user in the connect dialog).',
        },
      },
      required: [],
    },
  },
  execute: async (args: { platform?: string; reason?: string }) => {
    const platform = args.platform ?? inferPlatformFromReason(args.reason);
    // When no platform is identifiable, return all so the frontend shows a picker.
    const platforms = platform ? [platform] : Object.keys(PLATFORM_LABELS);
    return {
      type: 'connect_account',
      platform: platform ?? null,
      platforms,
      displayName: platform ? (PLATFORM_LABELS[platform] ?? platform) : 'an account',
      reason: args.reason,
    };
  },
});
