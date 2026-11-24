/**
 * ENG-2303 — Zoma toolkit-local tool definitions (pure: no I/O, no db). Kept apart from
 * zomaOnboarding.ts so the Meta Toolkit manifest can advertise them without importing
 * services. Handlers live in zomaOnboarding.ts and are dispatched by the toolkit gateway.
 */
/**
 * Zoma's Google advertising switch (ENG-2823 dark launch; renamed to ZOMA_GOOGLE_ENABLED so Zoma
 * ships Meta-only by default). Off (unset or anything but "true"): every customer-facing Zoma
 * surface — tool list, routing, zoma_status, setup pages, tool descriptions, MCP instructions,
 * docs — is Meta only. On: the Google Ads implementation is listed, routed and shown again.
 */
import { ZOMA_INDUSTRY_BENCHMARK_DEFINITION } from './zomaIndustryBenchmark';

export const ZOMA_GOOGLE_FLAG = 'ZOMA_GOOGLE_ENABLED';

export function googleToolkitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ZOMA_GOOGLE_FLAG] === 'true';
}

/**
 * ENG-3142: Zoma's X (Twitter) Ads switch. Off (unset or anything but "true", the default): X is
 * not listed, routed, offered in zoma_status, or reachable through its connect routes. On: the
 * X Ads provider is advertised alongside Meta (and Google when that flag is on).
 */
export const ZOMA_X_ADS_FLAG = 'ZOMA_X_ADS_ENABLED';

export function xAdsToolkitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ZOMA_X_ADS_FLAG] === 'true';
}

/**
 * Zoma's LinkedIn Ads switch (provider #4). One env var, three states (strict, case-sensitive):
 *   - unset, or anything but "read" / "true" (the default): OFF. LinkedIn Ads is not listed, routed,
 *     offered in zoma_status, or reachable through its connect pages and routes, and every other
 *     Zoma surface behaves exactly as it did before LinkedIn existed.
 *   - "read": READ MODE. linkedin_ads_read, the Zoma connect pages, the zoma_status block and
 *     reporting are on. linkedin_ads_write is not listed, not routed and refused at call time.
 *     Consent asks only for the read scopes. (LinkedIn's Standard tier is what lets creating and
 *     editing work for customer accounts; until then only reading is offered.)
 *   - "true": FULL. Read mode plus linkedin_ads_write (and the write consent scope).
 * A single variable on purpose: the production environment is near its size limit.
 */
export const ZOMA_LINKEDIN_ADS_FLAG = 'ZOMA_LINKEDIN_ADS_ENABLED';

export type LinkedInAdsMode = 'off' | 'read' | 'full';

export function linkedInAdsMode(env: NodeJS.ProcessEnv = process.env): LinkedInAdsMode {
  const value = env[ZOMA_LINKEDIN_ADS_FLAG];
  if (value === 'true') return 'full';
  if (value === 'read') return 'read';
  return 'off';
}

/** LinkedIn Ads is offered at all: read mode or full. */
export function linkedInAdsToolkitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return linkedInAdsMode(env) !== 'off';
}

/** LinkedIn Ads writes are offered: full mode only (the value "true"). */
export function linkedInAdsWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return linkedInAdsMode(env) === 'full';
}

export const ZOMA_TOOL_NAMES = ['zoma_status', 'zoma_usage', 'zoma_prepare_upload', 'zoma_custom_audiences'] as const;
export type ZomaToolName = (typeof ZOMA_TOOL_NAMES)[number];

export function isZomaTool(name: string): name is ZomaToolName {
  return (ZOMA_TOOL_NAMES as readonly string[]).includes(name);
}

/** ENG-2914: custom audiences run against a resolved Meta ad account (routed by the gateway). */
export const AUDIENCE_TOOL_NAME = 'zoma_custom_audiences';
export const AUDIENCE_READ_ACTIONS = ['LIST', 'GET', 'LIST_AD_SETS'] as const;
export const AUDIENCE_WRITE_ACTIONS = ['CREATE', 'UPDATE', 'ADD_USERS', 'REMOVE_USERS', 'DELETE', 'EXCLUDE_CUSTOMERS'] as const;

/** Write-classified for aw_ key scopes: anything that is not an explicit read (unknown actions included). */
export function isAudienceWriteRequest(args: any): boolean {
  return !(AUDIENCE_READ_ACTIONS as readonly string[]).includes(String(args?.action));
}

