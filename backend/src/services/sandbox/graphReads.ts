import { createHash } from 'crypto';
import { addDays, dayOf, shiftDay, shiftIso, unixSeconds, unshiftRange, DayRange } from './dateShift';
import { GraphError, graphErrors } from './graphError';
import {
  getInsightsReportRows, getInsightsReportStatus, hasInsightsReport, parseInsightsParams, runInsights, FIRST_PAGE_CURSORS,
  InsightsLevel, InsightsNode,
} from './insightsEngine';
import { compareIds, resolveObjects, ResolvedObjects } from './objects';
import type {
  SandboxAd, SandboxAdImage, SandboxAdSet, SandboxCampaign, SandboxCreative, SandboxCustomAudience, SandboxDataset, SandboxOverlay, SandboxPage, SandboxPixel,
  SimRequest, SimResponse,
} from './types';

/**
 * Meta Graph READ simulation (ENG-1908 AC 1/2). Every GET the product performs against a
 * connected Meta account — identity, account, object graph, creatives, pixels, audiences,
 * targeting search, sync and async insights — answered from the frozen dataset + overlay in
 * Meta's wire shape. Returns null for anything it does not serve (writes, unknown edges) so
 * the router decides what that means.
 */
export interface GraphReadContext {
  dataset: SandboxDataset;
  overlay: SandboxOverlay;
  /** Whole days added to every frozen date (see dateShift). */
  shift: number;
  now: Date;
  userId: string;
  token: string;
}

// ---------- field selector grammar: a,b{c,d},e.arg(v).arg2(v){f} ----------

export interface FieldNode { name: string; args?: Record<string, unknown>; children?: FieldNode[] }

export function parseFields(spec: string): FieldNode[] {
  let pos = 0;
  const peek = () => spec[pos];
  const readName = (): string => {
    const start = pos;
    while (pos < spec.length && /[A-Za-z0-9_]/.test(spec[pos])) pos++;
    if (pos === start) throw graphErrors.invalidParam(`Syntax error "Expected name" at character ${pos}: ${spec}`);
    return spec.slice(start, pos);
  };
  const readBalanced = (open: string, close: string): string => {
    let depth = 0; const start = pos; let quote: string | null = null;
    for (; pos < spec.length; pos++) {
      const ch = spec[pos];
      if (quote) { if (ch === '\\') { pos++; continue; } if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) { pos++; return spec.slice(start + 1, pos - 1); } }
    }
    throw graphErrors.invalidParam(`Syntax error "Unmatched ${open}" in fields: ${spec}`);
  };
  const parseArg = (raw: string): unknown => {
    const trimmed = raw.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) { try { return JSON.parse(trimmed); } catch { /* fall through to raw */ } }
    return trimmed.replace(/^['"]|['"]$/g, '');
  };
  const parseList = (): FieldNode[] => {
    const nodes: FieldNode[] = [];
    while (pos < spec.length && peek() !== '}') {
      const node: FieldNode = { name: readName() };
      for (;;) {
        if (peek() === '.') { pos++; const argName = readName(); if (peek() !== '(') throw graphErrors.invalidParam(`Syntax error "Expected (" at character ${pos}: ${spec}`); (node.args ??= {})[argName] = parseArg(readBalanced('(', ')')); continue; }
        if (peek() === '{') { pos++; node.children = parseList(); if (peek() !== '}') throw graphErrors.invalidParam(`Syntax error "Unmatched {" in fields: ${spec}`); pos++; continue; }
        break;
      }
      nodes.push(node);
      if (peek() === ',') pos++;
      else if (pos < spec.length && peek() !== '}') throw graphErrors.invalidParam(`Syntax error "Expected , or }" at character ${pos}: ${spec}`);
    }
    return nodes;
  };
  const nodes = parseList();
  if (pos < spec.length) throw graphErrors.invalidParam(`Syntax error "Unexpected }" at character ${pos}: ${spec}`);
  return nodes;
}

// ---------- generic projection ----------

type Json = Record<string, unknown>;
type Resolver = (node: FieldNode) => unknown;

function deepPick(value: unknown, children: FieldNode[] | undefined): unknown {
  if (!children || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => deepPick(v, children));
  const out: Json = {};
  for (const child of children) {
    const inner = (value as Json)[child.name];
    if (inner !== undefined) out[child.name] = deepPick(inner, child.children);
  }
  return out;
}

/** Projects a full Meta-shaped view down to the requested fields; `id` always rides along. */
function project(view: Json, fields: FieldNode[] | undefined, resolvers: Record<string, Resolver> = {}, defaults: string[] = ['id', 'name']): Json {
  const out: Json = {};
  const nodes: FieldNode[] = fields && fields.length ? fields : defaults.map((name) => ({ name }));
  for (const node of nodes) {
    if (resolvers[node.name]) { const value = resolvers[node.name](node); if (value !== undefined) out[node.name] = value; continue; }
    const value = view[node.name];
    if (value !== undefined) out[node.name] = deepPick(value, node.children);
  }
  if (view.id !== undefined && out.id === undefined) out.id = view.id;
  return out;
}

