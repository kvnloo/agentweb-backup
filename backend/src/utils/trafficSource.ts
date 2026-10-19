/**
 * trafficSource — ONE server-side, versioned traffic-source classifier and channel taxonomy.
 * ENG-2313 (slice S3 of epic ENG-2309).
 *
 * Why this exists: DramaBreak's LP (guilty-before-the-mic-v2.html, LP PRs #30/#31) carried a
 * hand-written CLIENT-SIDE classifier. The platform had none, so every LP that copied it could
 * drift ("Twitter" vs "X", "FB" vs "Facebook") and the SDK/ingest (S5) and portal (S7) would each
 * have grown their own. This module is the single implementation: the ingest sends the raw signals
 * it already receives (referrer, landing URL, User-Agent) and gets one stable answer back.
 *
 * It is a port of that V1 logic FIRST (decision order, output strings, channel names, group names
 * are unchanged so rows already written by V1 stay comparable) and then a set of deliberate,
 * individually-tested fixes. Every behavioural difference is listed in the PR (and each one is
 * pinned by a test in __tests__/trafficSource.test.ts) — do not "simplify" a rule here without
 * reading the case it exists for.
 *
 * Decision order (same as V1): paid/organic is decided independently of the channel; the channel
 * comes from utm_source, then the referrer, then the in-app browser User-Agent (in-app browsers
 * often strip the referrer), then — new — a platform click id, then a fallback to the raw
 * utm_source / referrer host / 'Direct'.
 *
 * PURE: no clock, env, network or storage; never throws on any input (garbage in => 'Direct').
 * Dependency-free on purpose so the SDK can reuse the file verbatim.
 *
 * NOT to be confused with landerUtm.ts: that module resolves which UTMs a lander EMITS on its
 * outbound links (visitor > override > default, `aw_lander=1` provenance). This one only READS an
 * inbound visit. The two never share a parameter namespace.
 */

/** Bump on ANY change that can alter an output for an existing input; stored with every row. */
export const TRAFFIC_CLASSIFIER_VERSION = '2.3.0';

export type ChannelGroup =
  | 'Paid'
  | 'Organic Social'
  | 'Organic Search'
  | 'AI Assistant'
  | 'Email'
  | 'Agency'
  | 'Referral'
  | 'Direct';

/** Display order for reports. Strings are V1's, plus 'Email' and 'Agency'. */
export const CHANNEL_GROUPS: readonly ChannelGroup[] = [
  'Paid',
  'Organic Social',
  'Organic Search',
  'AI Assistant',
  'Email',
  'Agency',
  'Referral',
  'Direct',
];

/**
 * utm_medium values the tagged-link generator may emit. All are organic by construction (a test
 * asserts none of them trips the paid rule), and they describe WHERE in the platform the link
 * lives, which is what the team needs to compare (bio vs comment vs story) and what the platform
 * name in utm_source cannot say.
 */
export const ORGANIC_MEDIUMS = [
  'bio', // profile / link-in-bio
  'comment', // pinned or replied comment
  'story', // story link sticker
  'post', // caption, post body, pin, community post
  'description', // YouTube video description
  'dm', // direct message / outreach
  'email', // newsletter
  'agency', // placed by an external agency / partner
] as const;
export type OrganicMedium = (typeof ORGANIC_MEDIUMS)[number];

/** Prefix of utm_source for agency placements: `agency-<slug>`. */
export const AGENCY_SOURCE_PREFIX = 'agency-';

export interface ChannelLinkPreset {
  /** Key accepted by buildTaggedLink `platform`. */
  platform: string;
  /** Short code prefixed to utm_content so the channel survives in reports that show only content. */
  contentCode: string;
  defaultMedium: OrganicMedium;
  /**
   * What the platform sends as `Referer` when a visitor clicks the link. Used by the round-trip test
   * and as documentation. null = no reliable referrer (email clients, agency-controlled placements).
   * Origin-only because modern platforms use strict-origin-when-cross-origin.
   */
  referrerOrigin: string | null;
}

export interface ChannelDef {
  /** Stable machine key. Never rename; add new ones. */
  key: string;
  /** The `channel` string written to rows. V1-compatible. */
  name: string;
  group: ChannelGroup;
  /** The utm_source value this channel's links should use; null = not a link we tag (e.g. Google Search). */
  utmSource: string | null;
  /** Other utm_source spellings that mean this channel. Compared lowercased, separators (_ - space) removed. */
  utmAliases: string[];
  /** Registrable domains: the host or any subdomain of it matches. */
  hosts: string[];
  /** Brand labels that match with any TLD / ccTLD (google.co.uk, pinterest.de): `bing` matches bing.com, not dubbing.com. */
  brandLabels?: string[];
  /** Like brandLabels but only `<brand>.<tld>` / `www.<brand>.<tld>`, no other subdomain (google.com is search, mail.google.com is not). */
  bareBrands?: string[];
  /** host + path prefix, for the few cases where a path is the only signal (bing.com/chat). Needs a path-bearing referrer. */
  paths?: Array<{ host: string; pathPrefix: string }>;
  /** android-app://<package> referrers. */
  appPackages?: string[];
  /** In-app browser User-Agent regex source (case-insensitive). Only consulted when utm/referrer did not decide. */
  inAppUserAgent?: string;
  link?: ChannelLinkPreset;
}