/** Zoma tool definitions; Google mentions only while the Google provider is enabled. */
export function zomaToolDefinitions(google: boolean = googleToolkitEnabled()) {
  return [
    {
      name: 'zoma_status',
      description:
        "Start here. Checks the user's Zoma setup (AgentWeb login, how familiar they are with ads, connected Meta ad account, payment method on file) and returns the next step with a direct link. The first step is a question: ask the user \"How familiar are you with ads?\" and call again with ads_experience set to their answer. Reads work without a payment method; changes to ads need both a payment method and a connected Meta ad account. Call this when the user asks to set up Zoma, and again after they say they finished a step.",
      inputSchema: {
        type: 'object',
        properties: {
          ads_experience: {
            type: 'string',
            enum: ['runs_ads', 'new_to_ads', 'not_interested'],
            description: `The user's answer to "How familiar are you with ads?": runs_ads = already runs ads or uses the ${google ? 'Meta/Google' : 'Meta'} MCP; new_to_ads = interested but never ran ads; not_interested = not interested, just a friend. Omit to only check status.`,
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'zoma_usage',
      description:
        "Shows this month's Zoma usage for the logged-in user: tool calls, and writes sent to Meta with their read-back result (confirmed, mismatch, unconfirmed). Call when the user asks what they have used. When billing is on, also shows the plan's included calls, calls used, overage and billing period.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'zoma_prepare_upload',
      description:
        `Upload a creative (image or video) that is on the user's computer, e.g. a batch exported from Higgsfield, Midjourney or Canva. Returns a one-time upload_command (curl PUT, 15 minutes) and a file_url. Run the command with the real local path, then pass file_url as params.image_url to AD_CREATIVE UPLOAD_IMAGE or params.video_url to AD_CREATIVE UPLOAD_VIDEO${google ? ' (Meta), or as data to call_google_ads_api ASSET UPLOAD asset_type IMAGE/LOGO (Google Ads, images only)' : ''}. Not needed when the file already has a public https URL (including a direct video-file link from a UGC platform or CDN); pass that URL directly. A link to a post page is not a file: download it first. One call per file.`,
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
    {
      name: 'zoma_custom_audiences',
      description:
        'Meta custom audiences on the connected ad account. Reads: LIST; GET (audience_id); LIST_AD_SETS (audience_id → ad sets that include or exclude it). ' +
        'Writes use the same two-call PREVIEW → confirm=true + preview_token flow as other Zoma writes: ' +
        'CREATE (params.name + source: customer_list | website {pixel_id, retention_days ≤180, url_contains?, event_name?} | engagement {source_type page|ig_business, source_id, event?, retention_days ≤365} | lookalike {origin_audience_id, country, ratio_percent 1-10}); ' +
        'UPDATE (audience_id; params.name / description / rule); ADD_USERS / REMOVE_USERS (audience_id; params.emails / params.phones as plain text — Zoma normalizes and SHA-256 hashes them, raw values are never stored); ' +
        'DELETE (audience_id; refused while an active ad set uses it unless confirm_in_use=true); ' +
        'EXCLUDE_CUSTOMERS (ad_set_ids + params.emails/phones or audience_id: creates or reuses a customer list and adds it to excluded_custom_audiences on those ad sets; the preview shows the targeting diff). ' +
        'A write is done only when verification is CONFIRMED. If the result is TERMS_NOT_ACCEPTED, relay terms_url so the user accepts Meta\'s Custom Audience Terms, then retry.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['LIST', 'GET', 'LIST_AD_SETS', 'CREATE', 'UPDATE', 'ADD_USERS', 'REMOVE_USERS', 'DELETE', 'EXCLUDE_CUSTOMERS'] },
          account_id: { type: 'string', description: 'Meta ad account id; needed only when more than one is connected.' },
          audience_id: { type: 'string', description: 'Custom audience id (GET, LIST_AD_SETS, UPDATE, ADD_USERS, REMOVE_USERS, DELETE; optional for EXCLUDE_CUSTOMERS).' },
          ad_set_ids: { type: 'array', items: { type: 'string' }, description: 'EXCLUDE_CUSTOMERS: 1-50 ad set ids to exclude the audience from.' },
          source: {
            type: 'object',
            description: 'CREATE only. type: customer_list | website | engagement | lookalike (external_provider is not available yet).',
            properties: {
              type: { type: 'string', enum: ['customer_list', 'website', 'engagement', 'lookalike', 'external_provider'] },
              pixel_id: { type: 'string' },
              retention_days: { type: 'number' },
              url_contains: { type: 'string' },
              event_name: { type: 'string' },
              source_type: { type: 'string', enum: ['page', 'ig_business'] },
              source_id: { type: 'string' },
              event: { type: 'string' },
              origin_audience_id: { type: 'string' },
              country: { type: 'string' },
              ratio_percent: { type: 'number' },
            },
          },
          params: {
            type: 'object',
            description: 'name, description, rule (UPDATE), emails / phones (arrays of plain-text strings; phones with country code).',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              rule: { type: 'object' },
              emails: { type: 'array', items: { type: 'string' } },
              phones: { type: 'array', items: { type: 'string' } },
            },
          },
          confirm_in_use: { type: 'boolean', description: 'DELETE only: delete even though an active ad set uses the audience. Only after the user explicitly agreed.' },
          confirm: { type: 'boolean', description: 'Writes only. Omit to get a PREVIEW. Set true only after the user approved that preview, with its preview_token.' },
          preview_token: { type: 'string', description: 'Writes only. The preview_token from the approved preview (single use, 15 minutes).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    // ENG-3156: read-only CPA vs a sourced industry benchmark; dispatched by the gateway on the resolved ad account.
    ZOMA_INDUSTRY_BENCHMARK_DEFINITION,
  ];
}
