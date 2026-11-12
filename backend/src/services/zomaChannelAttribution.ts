/**
 * ENG-2886: Zoma launch channel attribution (pure; no persistence).
 *
 * - LAUNCH_CHANNELS is the canonical channel taxonomy for launch links.
 * - buildTrackedLink() produces a unique tracked link per channel.
 * - classifyAcquisitionSource() maps a visit's utm/ref/referrer to exactly
 *   one channel, so a single signup is never counted under two channels.
 * - summarizeFunnel() reduces signup records into a per-channel
 *   visitor -> signup -> first-ad funnel, counting each account once.
 */

export const LAUNCH_CHANNELS = [
  "linkedin",
  "x",
  "product_hunt",
  "founder_referral",
  "community",
  "email",
  "agency",
  "partner",
] as const;

export type LaunchChannel = (typeof LAUNCH_CHANNELS)[number];
export type AttributedChannel = LaunchChannel | "direct" | "other";

const UTM_MEDIUM: Record<LaunchChannel, string> = {
  linkedin: "social",
  x: "social",
  product_hunt: "launch",
  founder_referral: "referral",
  community: "community",
  email: "email",
  agency: "partner",
  partner: "partner",
};

export interface TrackedLinkOptions {
  campaign?: string;
  /** Distinguishes links within a channel, e.g. a founder or community name. */
  content?: string;
}

const SLUG = /[^a-z0-9_-]+/g;
function slug(value: string): string {
  return value.trim().toLowerCase().replace(SLUG, "-").replace(/^-+|-+$/g, "");
}

export function isLaunchChannel(value: unknown): value is LaunchChannel {
  return typeof value === "string" && (LAUNCH_CHANNELS as readonly string[]).includes(value);
}

export function buildTrackedLink(
  baseUrl: string,
  channel: LaunchChannel,
  options: TrackedLinkOptions = {},
): string {
  if (!isLaunchChannel(channel)) {
    throw new Error(`Unknown launch channel: ${String(channel)}`);
  }
  const url = new URL(baseUrl);
  url.searchParams.set("utm_source", channel);
  url.searchParams.set("utm_medium", UTM_MEDIUM[channel]);
  url.searchParams.set("utm_campaign", slug(options.campaign ?? "zoma_launch") || "zoma_launch");
  if (options.content) {
    const content = slug(options.content);
    if (content) url.searchParams.set("utm_content", content);
  }
  return url.toString();
}

export interface AcquisitionInput {
  utm_source?: string | null;
  utm_medium?: string | null;
  ref?: string | null;
  referrer?: string | null;
}

const SOURCE_ALIASES: Record<string, LaunchChannel> = {
  linkedin: "linkedin",
  "linkedin.com": "linkedin",
  li: "linkedin",
  x: "x",
  twitter: "x",
  "x.com": "x",
  "twitter.com": "x",
  "t.co": "x",
  product_hunt: "product_hunt",
  producthunt: "product_hunt",
  "product-hunt": "product_hunt",
  ph: "product_hunt",
  "producthunt.com": "product_hunt",
  founder_referral: "founder_referral",
  founder: "founder_referral",
  referral: "founder_referral",
  community: "community",
  slack: "community",
  discord: "community",
  reddit: "community",
  "reddit.com": "community",
  email: "email",
  newsletter: "email",
  agency: "agency",
  agencies: "agency",
  partner: "partner",
  partners: "partner",
};

const REFERRER_HOSTS: Array<[RegExp, LaunchChannel]> = [
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "linkedin"],
  [/(^|\.)(x|twitter)\.com$|^t\.co$/, "x"],
  [/(^|\.)producthunt\.com$/, "product_hunt"],
  [/(^|\.)(reddit\.com|discord\.com|discord\.gg|slack\.com)$/, "community"],
  [/^(mail\.google\.com|outlook\.(live|office)\.com)$/, "email"],
];

function lookupAlias(value: string | null | undefined): LaunchChannel | null {
  if (!value) return null;
  const key = value.trim().toLowerCase();
  return SOURCE_ALIASES[key] ?? SOURCE_ALIASES[key.replace(/[\s-]+/g, "_")] ?? null;
}

/**
 * Precedence: utm_source, then ref, then referrer host. Explicit tagging
 * always beats inferred referrers. Returns exactly one channel.
 */
export function classifyAcquisitionSource(input: AcquisitionInput): AttributedChannel {
  const tagged = lookupAlias(input.utm_source) ?? lookupAlias(input.ref);
  if (tagged) return tagged;
  if (input.utm_source && input.utm_source.trim()) return "other";

  if (input.referrer) {
    let host: string;
    try {
      host = new URL(input.referrer).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "other";
    }
    for (const [pattern, channel] of REFERRER_HOSTS) {
      if (pattern.test(host)) return channel;
    }
    return "other";
  }
  return "direct";
}

export interface FunnelRecord {
  /** Stable account/user id; duplicates are counted once (first touch wins). */
  accountId: string;
  channel: AttributedChannel;
  signedUp: boolean;
  firstAdLaunched: boolean;
}

export interface ChannelFunnel {
  visitors: number;
  signups: number;
  firstAds: number;
}

export function summarizeFunnel(records: FunnelRecord[]): Record<AttributedChannel, ChannelFunnel> {
  const channels: AttributedChannel[] = [...LAUNCH_CHANNELS, "direct", "other"];
  const out = Object.fromEntries(
    channels.map((c) => [c, { visitors: 0, signups: 0, firstAds: 0 }]),
  ) as Record<AttributedChannel, ChannelFunnel>;

  const byAccount = new Map<string, FunnelRecord>();
  for (const r of records) {
    const prev = byAccount.get(r.accountId);
    if (!prev) {
      byAccount.set(r.accountId, { ...r });
    } else {
      // First touch keeps the channel; later progress still counts once.
      prev.signedUp = prev.signedUp || r.signedUp;
      prev.firstAdLaunched = prev.firstAdLaunched || r.firstAdLaunched;
    }
  }
  for (const r of byAccount.values()) {
    const bucket = out[r.channel] ?? out.other;
    bucket.visitors += 1;
    if (r.signedUp) bucket.signups += 1;
    if (r.signedUp && r.firstAdLaunched) bucket.firstAds += 1;
  }
  return out;
}