/**
 * THE TAXONOMY. Single source of truth for the classifier, the tagged-link generator and the
 * portal. Order matters only for the in-app User-Agent check (first match wins, V1's order) and
 * for hosts claimed by two channels (the first channel listed wins).
 */
export const CHANNELS: readonly ChannelDef[] = [
  {
    key: 'chatgpt', name: 'ChatGPT', group: 'AI Assistant', utmSource: 'chatgpt',
    // ChatGPT itself tags the links it emits with utm_source=chatgpt.com (observed practice, see PR notes).
    utmAliases: ['chatgpt', 'openai'],
    hosts: ['chatgpt.com', 'chat.openai.com'],
    appPackages: ['com.openai.chatgpt'],
  },
  {
    key: 'claude', name: 'Claude', group: 'AI Assistant', utmSource: 'claude',
    utmAliases: ['claude', 'claudeai', 'anthropic'],
    hosts: ['claude.ai'],
  },
  {
    key: 'gemini', name: 'Gemini', group: 'AI Assistant', utmSource: 'gemini',
    utmAliases: ['gemini', 'bard'],
    hosts: ['gemini.google.com', 'bard.google.com'],
  },
  {
    key: 'perplexity', name: 'Perplexity', group: 'AI Assistant', utmSource: 'perplexity',
    utmAliases: ['perplexity', 'perplexityai'],
    hosts: ['perplexity.ai'],
  },
  {
    key: 'copilot', name: 'Copilot', group: 'AI Assistant', utmSource: 'copilot',
    utmAliases: ['copilot', 'microsoftcopilot', 'bingchat', 'bingcopilot'],
    hosts: ['copilot.microsoft.com', 'copilot.cloud.microsoft'],
    paths: [{ host: 'bing.com', pathPrefix: '/chat' }],
  },
  {
    key: 'other_ai', name: 'Other AI', group: 'AI Assistant', utmSource: null,
    utmAliases: ['deepseek', 'grok', 'metaai', 'youcom', 'phind', 'poe', 'mistral', 'duckai'],
    hosts: ['deepseek.com', 'meta.ai', 'grok.com', 'you.com', 'phind.com', 'poe.com', 'chat.mistral.ai', 'duck.ai'],
    paths: [{ host: 'x.com', pathPrefix: '/i/grok' }],
  },
  {
    key: 'tiktok', name: 'TikTok', group: 'Organic Social', utmSource: 'tiktok',
    utmAliases: ['tiktok', 'tt'],
    hosts: ['tiktok.com'],
    appPackages: ['com.zhiliaoapp.musically', 'com.ss.android.ugc.trill'],
    inAppUserAgent: 'musical_ly|BytedanceWebview|TikTok',
    link: { platform: 'tiktok', contentCode: 'tt', defaultMedium: 'bio', referrerOrigin: 'https://www.tiktok.com/' },
  },
  {
    key: 'instagram', name: 'Instagram', group: 'Organic Social', utmSource: 'instagram',
    utmAliases: ['instagram', 'ig', 'insta'],
    hosts: ['instagram.com', 'instagr.am', 'ig.me'],
    appPackages: ['com.instagram.android'],
    inAppUserAgent: 'Instagram',
    // l.instagram.com is Instagram's outbound link wrapper.
    link: { platform: 'instagram', contentCode: 'ig', defaultMedium: 'bio', referrerOrigin: 'https://l.instagram.com/' },
  },
  {
    key: 'facebook', name: 'Facebook', group: 'Organic Social', utmSource: 'facebook',
    utmAliases: ['facebook', 'fb', 'messenger'],
    hosts: ['facebook.com', 'fb.com', 'fb.me', 'fb.watch', 'messenger.com', 'm.me'],
    appPackages: ['com.facebook.katana', 'com.facebook.orca'],
    inAppUserAgent: 'FBAN|FBAV|FB_IAB',
    // l.facebook.com (desktop) / lm.facebook.com (mobile) are Facebook's outbound link wrappers.
    link: { platform: 'facebook', contentCode: 'fb', defaultMedium: 'post', referrerOrigin: 'https://l.facebook.com/' },
  },
  {
    // adUtm.ts stamps utm_source=meta on Emma's Meta ads; we cannot tell Facebook from Instagram there.
    key: 'meta', name: 'Meta', group: 'Organic Social', utmSource: 'meta',
    utmAliases: ['meta'],
    hosts: [],
  },
  {
    key: 'linkedin', name: 'LinkedIn', group: 'Organic Social', utmSource: 'linkedin',
    utmAliases: ['linkedin', 'li', 'lnkd'],
    hosts: ['linkedin.com', 'lnkd.in'],
    appPackages: ['com.linkedin.android'],
    inAppUserAgent: 'LinkedInApp',
    link: { platform: 'linkedin', contentCode: 'li', defaultMedium: 'post', referrerOrigin: 'https://www.linkedin.com/' },
  },
  {
    key: 'x', name: 'X', group: 'Organic Social', utmSource: 'x',
    utmAliases: ['x', 'twitter'],
    hosts: ['x.com', 'twitter.com', 't.co'],
    appPackages: ['com.twitter.android'],
    link: { platform: 'x', contentCode: 'x', defaultMedium: 'post', referrerOrigin: 'https://t.co/' },
  },
  {
    key: 'youtube', name: 'YouTube', group: 'Organic Social', utmSource: 'youtube',
    utmAliases: ['youtube', 'yt'],
    hosts: ['youtube.com', 'youtu.be'],
    appPackages: ['com.google.android.youtube'],
    link: { platform: 'youtube', contentCode: 'yt', defaultMedium: 'description', referrerOrigin: 'https://www.youtube.com/' },
  },
  {
    key: 'reddit', name: 'Reddit', group: 'Organic Social', utmSource: 'reddit',
    utmAliases: ['reddit'],
    hosts: ['reddit.com', 'redd.it'],
    appPackages: ['com.reddit.frontpage'],
    link: { platform: 'reddit', contentCode: 'rd', defaultMedium: 'post', referrerOrigin: 'https://www.reddit.com/' },
  },
  {
    key: 'pinterest', name: 'Pinterest', group: 'Organic Social', utmSource: 'pinterest',
    utmAliases: ['pinterest'],
    hosts: ['pin.it'],
    brandLabels: ['pinterest'],
    appPackages: ['com.pinterest'],
    link: { platform: 'pinterest', contentCode: 'pin', defaultMedium: 'post', referrerOrigin: 'https://www.pinterest.com/' },
  },
  {
    key: 'other_social', name: 'Other Social', group: 'Organic Social', utmSource: null,
    utmAliases: ['threads', 'snapchat', 'snap', 'discord', 'telegram', 'whatsapp'],
    // threads.net is the pre-April-2025 domain; threads.com is current.
    hosts: ['threads.net', 'threads.com', 'snapchat.com', 'discord.com', 'discord.gg', 'discordapp.com', 't.me', 'telegram.org', 'telegram.me', 'whatsapp.com', 'wa.me'],
    appPackages: ['com.whatsapp', 'org.telegram.messenger', 'com.snapchat.android', 'com.discord', 'com.instagram.barcelona'],
  },
  {
    // Webmail / mail apps. Newsletters rarely carry a referrer, so utm_source=newsletter is the real signal.
    key: 'email', name: 'Email', group: 'Email', utmSource: 'newsletter',
    utmAliases: ['email', 'newsletter', 'mail', 'gmail', 'outlook'],
    hosts: ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com'],
    appPackages: ['com.google.android.gm', 'com.microsoft.office.outlook'],
    link: { platform: 'newsletter', contentCode: 'nl', defaultMedium: 'email', referrerOrigin: 'https://mail.google.com/' },
  },
  {
    key: 'google_search', name: 'Google Search', group: 'Organic Search', utmSource: 'google',
    // 'google' / 'adwords' / 'googleads' is how adUtm.ts and Google Ads auto-tagging name the platform.
    utmAliases: ['google', 'adwords', 'googleads', 'gads'],
    hosts: [],
    bareBrands: ['google'],
    appPackages: ['com.google.android.googlequicksearchbox'],
  },
  {
    key: 'bing_search', name: 'Bing Search', group: 'Organic Search', utmSource: 'bing',
    utmAliases: ['bing'],
    hosts: [],
    brandLabels: ['bing'],
  },
  {
    key: 'duckduckgo', name: 'DuckDuckGo', group: 'Organic Search', utmSource: 'duckduckgo',
    utmAliases: ['duckduckgo', 'ddg'],
    hosts: ['duckduckgo.com'],
  },
  {
    key: 'other_search', name: 'Other Search', group: 'Organic Search', utmSource: null,
    utmAliases: ['yahoo', 'ecosia', 'brave', 'yandex', 'baidu', 'naver', 'startpage', 'qwant', 'kagi'],
    hosts: ['ecosia.org', 'search.brave.com', 'startpage.com', 'qwant.com', 'kagi.com'],
    brandLabels: ['yahoo', 'yandex', 'baidu', 'naver'],
  },
  {
    // NewsBreak's in-platform paid ads (DramaBreak runs these). Paid by construction: a link tagged
    // utm_source=nova is an ad placement even when the medium says nothing (2.2.0).
    key: 'nova', name: 'Nova (NewsBreak Ads)', group: 'Paid', utmSource: 'nova',
    utmAliases: ['nova', 'newsbreaknova', 'nbnova', 'newsbreakads'],
    hosts: [],
  },
  {
    // newsbreak.com itself (organic web visits from the NewsBreak site, not Nova ads).
    key: 'newsbreak', name: 'NewsBreak.com', group: 'Referral', utmSource: 'newsbreak',
    utmAliases: ['newsbreak'],
    hosts: ['newsbreak.com'],
    appPackages: ['com.particlenews.newsbreak'],
  },
  {
    // Placements by an external agency. utm_source is `agency-<slug>`; it OUTRANKS the referrer
    // because the platform an agency posts on is not the attribution we want to report.
    key: 'agency', name: 'Agency', group: 'Agency', utmSource: `${AGENCY_SOURCE_PREFIX}<name>`,
    utmAliases: ['agency'],
    hosts: [],
    link: { platform: 'agency', contentCode: 'ag', defaultMedium: 'agency', referrerOrigin: null },
  },
];