const money = (minor: number | undefined) => (minor === undefined ? undefined : String(Math.round(minor)));
const envelope = (data: unknown[], paging: { cursors: { before: string; after: string }; next?: string } = { cursors: { ...FIRST_PAGE_CURSORS } }) => ({ data, paging });
const ok = (body: unknown, headers: Record<string, string> = {}): SimResponse => ({ status: 200, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function parseJsonParam(value: string | undefined, name: string): unknown {
  if (value === undefined || value === '') return undefined;
  try { return JSON.parse(value); } catch { throw graphErrors.invalidParam(`Param ${name} must be valid JSON`); }
}

// ---------- views: the dataset object → the full Meta-shaped node ----------

class Views {
  readonly objects: ResolvedObjects;
  constructor(readonly ctx: GraphReadContext) { this.objects = resolveObjects(ctx.dataset, ctx.overlay, ctx.now); }

  private t(iso: string | undefined): string | undefined { return iso === undefined ? undefined : shiftIso(iso, this.ctx.shift); }

  get accountId(): string { return this.ctx.dataset.account.account_id; }
  get business() { return this.ctx.dataset.account.business ?? { id: `3${this.accountId.slice(1)}`, name: `${this.ctx.dataset.account.name} Business` }; }

  /** Deterministic Meta user id for the connected principal ("me"). */
  get userId(): string {
    const digest = createHash('sha256').update(this.ctx.userId).digest();
    let digits = '';
    for (let i = 0; digits.length < 12; i++) digits += (digest[i] % 10).toString();
    return `10${digits}`;
  }

  user(): Json {
    const name = this.ctx.dataset.account.name;
    const [first, ...rest] = name.split(' ');
    return { id: this.userId, name, first_name: first, last_name: rest.join(' ') || first, email: 'sandbox@example.invalid' };
  }

  account(): Json {
    const a = this.ctx.dataset.account;
    const spendMinor = this.ctx.dataset.insightsDaily.reduce((n, r) => n + r.spend, 0);
    const created = this.ctx.dataset.meta.frozenWindow.since;
    return {
      id: a.id, account_id: a.account_id, name: a.name, currency: a.currency, timezone_name: a.timezone_name, timezone_id: 0, timezone_offset_hours_utc: 0,
      account_status: a.account_status, disable_reason: 0, business: this.business, business_name: this.business.name, owner: this.business.id,
      amount_spent: String(spendMinor), balance: '0', spend_cap: '0', min_daily_budget: 100, is_prepay_account: false, is_personal: 0, tax_id_status: 0,
      age: Math.max(1, Math.round((this.ctx.now.getTime() - new Date(`${created}T00:00:00Z`).getTime()) / 86_400_000)) + 30,
      created_time: this.t(`${addDays(created, -30)}T00:00:00+0000`), has_advertiser_opted_in_odax: true, offsite_pixels_tos_accepted: true,
      capabilities: ['CAN_CREATE_LOOKALIKES_WITH_CUSTOM_RATIO', 'CAN_USE_REACH_AND_FREQUENCY', 'CUSTOM_CLUSTER_SHARING', 'ADS_INSTREAM_INTERFACE', 'DIRECT_SALES', 'MOBILE_APP_INSTALL_PLACEMENT_INTERFACE'],
      funding_source_details: { id: '1', display_string: 'Visa *4242', type: 1 }, user_tasks: ['DRAFT', 'ANALYZE', 'ADVERTISE', 'MANAGE'],
      end_advertiser: this.business.id, end_advertiser_name: this.business.name, media_agency: 'NONE', partner: 'NONE', fb_entity: 0,
      has_page_authorized_adaccount: true, is_direct_deals_enabled: false, is_notifications_enabled: true, can_create_brand_lift_study: false,
      attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
    };
  }

  businessView(): Json {
    const pages = this.ctx.dataset.pages;
    return { id: this.business.id, name: this.business.name, created_time: this.t(`${addDays(this.ctx.dataset.meta.frozenWindow.since, -60)}T00:00:00+0000`),
      primary_page: pages[0] ? { id: pages[0].id, name: pages[0].name } : undefined, verification_status: 'verified', vertical: 'ADVERTISING', link: undefined };
  }

  page(p: SandboxPage): Json {
    const ig = p.instagram_business_account ?? undefined;
    return { id: p.id, name: p.name, category: p.category, category_list: [{ id: '2211', name: p.category }], tasks: p.tasks, access_token: this.ctx.token,
      instagram_business_account: ig, connected_instagram_account: ig, is_published: true, verification_status: 'not_verified',
      has_transitioned_to_new_page_experience: true, website: this.ctx.dataset.landers[0]?.url };
  }

  campaign(c: SandboxCampaign): Json {
    return {
      id: c.id, account_id: c.account_id, name: c.name, status: c.status, configured_status: c.status, effective_status: this.objects.campaignEffectiveStatus(c),
      objective: c.objective, daily_budget: money(c.daily_budget), lifetime_budget: money(c.lifetime_budget), budget_remaining: money(c.budget_remaining), spend_cap: money(c.spend_cap),
      bid_strategy: c.bid_strategy, start_time: this.t(c.start_time), stop_time: this.t(c.stop_time), special_ad_categories: c.special_ad_categories,
      special_ad_category: c.special_ad_categories[0] ?? 'NONE', created_time: this.t(c.created_time), updated_time: this.t(c.updated_time),
      buying_type: 'AUCTION', can_use_spend_cap: true, is_skadnetwork_attribution: false, smart_promotion_type: 'GUIDED_CREATION', pacing_type: ['standard'],
      adlabels: [], issues_info: [], budget_rebalance_flag: false, is_budget_schedule_enabled: false, primary_attribution: 'DEFAULT',
    };
  }

  adset(a: SandboxAdSet): Json {
    const campaign = this.objects.campaigns.get(a.campaign_id);
    const active = this.objects.adsetEffectiveStatus(a) === 'ACTIVE';
    return {
      id: a.id, account_id: a.account_id, campaign_id: a.campaign_id, name: a.name, status: a.status, configured_status: a.status, effective_status: this.objects.adsetEffectiveStatus(a),
      optimization_goal: a.optimization_goal, billing_event: a.billing_event, destination_type: a.destination_type, promoted_object: a.promoted_object,
      bid_strategy: a.bid_strategy ?? campaign?.bid_strategy, bid_amount: money(a.bid_amount), daily_budget: money(a.daily_budget), lifetime_budget: money(a.lifetime_budget),
      budget_remaining: money(a.daily_budget ?? a.lifetime_budget), start_time: this.t(a.start_time), end_time: this.t(a.end_time), targeting: a.targeting,
      pacing_type: a.pacing_type ?? ['standard'], created_time: this.t(a.start_time), updated_time: this.t(campaign?.updated_time ?? a.start_time),
      attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
      learning_stage_info: active ? { status: 'SUCCESS' } : undefined, is_dynamic_creative: false, optimization_sub_event: 'NONE', adlabels: [], issues_info: [],
    };
  }

  ad(ad: SandboxAd): Json {
    const pixelIds = this.ctx.dataset.pixels.map((p) => p.id);
    return {
      id: ad.id, account_id: ad.account_id, adset_id: ad.adset_id, campaign_id: ad.campaign_id, name: ad.name, status: ad.status, configured_status: ad.status,
      effective_status: this.objects.adEffectiveStatus(ad), creative: { id: ad.creative.id }, ad_review_feedback: ad.ad_review_feedback ?? null,
      created_time: this.t(ad.created_time), updated_time: this.t(ad.updated_time),
      tracking_specs: pixelIds.length ? [{ 'action.type': ['offsite_conversion'], fb_pixel: pixelIds }] : [], conversion_specs: undefined,
      adlabels: [], issues_info: [], engagement_audience: false,
    };
  }

  creative(c: SandboxCreative): Json {
    const spec = c.object_story_spec as { page_id?: string; link_data?: { call_to_action?: { type?: string } } } | undefined;
    return {
      id: c.id, account_id: c.account_id, name: c.name, status: c.status, body: c.body, title: c.title, image_url: c.image_url, thumbnail_url: c.thumbnail_url,
      image_hash: c.image_hash, object_type: c.object_type, link_url: c.link_url, object_url: c.link_url, url_tags: c.url_tags, object_story_id: c.object_story_id,
      effective_object_story_id: c.object_story_id, object_story_spec: c.object_story_spec, asset_feed_spec: c.asset_feed_spec,
      call_to_action_type: spec?.link_data?.call_to_action?.type, actor_id: spec?.page_id ?? this.ctx.dataset.pages[0]?.id, created_time: this.t(c.created_time),
      authorization_category: 'NONE', adlabels: [],
    };
  }

  image(image: SandboxAdImage): Json {
    return { id: `${this.accountId}:${image.hash}`, account_id: this.accountId, hash: image.hash, url: image.url, url_128: image.url, permalink_url: image.url, name: image.name,
      width: image.width, height: image.height, original_width: image.width, original_height: image.height, status: image.status,
      created_time: this.t(`${this.ctx.dataset.meta.frozenWindow.since}T00:00:00+0000`), updated_time: this.t(`${this.ctx.dataset.meta.frozenWindow.since}T00:00:00+0000`) };
  }

  pixel(p: SandboxPixel): Json {
    const totals: Record<string, number> = {};
    for (const day of p.statsByDay) for (const [event, count] of Object.entries(day.events)) totals[event] = (totals[event] ?? 0) + count;
    return {
      id: p.id, name: p.name, last_fired_time: this.t(p.last_fired_time), is_created_by_business: p.is_created_by_business, owner_business: this.business,
      creation_time: this.t(`${addDays(this.ctx.dataset.meta.frozenWindow.since, -30)}T00:00:00+0000`),
      code: `<!-- Meta Pixel Code -->\n<script>\n!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');\nfbq('init', '${p.id}');\nfbq('track', 'PageView');\n</script>\n<!-- End Meta Pixel Code -->`,
      data_use_setting: 'EMPTY', enable_automatic_matching: true, automatic_matching_fields: ['em', 'ph', 'fn', 'ln'], first_party_cookie_status: 'FIRST_PARTY_COOKIE_ENABLED',
      is_unavailable: false, is_crm: false, can_proxy: false, event_stats: Object.entries(totals).map(([event, count]) => ({ event, count: String(count) })),
    };
  }

  audience(a: SandboxCustomAudience): Json {
    return {
      id: a.id, account_id: this.accountId, name: a.name, description: a.description ?? '', subtype: a.subtype, delivery_status: a.delivery_status,
      operation_status: { code: 200, description: 'Normal' }, approximate_count_lower_bound: a.approximate_count_lower_bound,
      approximate_count_upper_bound: a.approximate_count_lower_bound === undefined ? undefined : Math.round(a.approximate_count_lower_bound * 1.2),
      time_created: unixSeconds(shiftIso(a.time_created, this.ctx.shift)), time_updated: unixSeconds(shiftIso(a.time_updated, this.ctx.shift)),
      customer_file_source: a.customer_file_source, lookalike_spec: a.lookalike_spec ?? undefined, retention_days: 30, is_value_based: false,
      data_source: { type: 'UNKNOWN', sub_type: 'ANYTHING', creation_params: '{}' },
      permission_for_actions: { can_edit: true, can_see_insight: true, can_share: true, subtype_supports_lookalike: true, supports_recipient_lookalike: true },
    };
  }
}

// ---------- the read router ----------

type Kind = 'account' | 'campaign' | 'adset' | 'ad' | 'creative' | 'pixel' | 'audience' | 'page' | 'business' | 'report';

export function handleGraphRead(ctx: GraphReadContext, req: SimRequest): SimResponse | null {
  try {
    if (req.path === 'oauth/access_token' && (req.method === 'GET' || req.method === 'POST')) {
      return ok({ access_token: req.form?.fb_exchange_token ?? req.query.fb_exchange_token ?? ctx.token, token_type: 'bearer', expires_in: 5_184_000 });
    }
    if (req.method !== 'GET') return null;
    const reader = new Reader(ctx, req);
    return reader.route();
  } catch (error) {
    if (error instanceof GraphError) return error.toResponse();
    throw error;
  }
}

class Reader {
  private views: Views;
  private fields: FieldNode[] | undefined;
  private q: Record<string, string>;
  constructor(private ctx: GraphReadContext, private req: SimRequest) {
    this.views = new Views(ctx);
    this.q = req.query;
    this.fields = this.q.fields ? parseFields(this.q.fields) : undefined;
  }

  private get objects() { return this.views.objects; }
  private get dataset() { return this.ctx.dataset; }

  route(): SimResponse | null {
    const [head, edge, ...rest] = this.req.path.split('/');
    if (rest.length) return null;
    if (head === 'me') return this.me(edge);
    if (head === 'debug_token') return edge ? null : this.debugToken();
    if (head === 'search') return edge ? null : ok(envelope(this.search(this.q)));
    if (head.startsWith('act_')) {
      if (head !== this.dataset.account.id) throw graphErrors.unsupportedGet(head);
      return this.account(edge);
    }
    if (!/^\d+$/.test(head)) throw graphErrors.unsupportedGet(head);
    const node = this.resolve(head);
    if (!node) throw graphErrors.unsupportedGet(head);
    switch (node.kind) {
      case 'campaign': return this.campaign(node.obj as SandboxCampaign, edge);
      case 'adset': return this.adset(node.obj as SandboxAdSet, edge);
      case 'ad': return this.ad(node.obj as SandboxAd, edge);
      case 'creative': return edge ? null : ok(project(this.views.creative(node.obj as SandboxCreative), this.fields));
      case 'pixel': return this.pixel(node.obj as SandboxPixel, edge);
      case 'audience': return edge ? null : ok(project(this.views.audience(node.obj as SandboxCustomAudience), this.fields));
      case 'page': return this.page(node.obj as SandboxPage, edge);
      case 'business': return this.business(edge);
      case 'report': return this.report(head, edge);
      default: return null;
    }
  }

  private resolve(id: string): { kind: Kind; obj: unknown } | null {
    const { campaigns, adsets, ads, creatives } = this.objects;
    if (campaigns.has(id)) return { kind: 'campaign', obj: campaigns.get(id) };
    if (adsets.has(id)) return { kind: 'adset', obj: adsets.get(id) };
    if (ads.has(id)) return { kind: 'ad', obj: ads.get(id) };
    if (creatives.has(id)) return { kind: 'creative', obj: creatives.get(id) };
    const pixel = this.dataset.pixels.find((p) => p.id === id); if (pixel) return { kind: 'pixel', obj: pixel };
    const audience = this.dataset.customAudiences.find((a) => a.id === id); if (audience) return { kind: 'audience', obj: audience };
    const page = this.dataset.pages.find((p) => p.id === id); if (page) return { kind: 'page', obj: page };
    if (id === this.views.business.id) return { kind: 'business', obj: null };
    if (hasInsightsReport(id, this.ctx.now)) return { kind: 'report', obj: null };
    return null;
  }

  // ----- pagination over object lists (offset cursors, paging.next carries the token like Meta) -----
  private list<T>(items: T[], view: (item: T) => Json, resolvers?: (item: T) => Record<string, Resolver>, defaults: string[] = ['id']): SimResponse {
    const limit = this.q.limit ? Number(this.q.limit) : 25;
    if (!Number.isInteger(limit) || limit < 1) throw graphErrors.invalidParam('limit must be a positive integer');
    const offset = this.q.after ? Number(Buffer.from(this.q.after, 'base64').toString('utf8')) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw graphErrors.invalidParam('The cursor is invalid');
    const page = items.slice(offset, offset + limit);
    const hasMore = offset + limit < items.length;
    const paging: { cursors: { before: string; after: string }; next?: string } = {
      cursors: { before: offset === 0 ? FIRST_PAGE_CURSORS.before : Buffer.from(String(offset)).toString('base64'), after: hasMore ? Buffer.from(String(offset + limit)).toString('base64') : FIRST_PAGE_CURSORS.after },
    };
    if (hasMore) paging.next = this.nextUrl(paging.cursors.after);
    return ok(envelope(page.map((item) => project(view(item), this.fields, resolvers?.(item), defaults)), paging));
  }

  private nextUrl(after: string): string {
    const params = new URLSearchParams({ ...this.q, after });
    return `https://graph.facebook.com/${this.req.version}/${this.req.path}?${params.toString()}`;
  }

  private effectiveStatusFilter(): Set<string> | null {
    const raw = parseJsonParam(this.q.effective_status, 'effective_status');
    if (raw === undefined) return null;
    if (!Array.isArray(raw)) throw graphErrors.invalidParam('effective_status must be a JSON array');
    return new Set(raw.map(String));
  }

  /** Meta's edge `filtering` param: the same grammar as insights, applied to object attributes. */
  private edgeFilters(): Array<{ field: string; operator: string; value: unknown }> {
    const raw = parseJsonParam(this.q.filtering, 'filtering');
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw graphErrors.invalidParam('filtering must be a JSON array');
    return raw.map((f: any) => ({ field: String(f.field), operator: String(f.operator ?? 'EQUAL'), value: f.value }));
  }

  private matchesEdgeFilters(view: Json, extra: Record<string, unknown>): boolean {
    for (const filter of this.edgeFilters()) {
      const actual = filter.field in extra ? extra[filter.field] : view[filter.field.replace(/^(campaign|adset|ad)\./, '')];
      const value = actual === undefined || actual === null ? '' : String(actual);
      const list = (Array.isArray(filter.value) ? filter.value : [filter.value]).map(String);
      const okMatch = (() => {
        switch (filter.operator) {
          case 'EQUAL': return value === list[0];
          case 'NOT_EQUAL': return value !== list[0];
          case 'IN': case 'ANY': return list.includes(value);
          case 'NOT_IN': case 'NONE': return !list.includes(value);
          case 'CONTAIN': return value.toLowerCase().includes(list[0].toLowerCase());
          case 'NOT_CONTAIN': return !value.toLowerCase().includes(list[0].toLowerCase());
          case 'STARTS_WITH': return value.toLowerCase().startsWith(list[0].toLowerCase());
          // Numeric coercion, matching operatorMatches (insightsEngine.ts) — value and
          // list[0] are both strings here, so an uncoerced comparison is lexicographic
          // and a filter like `daily_budget GREATER_THAN 900` would match "1000" as less
          // than "900".
          case 'GREATER_THAN': return Number(value) > Number(list[0]);
          case 'LESS_THAN': return Number(value) < Number(list[0]);
          default: throw graphErrors.invalidParam(`Filter operator ${filter.operator} is invalid`);
        }
      })();
      if (!okMatch) return false;
    }
    return true;
  }

  private campaigns(): SandboxCampaign[] {
    const statuses = this.effectiveStatusFilter();
    return [...this.objects.campaigns.values()]
      .filter((c) => !statuses || statuses.has(this.objects.campaignEffectiveStatus(c)))
      .filter((c) => this.matchesEdgeFilters(this.views.campaign(c), { 'campaign.id': c.id, 'campaign.name': c.name, 'campaign.effective_status': this.objects.campaignEffectiveStatus(c) }));
  }
  private adsets(campaignId?: string): SandboxAdSet[] {
    const statuses = this.effectiveStatusFilter();
    return [...this.objects.adsets.values()]
      .filter((a) => !campaignId || a.campaign_id === campaignId)
      .filter((a) => !statuses || statuses.has(this.objects.adsetEffectiveStatus(a)))
      .filter((a) => this.matchesEdgeFilters(this.views.adset(a), { 'campaign.id': a.campaign_id, 'adset.id': a.id, 'adset.name': a.name, 'adset.effective_status': this.objects.adsetEffectiveStatus(a), 'campaign.name': this.objects.campaigns.get(a.campaign_id)?.name }));
  }
  private ads(scope: { campaignId?: string; adsetId?: string } = {}): SandboxAd[] {
    const statuses = this.effectiveStatusFilter();
    return [...this.objects.ads.values()]
      .filter((ad) => (!scope.campaignId || ad.campaign_id === scope.campaignId) && (!scope.adsetId || ad.adset_id === scope.adsetId))
      .filter((ad) => !statuses || statuses.has(this.objects.adEffectiveStatus(ad)))
      .filter((ad) => this.matchesEdgeFilters(this.views.ad(ad), {
        'campaign.id': ad.campaign_id, 'adset.id': ad.adset_id, 'ad.id': ad.id, 'ad.name': ad.name, 'ad.effective_status': this.objects.adEffectiveStatus(ad),
        'campaign.name': this.objects.campaigns.get(ad.campaign_id)?.name, 'adset.name': this.objects.adsets.get(ad.adset_id)?.name,
      }));
  }

  // ----- nested resolvers shared by node and edge reads -----
  private campaignResolvers(c: SandboxCampaign): Record<string, Resolver> {
    return {
      insights: (node) => this.nestedInsights({ kind: 'campaign', id: c.id }, node),
      adsets: (node) => envelope(this.adsets(c.id).map((a) => project(this.views.adset(a), node.children, this.adsetResolvers(a)))),
      ads: (node) => envelope(this.ads({ campaignId: c.id }).map((ad) => project(this.views.ad(ad), node.children, this.adResolvers(ad)))),
    };
  }
  private adsetResolvers(a: SandboxAdSet): Record<string, Resolver> {
    const campaign = this.objects.campaigns.get(a.campaign_id);
    return {
      insights: (node) => this.nestedInsights({ kind: 'adset', id: a.id }, node),
      campaign: (node) => (campaign ? project(this.views.campaign(campaign), node.children) : undefined),
      ads: (node) => envelope(this.ads({ adsetId: a.id }).map((ad) => project(this.views.ad(ad), node.children, this.adResolvers(ad)))),
      adcreatives: (node) => envelope(this.adsetCreatives(a).map((c) => project(this.views.creative(c), node.children))),
    };
  }
  private adResolvers(ad: SandboxAd): Record<string, Resolver> {
    const campaign = this.objects.campaigns.get(ad.campaign_id);
    const adset = this.objects.adsets.get(ad.adset_id);
    const creative = this.objects.creatives.get(ad.creative.id);
    return {
      insights: (node) => this.nestedInsights({ kind: 'ad', id: ad.id }, node),
      creative: (node) => (creative ? project(this.views.creative(creative), node.children, {}, ['id']) : { id: ad.creative.id }),
      campaign: (node) => (campaign ? project(this.views.campaign(campaign), node.children) : undefined),
      adset: (node) => (adset ? project(this.views.adset(adset), node.children) : undefined),
      adcreatives: (node) => envelope(creative ? [project(this.views.creative(creative), node.children)] : []),
      leads: () => envelope([]),
    };
  }
  private adsetCreatives(a: SandboxAdSet): SandboxCreative[] {
    const seen = new Set<string>();
    const out: SandboxCreative[] = [];
    for (const ad of this.ads({ adsetId: a.id })) {
      const creative = this.objects.creatives.get(ad.creative.id);
      if (creative && !seen.has(creative.id)) { seen.add(creative.id); out.push(creative); }
    }
    return out;
  }

  private nestedInsights(node: InsightsNode, field: FieldNode): unknown {
    const args = field.args ?? {};
    const raw: Record<string, unknown> = { ...args, fields: field.children?.map((c) => c.name).join(',') ?? '' };
    if (raw.time_ranges === undefined && raw.time_range === undefined && raw.date_preset === undefined && this.q.date_preset) raw.date_preset = this.q.date_preset;
    const params = parseInsightsParams(raw, node);
    return runInsights(this.dataset, this.ctx.overlay, params, this.ctx.shift, this.ctx.now);
  }

  private insights(node: InsightsNode): SimResponse {
    const params = parseInsightsParams(this.q, node);
    params.nextUrl = (after) => this.nextUrl(after);
    return ok(runInsights(this.dataset, this.ctx.overlay, params, this.ctx.shift, this.ctx.now));
  }

  // ----- identity -----
  private me(edge: string | undefined): SimResponse | null {
    switch (edge) {
      case undefined: return ok(project(this.views.user(), this.fields));
      case 'adaccounts': return this.list([this.dataset.account], () => this.views.account(), undefined, ['id', 'account_id']);
      case 'accounts': return this.list(this.dataset.pages, (p) => this.views.page(p), undefined, ['id', 'name', 'access_token', 'category', 'tasks']);
      case 'businesses': return this.list([null], () => this.views.businessView(), undefined, ['id', 'name']);
      case 'permissions': return ok(envelope(['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads', 'pages_manage_metadata', 'instagram_basic', 'leads_retrieval', 'read_insights', 'public_profile', 'email'].map((permission) => ({ permission, status: 'granted' }))));
      default: return null;
    }
  }

  private debugToken(): SimResponse {
    const nowSeconds = Math.floor(this.ctx.now.getTime() / 1000);
    const scopes = ['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads', 'instagram_basic', 'leads_retrieval', 'read_insights', 'public_profile', 'email'];
    return ok({ data: {
      app_id: '1207000000000000', type: 'USER', application: 'AgentWeb', data_access_expires_at: nowSeconds + 90 * 86_400, expires_at: nowSeconds + 60 * 86_400,
      is_valid: true, issued_at: nowSeconds - 86_400, scopes, user_id: this.views.userId,
      granular_scopes: [
        { scope: 'ads_management', target_ids: [this.views.accountId] }, { scope: 'ads_read', target_ids: [this.views.accountId] },
        { scope: 'business_management', target_ids: [this.views.business.id] }, { scope: 'pages_show_list', target_ids: this.dataset.pages.map((p) => p.id) },
        { scope: 'pages_read_engagement', target_ids: this.dataset.pages.map((p) => p.id) }, { scope: 'pages_manage_ads', target_ids: this.dataset.pages.map((p) => p.id) },
      ],
    } });
  }

  // ----- account node + edges -----
  private account(edge: string | undefined): SimResponse | null {
    const account = this.dataset.account;
    switch (edge) {
      case undefined: return ok(project(this.views.account(), this.fields, {}, ['id', 'account_id']));
      case 'campaigns': return this.list(this.campaigns(), (c) => this.views.campaign(c), (c) => this.campaignResolvers(c));
      case 'adsets': return this.list(this.adsets(), (a) => this.views.adset(a), (a) => this.adsetResolvers(a));
      case 'ads': return this.list(this.ads(), (ad) => this.views.ad(ad), (ad) => this.adResolvers(ad));
      case 'adcreatives': return this.list([...this.objects.creatives.values()], (c) => this.views.creative(c));
      case 'adimages': {
        const hashes = parseJsonParam(this.q.hashes, 'hashes');
        const wanted = Array.isArray(hashes) ? new Set(hashes.map(String)) : null;
        return this.list([...this.objects.images.values()].filter((i) => !wanted || wanted.has(i.hash)), (i) => this.views.image(i), undefined, ['id', 'hash', 'url']);
      }
      case 'advideos': case 'saved_audiences': case 'customconversions': case 'adrules_library': case 'activities': case 'agencies': return ok(envelope([]));
      case 'adspixels': return this.list(this.dataset.pixels, (p) => this.views.pixel(p), undefined, ['id', 'name']);
      case 'customaudiences': return this.list(this.dataset.customAudiences, (a) => this.views.audience(a), undefined, ['id', 'name']);
      case 'insights': return this.insights({ kind: 'account', id: account.account_id });
      case 'targetingsearch': case 'targetingbrowse': return ok(envelope(this.search({ ...this.q, type: this.q.type ?? 'adinterest' })));
      case 'promote_pages': return this.list(this.dataset.pages, (p) => this.views.page(p), undefined, ['id', 'name']);
      case 'instagram_accounts': case 'connected_instagram_accounts':
        return ok(envelope(this.dataset.pages.flatMap((p) => (p.instagram_business_account ? [{ id: p.instagram_business_account.id, username: p.name.toLowerCase().replace(/[^a-z0-9]/g, '') }] : []))));
      case 'assigned_users': case 'users': return ok(envelope([{ id: this.views.userId, name: account.name, tasks: ['DRAFT', 'ANALYZE', 'ADVERTISE', 'MANAGE'] }]));
      case 'ads_volume': return ok(envelope([{ ads_running_or_in_review_count: this.ads().filter((ad) => this.objects.adEffectiveStatus(ad) === 'ACTIVE').length, ads_limit: 250, current_account_ads_running_or_in_review_count: this.ads().length }]));
      case 'minimum_budgets': return ok(envelope([{ bid_amount: 100, currency: account.currency, min_daily_budget_imp: 100, min_daily_budget_high_freq: 500, min_daily_budget_low_freq: 500, min_daily_budget_video_views: 500 }]));
      case 'reachestimate': return ok({ data: { users_lower_bound: 2_100_000, users_upper_bound: 2_500_000, estimate_ready: true } });
      case 'delivery_estimate': return ok(envelope([this.deliveryEstimate()]));
      default: return null;
    }
  }

  private deliveryEstimate(): Json {
    return { estimate_ready: true, estimate_dau: 640_000, estimate_mau_lower_bound: 2_100_000, estimate_mau_upper_bound: 2_500_000,
      daily_outcomes_curve: [{ spend: 0, reach: 0, impressions: 0, actions: 0 }, { spend: 25, reach: 1900, impressions: 2400, actions: 2 }, { spend: 50, reach: 3600, impressions: 4700, actions: 4 }, { spend: 100, reach: 6800, impressions: 9100, actions: 8 }] };
  }

  private campaign(c: SandboxCampaign, edge: string | undefined): SimResponse | null {
    switch (edge) {
      case undefined: return ok(project(this.views.campaign(c), this.fields, this.campaignResolvers(c)));
      case 'adsets': return this.list(this.adsets(c.id), (a) => this.views.adset(a), (a) => this.adsetResolvers(a));
      case 'ads': return this.list(this.ads({ campaignId: c.id }), (ad) => this.views.ad(ad), (ad) => this.adResolvers(ad));
      case 'insights': return this.insights({ kind: 'campaign', id: c.id });
      default: return null;
    }
  }

  private adset(a: SandboxAdSet, edge: string | undefined): SimResponse | null {
    switch (edge) {
      case undefined: return ok(project(this.views.adset(a), this.fields, this.adsetResolvers(a)));
      case 'ads': return this.list(this.ads({ adsetId: a.id }), (ad) => this.views.ad(ad), (ad) => this.adResolvers(ad));
      case 'adcreatives': return this.list(this.adsetCreatives(a), (c) => this.views.creative(c));
      case 'insights': return this.insights({ kind: 'adset', id: a.id });
      case 'delivery_estimate': return ok(envelope([this.deliveryEstimate()]));
      default: return null;
    }
  }

  private ad(ad: SandboxAd, edge: string | undefined): SimResponse | null {
    switch (edge) {
      case undefined: return ok(project(this.views.ad(ad), this.fields, this.adResolvers(ad)));
      case 'adcreatives': { const c = this.objects.creatives.get(ad.creative.id); return this.list(c ? [c] : [], (x) => this.views.creative(x)); }
      case 'insights': return this.insights({ kind: 'ad', id: ad.id });
      case 'leads': return ok(envelope([]));
      default: return null;
    }
  }

  private page(p: SandboxPage, edge: string | undefined): SimResponse | null {
    switch (edge) {
      case undefined: return ok(project(this.views.page(p), this.fields));
      case 'leadgen_forms': return ok(envelope([]));
      default: return null;
    }
  }

  private business(edge: string | undefined): SimResponse | null {
    switch (edge) {
      case undefined: return ok(project(this.views.businessView(), this.fields));
      case 'owned_pages': return this.list(this.dataset.pages, (p) => this.views.page(p), undefined, ['id', 'name']);
      case 'owned_ad_accounts': return this.list([this.dataset.account], () => this.views.account(), undefined, ['id', 'account_id']);
      case 'owned_pixels': case 'adspixels': return this.list(this.dataset.pixels, (p) => this.views.pixel(p), undefined, ['id', 'name']);
      case 'owned_instagram_accounts': case 'instagram_accounts':
        return ok(envelope(this.dataset.pages.flatMap((p) => (p.instagram_business_account ? [{ id: p.instagram_business_account.id }] : []))));
      case 'client_pages': case 'client_ad_accounts': case 'client_pixels': case 'business_users': return ok(envelope([]));
      default: return null;
    }
  }

  // ----- pixels -----
  private pixel(p: SandboxPixel, edge: string | undefined): SimResponse | null {
    switch (edge) {
      case undefined: return ok(project(this.views.pixel(p), this.fields));
      case 'stats': return ok(this.pixelStats(p));
      case 'da_checks': return ok(envelope([]));
      default: return null;
    }
  }

  private pixelStats(p: SandboxPixel): unknown {
    const toDay = (raw: string | undefined, fallback: string): string => {
      if (!raw) return fallback;
      const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw);
      if (Number.isNaN(ms)) throw graphErrors.invalidParam('start_time/end_time must be a unix timestamp or ISO 8601 date');
      return dayOf(new Date(ms));
    };
    const frozen = this.dataset.meta.frozenWindow;
    const current: DayRange = { since: toDay(this.q.start_time, shiftDay(frozen.since, this.ctx.shift)), until: toDay(this.q.end_time, shiftDay(frozen.until, this.ctx.shift)) };
    const range = unshiftRange(current, this.ctx.shift);
    const totals: Record<string, number> = {};
    for (const day of p.statsByDay) {
      if (day.date < range.since || day.date > range.until) continue;
      for (const [event, count] of Object.entries(day.events)) totals[event] = (totals[event] ?? 0) + count;
    }
    for (const capi of this.ctx.overlay.capiEvents) {
      if (capi.pixelId !== p.id) continue;
      const day = unshiftRange({ since: dayOf(new Date(capi.receivedAt)), until: dayOf(new Date(capi.receivedAt)) }, this.ctx.shift).since;
      if (day >= range.since && day <= range.until) totals.Lead = (totals.Lead ?? 0) + capi.count;
    }
    const all = Object.values(totals).reduce((a, b) => a + b, 0);
    const leads = totals.Lead ?? 0;
    const pageViews = totals.PageView ?? 0;
    const landers = this.dataset.landers.filter((l) => l.pixelIds.includes(p.id));
    let rows: Array<{ value: string; count: number }>;
    switch (this.q.aggregation ?? 'pixel_fire') {
      case 'event': rows = Object.entries(totals).map(([value, count]) => ({ value, count })); break;
      case 'match_keys': rows = [
        { value: 'em', count: leads }, { value: 'ph', count: Math.round(leads * 0.6) }, { value: 'fn', count: leads }, { value: 'ln', count: leads },
        { value: 'ct', count: Math.round(leads * 0.4) }, { value: 'st', count: Math.round(leads * 0.4) }, { value: 'zp', count: Math.round(leads * 0.3) }, { value: 'country', count: Math.round(leads * 0.7) },
        { value: 'client_ip_address', count: all }, { value: 'client_user_agent', count: all }, { value: 'fbp', count: Math.round(all * 0.9) }, { value: 'fbc', count: Math.round(all * 0.4) },
      ].filter((r) => r.count > 0); break;
      case 'url': rows = landers.length ? landers.map((l, i) => ({ value: l.url, count: i === 0 ? pageViews - Math.floor(pageViews / landers.length) * (landers.length - 1) : Math.floor(pageViews / landers.length) })) : []; break;
      case 'host': rows = [...new Set(landers.map((l) => new URL(l.url).host))].map((value) => ({ value, count: pageViews })); break;
      case 'device_type': rows = [{ value: 'mobile', count: Math.round(all * 0.68) }, { value: 'desktop', count: all - Math.round(all * 0.68) }]; break;
      case 'pixel_fire': rows = [{ value: 'pixel_fire', count: all }]; break;
      default: throw graphErrors.invalidParam(`aggregation must be one of: event, match_keys, url, host, device_type, pixel_fire`);
    }
    return envelope([{ start_time: shiftIso(`${range.since}T00:00:00+0000`, this.ctx.shift), data: rows }]);
  }

  // ----- targeting search (deterministic, from the dataset's catalog) -----
  private search(q: Record<string, string>): unknown[] {
    const catalog = this.dataset.targetingCatalog ?? { interests: [], geo: [] };
    const needle = (q.q ?? '').toLowerCase();
    const limit = q.limit ? Number(q.limit) : 25;
    const byName = (items: Array<Record<string, unknown>>) => items.filter((i) => !needle || String(i.name ?? '').toLowerCase().includes(needle)).slice(0, limit);
    switch (q.type) {
      case 'adinterest': case 'adinterestsuggestion': case 'adTargetingCategory':
        if (q.type === 'adTargetingCategory' && q.class && q.class !== 'interests') return [];
        return byName(catalog.interests).map((i) => ({ id: i.id, name: i.name, audience_size_lower_bound: i.audience_size_lower_bound ?? 1_000_000, audience_size_upper_bound: i.audience_size_upper_bound ?? Math.round(Number(i.audience_size_lower_bound ?? 1_000_000) * 1.2), path: i.path ?? ['Interests', i.name], description: i.description ?? null, topic: i.topic ?? 'Business and industry' }));
      case 'adinterestvalid': {
        const list = parseJsonParam(q.interest_list, 'interest_list');
        return (Array.isArray(list) ? list : []).map((name) => { const hit = catalog.interests.find((i) => String(i.name).toLowerCase() === String(name).toLowerCase()); return { name, valid: !!hit, id: hit?.id, audience_size_lower_bound: hit?.audience_size_lower_bound }; });
      }
      case 'adgeolocation': {
        const types = parseJsonParam(q.location_types, 'location_types');
        const wanted = Array.isArray(types) ? new Set(types.map(String)) : null;
        return byName(catalog.geo.filter((g) => !wanted || wanted.has(String(g.type))));
      }
      case 'adgeolocationmeta': return [];
      case 'adlocale': case 'adworkemployer': case 'adworkposition': case 'adeducationschool': case 'adeducationmajor': return [];
      default: return [];
    }
  }

  // ----- async insights report reads -----
  private report(id: string, edge: string | undefined): SimResponse | null {
    switch (edge) {
      case undefined: return ok(getInsightsReportStatus(id, this.ctx.now));
      case 'insights': {
        const limit = this.q.limit ? Number(this.q.limit) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw graphErrors.invalidParam('limit must be a positive integer');
        return ok(getInsightsReportRows(id, this.ctx.now, { limit, after: this.q.after, nextUrl: (after) => this.nextUrl(after) }));
      }
      default: return null;
    }
  }
}

export type { InsightsLevel };
export { compareIds };