/** In-app UA regexes, compiled once (V1 order = CHANNELS order). */
const IN_APP_UA_MATCHERS: ReadonlyArray<{ def: ChannelDef; re: RegExp }> = CHANNELS.filter((c) => c.inAppUserAgent).map((def) => ({
  def,
  re: new RegExp(def.inAppUserAgent as string, 'i'),
}));

const CHANNEL_BY_KEY: ReadonlyMap<string, ChannelDef> = new Map(CHANNELS.map((c) => [c.key, c]));

/** JSON-safe view of the taxonomy for GET /api/tracking/channels and the future portal. */
export function getTrafficTaxonomy(): {
  classifierVersion: string;
  groups: readonly ChannelGroup[];
  organicMediums: readonly OrganicMedium[];
  agencySourcePrefix: string;
  channels: readonly ChannelDef[];
} {
  return {
    classifierVersion: TRAFFIC_CLASSIFIER_VERSION,
    groups: CHANNEL_GROUPS,
    organicMediums: ORGANIC_MEDIUMS,
    agencySourcePrefix: AGENCY_SOURCE_PREFIX,
    channels: CHANNELS,
  };
}

export function getChannelByKey(key: string): ChannelDef | undefined {
  return CHANNEL_BY_KEY.get(key);
}

// ---------------------------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------------------------

export interface ClassifyTrafficInput {
  /** Full landing URL (may be relative or have no scheme; only the query string and host are used). */
  landingUrl?: string;
  /** Structured UTMs (AttributionTouch.utm). A value here wins over the same key in landingUrl. */
  utm?: { source?: string; medium?: string; campaign?: string; content?: string; term?: string };
  /** Click ids (AttributionTouch.clickIds plus the extra paid ids V1 recognised). Either liFatId or li_fat_id. */
  clickIds?: Record<string, string | undefined>;
  /** document.referrer as captured by the client. */
  referrer?: string;
  /** User-Agent request header. */
  userAgent?: string;
  /** The landing page's own hostname; defaults to the host of landingUrl. Used to discard internal referrers. */
  hostname?: string;
}

export type MatchedBy =
  | 'utm_source'
  | 'referrer'
  | 'user_agent'
  | 'click_id'
  | 'url:nova'
  | 'fallback_utm_source'
  | 'fallback_referrer'
  | 'none';

export interface TrafficClassification {
  trafficType: 'paid' | 'organic';
  /** V1-compatible channel string ('TikTok', 'Google Search', ...) or the raw utm_source / referrer host / 'Direct'. */
  channel: string;
  /** Stable key from CHANNELS, or 'other' (unknown utm_source/referrer) / 'direct'. */
  channelKey: string;
  channelGroup: ChannelGroup;
  /** www-stripped, lowercased host (or android package id); '' for direct and for internal referrers. */
  referrerHost: string;
  /** Full referrer URL, only when it carries a path/query/fragment (platforms usually send origin-only). */
  sourceLink: string;
  /** `utm_source=.. | utm_medium=.. | ...` placement tag, V1 format. */
  sourceDetail: string;
  /** Which signal decided the channel (diagnostic; not a stable analytics dimension). */
  matchedBy: MatchedBy;
  /** Channel the LINK claims (from utm_source), '' when untagged/unknown. Reported beside `channel`. */
  linkChannel: string;
  /** Channel observed from the visit itself (in-app UA, then referrer), '' when nothing observable. */
  detectedChannel: string;
  /** What made it paid, e.g. 'click_id:gclid' or 'utm_medium:cpc'; null when organic. */
  paidSignal: string | null;
  classifierVersion: string;
}

// ---------------------------------------------------------------------------------------------
// Input hygiene
// ---------------------------------------------------------------------------------------------

const MAX_INPUT_LEN = 4096;
const SOURCE_LINK_MAX = 300;
const SOURCE_DETAIL_MAX = 300;
const FALLBACK_CHANNEL_MAX = 40;

/**
 * A value that is a template placeholder rather than data. `utm_source=undefined` is what a
 * broken ad template or client SDK sends; classifying it as a channel called "undefined" would
 * put garbage in a report. Applied to UTMs and click ids only.
 */
function cleanValue(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim().slice(0, MAX_INPUT_LEN);
  if (!t || /^(undefined|null)$/i.test(t)) return '';
  return t;
}

/** Query parameters of any URL-ish string; keys lowercased, first occurrence wins (URLSearchParams.get semantics). */
function readQuery(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof raw !== 'string') return out;
  const s = raw.slice(0, MAX_INPUT_LEN);
  const noHash = s.split('#')[0];
  const qi = noHash.indexOf('?');
  if (qi === -1) return out;
  try {
    for (const [k, v] of new URLSearchParams(noHash.slice(qi + 1))) {
      const key = k.toLowerCase();
      if (!out.has(key)) out.set(key, v);
    }
  } catch {
    /* URLSearchParams does not throw on strings; belt and braces for exotic runtimes */
  }
  return out;
}

/**
 * Host of an absolute-ish URL, www-stripped and lowercased; '' when there is none. A path-only or
 * relative value ('/guilty?x=1') has no host: `https:///guilty` would otherwise parse to host 'guilty'.
 */
function hostOf(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  const s = raw.trim().slice(0, MAX_INPUT_LEN);
  if (!s) return '';
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  const looksLikeHost = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i.test(s) || /^[a-z0-9-]+(:\d+)?$/i.test(s);
  if (!hasScheme && !looksLikeHost) return '';
  try {
    const u = new URL(hasScheme ? s : `https://${s}`);
    return u.hostname.replace(/^www\./, '').replace(/\.$/, '').toLowerCase();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------
// Host matching (replaces V1's unanchored substring regexes)
// ---------------------------------------------------------------------------------------------

/** Second-level labels that make `<brand>.co.uk` / `<brand>.com.au` count as one TLD. */
const SECOND_LEVEL_LABELS: ReadonlySet<string> = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'ne', 'or']);

function restIsTld(rest: string[]): boolean {
  return rest.length === 1 || (rest.length === 2 && SECOND_LEVEL_LABELS.has(rest[0]));
}

function hasBrandLabel(host: string, brand: string, bare: boolean): boolean {
  const labels = host.split('.');
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== brand) continue;
    if (bare && i !== 0) continue;
    if (restIsTld(labels.slice(i + 1))) return true;
  }
  return false;
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

interface ParsedReferrer {
  kind: 'web' | 'app';
  host: string;
  url: URL;
  raw: string;
}

/**
 * Accepts http(s) URLs, android-app://<package> (what Chrome on Android reports when an app opened
 * the page) and scheme-less `host/path` (some SDKs send the bare host). Everything else —
 * 'about:blank', 'null', free text — is not a referrer. V1 ran its regexes over the raw string even
 * when it did not parse, so the text "i saw this on tiktok" classified as TikTok.
 */
function parseReferrer(rawIn: unknown): ParsedReferrer | null {
  if (typeof rawIn !== 'string') return null;
  const raw = rawIn.trim().slice(0, MAX_INPUT_LEN);
  if (!raw) return null;
  let candidate: string;
  let kind: 'web' | 'app';
  if (/^android-app:\/\//i.test(raw)) {
    candidate = raw;
    kind = 'app';
  } else if (/^https?:\/\//i.test(raw)) {
    candidate = raw;
    kind = 'web';
  } else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i.test(raw)) {
    candidate = `https://${raw}`;
    kind = 'web';
  } else {
    return null;
  }
  try {
    const url = new URL(candidate);
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    if (!host) return null;
    return { kind, host: kind === 'web' ? host.replace(/^www\./, '') : host, url, raw };
  } catch {
    return null;
  }
}

function channelMatchesReferrer(def: ChannelDef, ref: ParsedReferrer): boolean {
  if (ref.kind === 'app') return !!def.appPackages?.includes(ref.host);
  const h = ref.host;
  if (def.hosts.some((d) => hostMatchesDomain(h, d))) return true;
  if (def.brandLabels?.some((b) => hasBrandLabel(h, b, false))) return true;
  if (def.bareBrands?.some((b) => hasBrandLabel(h, b, true))) return true;
  if (def.paths?.some((p) => hostMatchesDomain(h, p.host) && (ref.url.pathname === p.pathPrefix || ref.url.pathname.startsWith(`${p.pathPrefix}/`)))) {
    return true;
  }
  return false;
}

function findChannelByReferrer(ref: ParsedReferrer): ChannelDef | undefined {
  return CHANNELS.find((c) => channelMatchesReferrer(c, ref));
}

// ---------------------------------------------------------------------------------------------
// utm_source matching
// ---------------------------------------------------------------------------------------------

const stripSeparators = (s: string): string => s.replace(/[\s_\-+]+/g, '');

/**
 * Aliases of this many characters or fewer ('ig', 'tt', 'x', 'li') match only the WHOLE value;
 * a bare 'x' or 'li' inside 'ax_files' or 'film' must not claim a channel.
 */
const SHORT_ALIAS_MAX = 3;
/** Brand aliases at least this long also match as a prefix ('tiktokads', 'instagramstories') like V1's substring did. */
const PREFIX_ALIAS_MIN = 6;

const ALIAS_INDEX: ReadonlyArray<{ def: ChannelDef; aliases: string[] }> = CHANNELS.map((def) => ({
  def,
  aliases: [def.key.replace(/_/g, ''), ...def.utmAliases].map(stripSeparators),
}));

function matchUtmSourceAlias(sourceLower: string): ChannelDef | undefined {
  const whole = stripSeparators(sourceLower);
  const tokens = sourceLower.split(/[^a-z0-9]+/).filter(Boolean);
  for (const { def, aliases } of ALIAS_INDEX) {
    for (const alias of aliases) {
      if (whole === alias) return def;
      if (alias.length <= SHORT_ALIAS_MAX) continue;
      for (const t of tokens) {
        if (t === alias || (alias.length >= PREFIX_ALIAS_MIN && t.startsWith(alias))) return def;
      }
    }
  }
  return undefined;
}

function matchUtmSource(sourceLower: string): ChannelDef | undefined {
  if (!sourceLower) return undefined;
  // `agency-<slug>` (what the generator emits), plus bare 'agency'.
  if (/^agency([\s_\-:]|$)/.test(sourceLower)) return CHANNEL_BY_KEY.get('agency');
  // Host-like values: 'l.instagram.com', 'lm.facebook.com', 'out.reddit.com', 't.co',
  // 'android-app://com.google.android.gm'. Same matcher as a real referrer so the two cannot disagree.
  if (sourceLower.includes('.') || sourceLower.includes('://')) {
    const ref = parseReferrer(sourceLower);
    if (ref) {
      const byHost = findChannelByReferrer(ref);
      if (byHost) return byHost;
    }
  }
  return matchUtmSourceAlias(sourceLower);
}

// ---------------------------------------------------------------------------------------------
// Paid detection
// ---------------------------------------------------------------------------------------------

/** V1's list, in V1's order. Exported so the link generator can refuse to emit any of them. */
export const PAID_PARAM_KEYS = ['fbclid', 'ad_id', 'adset_id', 'campaign_id', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'li_fat_id', 'msclkid'] as const;

/**
 * V1: cpc|ppc|cpm|paid|ads?|display|paidsocial|paid_social, bounded by non-letters. Equivalent to
 * "some alphabetic token of utm_medium is one of these". Added: cpv, retargeting, remarketing,
 * sponsored (GA4's own paid mediums / obvious paid wording). Negations ('non-paid', 'no_ads')
 * are NOT paid: V1 flagged them paid.
 */
const PAID_MEDIUM_TOKENS: ReadonlySet<string> = new Set([
  'cpc', 'ppc', 'cpm', 'cpv', 'paid', 'ad', 'ads', 'display', 'paidsocial', 'retargeting', 'remarketing', 'sponsored',
]);
const NEGATION_TOKENS: ReadonlySet<string> = new Set(['non', 'not', 'no', 'unpaid', 'without']);

/** Exported so the generator can refuse to emit a medium the classifier would call paid. */
export function paidMediumToken(medium: string): string | null {
  const tokens = medium.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (!PAID_MEDIUM_TOKENS.has(tokens[i])) continue;
    if (i > 0 && NEGATION_TOKENS.has(tokens[i - 1])) continue;
    return tokens[i];
  }
  return null;
}

/** Click id key -> channel, for sessions with a platform click id and no other source signal. */
const CLICK_ID_CHANNEL: Record<string, string> = {
  fbclid: 'meta',
  gclid: 'google_search',
  gbraid: 'google_search',
  wbraid: 'google_search',
  ttclid: 'tiktok',
  li_fat_id: 'linkedin',
  msclkid: 'bing_search',
};

const CLICK_ID_INPUT_ALIASES: Record<string, string> = { lifatid: 'li_fat_id', adid: 'ad_id', adsetid: 'adset_id', campaignid: 'campaign_id' };

// ---------------------------------------------------------------------------------------------
// Internal referrers
// ---------------------------------------------------------------------------------------------

/**
 * Multi-tenant hosting suffixes: `a.vercel.app` and `b.vercel.app` are unrelated sites, so the
 * subdomain rule below must not call them the same site.
 */
const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  'vercel.app', 'netlify.app', 'github.io', 'pages.dev', 'herokuapp.com', 'web.app', 'firebaseapp.com',
  'onrender.com', 'fly.dev', 'workers.dev', 'azurewebsites.net', 'cloudfront.net',
]);

/**
 * Same site: identical host (www ignored), or one is a subdomain of the other
 * (dramabreak.ai -> go.dramabreak.ai is the brand's own navigation, not a source).
 * V1 compared for exact host equality only.
 */
function isInternal(refHost: string, ownHost: string): boolean {
  if (!refHost || !ownHost) return false;
  if (refHost === ownHost) return true;
  const sub = (child: string, parent: string): boolean =>
    child.endsWith(`.${parent}`) && parent.includes('.') && !SHARED_SUFFIXES.has(parent);
  return sub(refHost, ownHost) || sub(ownHost, refHost);
}

// ---------------------------------------------------------------------------------------------
// classifyTraffic
// ---------------------------------------------------------------------------------------------

const SOURCE_DETAIL_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'src', 'post'] as const;

/** Paid variants of channels whose organic and paid traffic must read differently in reports. */
export const PAID_CHANNEL_SPLIT: Readonly<Record<string, { key: string; name: string }>> = {
  google_search: { key: 'google_ads', name: 'Google Ads' },
  youtube: { key: 'youtube_ads', name: 'YouTube Ads' },
};

/**
 * Maps a (channel, channelKey, paid) triple to its split channel. Pure and idempotent, so the same
 * function serves live classification and a retroactive backfill of stored rows.
 */
export function splitPaidChannel(channel: string, channelKey: string, paid: boolean): { channel: string; channelKey: string } {
  const split = paid ? PAID_CHANNEL_SPLIT[channelKey] : undefined;
  return split ? { channel: split.name, channelKey: split.key } : { channel, channelKey };
}

export function classifyTraffic(input: ClassifyTrafficInput = {}): TrafficClassification {
  const safe = input && typeof input === 'object' ? input : {};

  // 1. Gather parameters. Structured values win per key; the landing URL fills the rest.
  const query = readQuery(safe.landingUrl);
  const param = (key: string): string => cleanValue(query.get(key));
  const utmIn = safe.utm && typeof safe.utm === 'object' ? safe.utm : {};
  const utm = {
    utm_source: cleanValue(utmIn.source) || param('utm_source'),
    utm_medium: cleanValue(utmIn.medium) || param('utm_medium'),
    utm_campaign: cleanValue(utmIn.campaign) || param('utm_campaign'),
    utm_content: cleanValue(utmIn.content) || param('utm_content'),
    utm_term: cleanValue(utmIn.term) || param('utm_term'),
  };

  const clickIds = new Map<string, string>();
  if (safe.clickIds && typeof safe.clickIds === 'object') {
    for (const [k, v] of Object.entries(safe.clickIds)) {
      const norm = k.toLowerCase().replace(/[\s_-]/g, '');
      const key = CLICK_ID_INPUT_ALIASES[norm] ?? k.toLowerCase();
      const val = cleanValue(v);
      if (val && !clickIds.has(key)) clickIds.set(key, val);
    }
  }
  for (const key of PAID_PARAM_KEYS) {
    if (!clickIds.has(key) && param(key)) clickIds.set(key, param(key));
  }

  // 2. Paid vs organic (independent of channel).
  // STRONG signals: any click/ad id except fbclid, or a paid utm_medium token.
  // fbclid is WEAK: Facebook/Instagram append it to every outbound click, organic included, so it
  // proves nothing on a link we tagged ourselves. It counts as paid only when the link does not
  // declare an organic utm_medium. Untagged fbclid-only stays paid (V1); it cannot be separated.
  let paidSignal: string | null = null;
  for (const key of PAID_PARAM_KEYS) {
    if (key !== 'fbclid' && clickIds.has(key)) {
      paidSignal = `click_id:${key}`;
      break;
    }
  }
  if (!paidSignal) {
    const tok = paidMediumToken(utm.utm_medium);
    if (tok) paidSignal = `utm_medium:${tok}`;
  }
  if (!paidSignal && clickIds.has('fbclid') && !(ORGANIC_MEDIUMS as readonly string[]).includes(utm.utm_medium.toLowerCase())) {
    paidSignal = 'click_id:fbclid';
  }

  // 3. Referrer (internal ones are not a source at all).
  const ownHost = (hostOf(safe.hostname) || hostOf(safe.landingUrl)).replace(/:\d+$/, '');
  let ref = parseReferrer(safe.referrer);
  if (ref && ref.kind === 'web' && isInternal(ref.host, ownHost)) ref = null;
  const referrerHost = ref ? ref.host : '';

  // 4. Channel (2.2.0). One link per creator is the norm (DramaBreak tags most links 'tiktok' even
  // when posted on YouTube), so what we OBSERVE about the visit beats what the link claims:
  //   observed = in-app browser UA (the visitor is physically inside that app) -> referrer.
  //   Exceptions where the link wins: agency-<slug> (attribution is the agency, not the platform)
  //   and paid traffic (the ad platform in utm_source is the spend we must attribute: Meta, Nova).
  // Then link (utm_source) -> click id -> fallback. linkChannel/detectedChannel expose both signals.
  const sourceLower = utm.utm_source.toLowerCase();
  let def: ChannelDef | undefined;
  let matchedBy: MatchedBy = 'none';

  // 2.3.0: NewsBreak Nova ads that omit utm_source=nova still carry their own URL signals
  // (is_nova=true, nb_cid, utm_content=nvss_*). Without this they classified as organic
  // newsbreak.com / Direct traffic and were routed into organic-only lists.
  const novaUrlSignal = param('is_nova').toLowerCase() === 'true' || Boolean(param('nb_cid'))
    || utm.utm_content.toLowerCase().startsWith('nvss_');
  const utmLinkDef = matchUtmSource(sourceLower);
  const novaUrlDef = !utmLinkDef && !sourceLower && novaUrlSignal ? CHANNEL_BY_KEY.get('nova') : undefined;
  const linkDef = utmLinkDef ?? novaUrlDef;
  if (linkDef?.key === 'nova' && !paidSignal) paidSignal = utmLinkDef ? 'utm_source:nova' : 'url:nova';
  const paidFinal = paidSignal !== null;
  let detectedDef: ChannelDef | undefined;
  let detectedBy: MatchedBy = 'none';
  if (typeof safe.userAgent === 'string') {
    const ua = safe.userAgent.slice(0, MAX_INPUT_LEN);
    detectedDef = IN_APP_UA_MATCHERS.find((m) => m.re.test(ua))?.def;
    if (detectedDef) detectedBy = 'user_agent';
  }
  if (!detectedDef && ref) {
    detectedDef = findChannelByReferrer(ref);
    if (detectedDef) detectedBy = 'referrer';
  }

  if (linkDef && (linkDef.key === 'agency' || paidFinal)) {
    def = linkDef;
    matchedBy = novaUrlDef ? 'url:nova' : 'utm_source';
  } else if (detectedDef) {
    def = detectedDef;
    matchedBy = detectedBy;
  } else if (linkDef) {
    def = linkDef;
    matchedBy = novaUrlDef ? 'url:nova' : 'utm_source';
  }

  // New vs V1: a platform click id with no other source signal names its platform, instead of the
  // contradictory V1 result of channel 'Direct' in group 'Paid'.
  if (!def && !sourceLower && !ref) {
    for (const key of Object.keys(CLICK_ID_CHANNEL)) {
      if (clickIds.has(key)) {
        def = CHANNEL_BY_KEY.get(CLICK_ID_CHANNEL[key]);
        matchedBy = 'click_id';
        break;
      }
    }
  }

  let channel: string;
  let channelKey: string;
  let group: ChannelGroup;
  if (def) {
    channel = def.name;
    channelKey = def.key;
    group = def.group;
  } else {
    // V1 fallback: raw utm_source (capped), else referrer host, else Direct.
    channel = sourceLower ? sourceLower.slice(0, FALLBACK_CHANNEL_MAX) : referrerHost ? referrerHost : 'Direct';
    channelKey = sourceLower || referrerHost ? 'other' : 'direct';
    group = sourceLower || referrerHost ? 'Referral' : 'Direct';
    matchedBy = sourceLower ? 'fallback_utm_source' : referrerHost ? 'fallback_referrer' : 'none';
  }
  const paid = paidSignal !== null;
  if (paid) group = 'Paid';
  // 2.1.0: paid Google / YouTube traffic gets its own channel so CRM rows and reports separate
  // Google Ads from organic Google Search (and YouTube ads from organic YouTube) without needing
  // the trafficType column.
  ({ channel, channelKey } = splitPaidChannel(channel, channelKey, paid));

  // 5. Exact source: the referrer URL when it says more than the origin; else the placement tag.
  let sourceLink = '';
  if (ref && ref.kind === 'web' && (ref.url.pathname !== '/' || ref.url.search || ref.url.hash)) {
    sourceLink = ref.raw.slice(0, SOURCE_LINK_MAX);
  }
  const detailParts: string[] = [];
  for (const key of SOURCE_DETAIL_KEYS) {
    const v = key.startsWith('utm_') ? utm[key as keyof typeof utm] : param(key);
    if (v) detailParts.push(`${key}=${v}`);
  }
  const sourceDetail = detailParts.join(' | ').slice(0, SOURCE_DETAIL_MAX);

  return {
    trafficType: paid ? 'paid' : 'organic',
    channel,
    channelKey,
    channelGroup: group,
    referrerHost,
    sourceLink,
    sourceDetail,
    matchedBy,
    linkChannel: utmLinkDef ? utmLinkDef.name : '',
    detectedChannel: detectedDef ? detectedDef.name : '',
    paidSignal,
    classifierVersion: TRAFFIC_CLASSIFIER_VERSION,
  };
}
